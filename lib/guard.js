/**
 * Loop-guard decisions, kept free of cordis imports so every branch is
 * unit-testable without a running harness.
 *
 * Three failure modes share one shape: each ends the *thing that is looping*
 * rather than the session. Output repetition and the runaway brake end the
 * current model attempt with a terminal error, which the agent loop turns into
 * a retryable step failure; the tool-call guard injects a model-visible notice
 * and, past the hard threshold, cancels the turn.
 *
 * @module dsh-loop-guard/guard
 */

import { DETECTOR_DEFAULTS, createRepetitionDetector } from './detector.js'
import { createMessages, describeHit } from './messages.js'

/** Failure code carried by a stream this guard cut short for repetition. */
export const REPETITION_CODE = 'LOOP_GUARD_REPETITION'
/** Failure code carried by a stream this guard refused or cut for budget. */
export const BUDGET_CODE = 'LOOP_GUARD_BUDGET'

/** Argument fields that identify what a tool call acts on, most specific first. */
const TARGET_FIELDS = [
  'path',
  'file_path',
  'filePath',
  'pattern',
  'query',
  'url',
  'command',
  'script',
  'job_id',
  'jobId',
  'session',
  'sessionId',
  'id',
  'name',
  'target',
]

/**
 * Default configuration. Values are conservative where a mistake is expensive:
 * a false repetition hit discards a model response, so the detector needs most
 * of its window to be the same text, and the tool guard only *cancels* a turn
 * far past any plausible polling pattern.
 */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  dryRun: false,
  logEvents: true,
  locale: 'en',
  repetition: Object.freeze({
    enabled: true,
    includeReasoning: true,
    maxRetries: 1,
    ...DETECTOR_DEFAULTS,
  }),
  toolLoop: Object.freeze({
    enabled: true,
    fuzzyAdvisoryAt: 5,
    hardStopAt: 12,
    cycleAdvisoryAt: 3,
    exclude: Object.freeze(['todo_write', 'job_output']),
    argumentsPreviewChars: 240,
  }),
  brake: Object.freeze({
    enabled: true,
    maxStepsPerTurn: 60,
    maxTurnMinutes: 30,
    maxCallsPerHour: 240,
    maxOutputCharsPerTurn: 200000,
  }),
})

/**
 * Whether one request is an agent-loop conversation request this guard owns.
 * Auxiliary calls (`session-title`, `compaction`) carry a purpose and one-shot
 * callers carry no session identity; neither should be cut short.
 * @param options - assembled model request.
 * @returns whether the guard inspects and may terminate this request.
 */
export function isGuardedRequest(options) {
  if (options === null || typeof options !== 'object') return false
  if (options.purpose !== undefined) return false
  return typeof options.sessionId === 'string' && options.sessionId.length > 0
}

/** Deep key-sort so two argument objects differing only in property order canonicalize identically. */
export function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (value !== null && typeof value === 'object') {
    const sorted = {}
    for (const key of Object.keys(value).sort()) sorted[key] = sortJsonValue(value[key])
    return sorted
  }
  return value
}

/** Canonical string form of a call's arguments: deep key-sort, then stringify. */
export function canonicalize(argumentsValue) {
  try {
    return JSON.stringify(sortJsonValue(argumentsValue)) ?? 'null'
  } catch {
    return String(argumentsValue)
  }
}

/** Collapse whitespace and truncate one argument value into a stable comparison token. */
function normalizeToken(value) {
  const text = typeof value === 'string' ? value : canonicalize(value)
  return text.replace(/\s+/g, ' ').trim().slice(0, 200)
}

/**
 * Identify what a call acts on, ignoring arguments that merely tune the same
 * action (a read offset, a grep context width). Two calls that differ only in
 * those fields are the near-duplicates the built-in exact-match guard cannot
 * see.
 * @param toolName - tool name.
 * @param args - parsed call arguments.
 * @returns the fuzzy chain key for this call.
 */
export function targetToken(toolName, args) {
  if (args !== null && typeof args === 'object' && !Array.isArray(args)) {
    const parts = []
    for (const field of TARGET_FIELDS) {
      if (!Object.hasOwn(args, field)) continue
      const value = args[field]
      if (value === undefined || value === null) continue
      parts.push(`${field}=${normalizeToken(value)}`)
    }
    if (parts.length > 0) return parts.join('&').slice(0, 400)
  }
  return canonicalize(args).slice(0, 400)
}

/** Compile one `*`-wildcard pattern to an anchored RegExp; every other metacharacter matches literally. */
export function wildcardToRegExp(pattern) {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`)
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`)
}

/** Terminal error chunk the stream protocol accepts in place of an adapter finish. */
function terminalError(code, message) {
  return { type: 'finish', reason: { kind: 'error', failure: { code, message } } }
}

/** A stream that carries only the guard's terminal failure, used to veto a call before dispatch. */
async function* refusalStream(code, message) {
  yield terminalError(code, message)
}

/**
 * Count the characters one chunk contributes to the per-turn output budget.
 *
 * Only text the model writes counts. Tool-call arguments are deliberately
 * excluded: they are the payload of real work (a file being written, a script
 * being run), so counting them would stop a large refactor rather than a
 * runaway, which is exactly the wrong failure to buy.
 */
function chunkWeight(chunk) {
  return typeof chunk.text === 'string' ? chunk.text.length : 0
}

/**
 * Build the guard.
 * @param config - resolved configuration (see {@link DEFAULT_CONFIG}).
 * @param hooks - host integration points.
 * @param hooks.now - clock, injectable for tests.
 * @param hooks.emit - observability sink for every guard decision.
 * @param hooks.makeNotice - builds a model-visible notice from `(text, summary)`.
 * @param hooks.readOverrides - returns the live override document, or `null`; read once per decision.
 * @returns listeners plus a diagnostics snapshot.
 */
export function createGuard(config = DEFAULT_CONFIG, hooks = {}) {
  const now = hooks.now ?? (() => Date.now())
  const emit = hooks.emit ?? (() => {})
  const makeNotice = hooks.makeNotice ?? ((text, summary) => ({ content: [{ type: 'text', text }], source: { kind: 'loop-guard', form: 'notice', summary } }))
  const readOverrides = hooks.readOverrides ?? (() => null)

  /** Loader configuration: the baseline every decision starts from. */
  const base = {
    enabled: config.enabled !== false,
    dryRun: config.dryRun === true,
    locale: typeof config.locale === 'string' && config.locale.length > 0 ? config.locale : DEFAULT_CONFIG.locale,
    repetition: { ...DEFAULT_CONFIG.repetition, ...config.repetition },
    toolLoop: { ...DEFAULT_CONFIG.toolLoop, ...config.toolLoop },
    brake: { ...DEFAULT_CONFIG.brake, ...config.brake },
  }

  /**
   * Effective settings for one decision: the loader configuration with the live
   * override document merged over it. The override is read once per listener
   * invocation — never per streamed chunk — so a change applies to the next
   * model call without a restart.
   * @returns the merged settings document.
   */
  function settings() {
    const override = readOverrides()
    if (override === null || override === undefined || typeof override !== 'object') return base
    return {
      enabled: override.enabled ?? base.enabled,
      dryRun: override.dryRun ?? base.dryRun,
      locale: override.locale ?? base.locale,
      repetition: { ...base.repetition, ...(override.repetition ?? {}) },
      toolLoop: { ...base.toolLoop, ...(override.toolLoop ?? {}) },
      brake: { ...base.brake, ...(override.brake ?? {}) },
    }
  }

  /** Per-session turn bookkeeping, keyed by session id. */
  const turns = new Map()
  /** Per-agent retry bookkeeping for cut model attempts. */
  const retries = new WeakMap()
  /** Per-agent consecutive-call chains. */
  const chains = new WeakMap()
  /** Process-wide hourly model-call counter. */
  const hourly = { windowStart: 0, calls: 0 }
  const stats = { repetitionHits: 0, repetitionRetries: 0, repetitionStops: 0, budgetStops: 0, toolAdvisories: 0, toolStops: 0 }

  /** Whether one tool call participates in the loop chains under the current settings. */
  function tracked(toolName, toolLoop) {
    return !(toolLoop.exclude ?? []).some((pattern) => wildcardToRegExp(pattern).test(toolName))
  }

  /** Current turn record for one session, reset whenever the turn number moves. */
  function turnState(sessionId, turn) {
    let state = turns.get(sessionId)
    if (state === undefined) {
      state = { turn: turn ?? 1, startedAt: now(), outputChars: 0, calls: 0 }
      turns.set(sessionId, state)
      return state
    }
    if (turn !== undefined && turn !== state.turn) {
      state.turn = turn
      state.startedAt = now()
      state.outputChars = 0
      state.calls = 0
    }
    return state
  }

  /** Roll the hourly counter when the wall-clock hour moves. */
  function hourlyCalls(at) {
    if (at - hourly.windowStart >= 3600_000) {
      hourly.windowStart = at
      hourly.calls = 0
    }
    return hourly.calls
  }

  /** The refusal a call would hit before dispatch, or `null` when it may proceed. */
  function admit(sessionId, turn, brake, messages) {
    if (!brake.enabled) return null
    const at = now()
    const state = turnState(sessionId, turn)
    let refusal = null
    if (brake.maxCallsPerHour > 0 && hourlyCalls(at) >= brake.maxCallsPerHour) {
      refusal = { code: BUDGET_CODE, message: messages.budgetCalls(brake.maxCallsPerHour) }
    } else if (brake.maxStepsPerTurn > 0 && state.calls >= brake.maxStepsPerTurn) {
      refusal = { code: BUDGET_CODE, message: messages.budgetSteps(brake.maxStepsPerTurn) }
    } else if (brake.maxTurnMinutes > 0 && at - state.startedAt >= brake.maxTurnMinutes * 60_000) {
      refusal = { code: BUDGET_CODE, message: messages.budgetMinutes(brake.maxTurnMinutes) }
    }
    state.calls += 1
    hourly.calls += 1
    hourlyCalls(at)
    return refusal
  }

  /** Charge one streamed chunk against the per-turn output budget (model-written text only). */
  function chargeOutput(sessionId, chars, brake, messages) {
    if (!brake.enabled || brake.maxOutputCharsPerTurn <= 0) return null
    const state = turnState(sessionId)
    state.outputChars += chars
    if (state.outputChars <= brake.maxOutputCharsPerTurn) return null
    return { code: BUDGET_CODE, message: messages.budgetOutput(brake.maxOutputCharsPerTurn) }
  }

  /** Whether an attempt cut for repetition may be re-run. */
  function mayRetry(agent, turn, step, repetition) {
    const record = retries.get(agent)
    const attempts = record !== undefined && record.turn === turn && record.step === step ? record.attempts : 0
    if (attempts >= repetition.maxRetries) return false
    retries.set(agent, { turn, step, attempts: attempts + 1 })
    return attempts + 1
  }

  /**
   * Wrap one guarded model stream, terminating it as soon as its own output is
   * repeating or has outrun the per-turn output budget.
   * @param options - assembled request (already known to be guarded).
   * @param next - downstream chain producing the chunk stream.
   * @returns the chunk stream the loop consumes.
   */
  function streamListener(options, next) {
    const cfg = settings()
    if (!cfg.enabled || !isGuardedRequest(options)) return next()
    const { brake, repetition, dryRun } = cfg
    const messages = createMessages(cfg.locale)
    const sessionId = String(options.sessionId)
    const refusal = admit(sessionId, turns.get(sessionId)?.turn, brake, messages)
    if (refusal !== null) {
      stats.budgetStops += 1
      emit({ kind: 'budget-refused', sessionId, code: refusal.code, message: refusal.message, dryRun })
      if (!dryRun) return refusalStream(refusal.code, refusal.message)
    }
    const upstream = next()
    return (async function* guarded() {
      const source = await upstream
      if (source === null || typeof source !== 'object' || typeof source[Symbol.asyncIterator] !== 'function') {
        yield* source
        return
      }
      const iterator = source[Symbol.asyncIterator]()
      const detector = repetition.enabled ? createRepetitionDetector(repetition) : null
      let settled = false
      let reported = false
      const close = async () => {
        if (settled) return
        settled = true
        try {
          await iterator.return?.()
        } catch {
          // The upstream is already gone; nothing left to abort.
        }
      }
      try {
        for (;;) {
          const step = await iterator.next()
          if (step.done === true) {
            settled = true
            return
          }
          const chunk = step.value
          yield chunk
          if (chunk === null || typeof chunk !== 'object') continue
          if (chunk.type === 'finish') {
            settled = true
            return
          }
          const textDelta = chunk.type === 'text-delta' || (repetition.includeReasoning && chunk.type === 'reasoning-delta')
          if (detector !== null && textDelta) {
            const hit = detector.push(chunk.text)
            if (hit !== null && !reported) {
              reported = true
              stats.repetitionHits += 1
              const reason = describeHit(hit, messages)
              emit({ kind: 'repetition', sessionId, dryRun, hit: { kind: hit.kind, unitLength: hit.unitLength, copies: hit.copies, spanChars: hit.spanChars }, reason })
              if (!dryRun) {
                await close()
                yield terminalError(REPETITION_CODE, messages.repetitionCut(reason))
                return
              }
            }
          }
          if (chunk.type === 'text-delta' || (repetition.includeReasoning && chunk.type === 'reasoning-delta')) {
            const over = chargeOutput(sessionId, chunkWeight(chunk), brake, messages)
            if (over !== null && !reported) {
              reported = true
              stats.budgetStops += 1
              emit({ kind: 'budget-output', sessionId, dryRun, code: over.code, message: over.message })
              if (!dryRun) {
                await close()
                yield terminalError(over.code, over.message)
                return
              }
            }
          }
        }
      } finally {
        await close()
      }
    })()
  }

  /**
   * Own recovery for the guard's own failures. Any other failure delegates
   * downstream unchanged, so provider retry policy still applies to it.
   */
  async function requestErrorListener(payload, next) {
    const cfg = settings()
    const failure = payload?.failure
    if (failure?.code === REPETITION_CODE && cfg.enabled && cfg.repetition.enabled) {
      const attempt = mayRetry(payload.agent, payload.turn, payload.step, cfg.repetition)
      if (attempt !== false) {
        stats.repetitionRetries += 1
        emit({ kind: 'repetition-retry', turn: payload.turn, step: payload.step, attempt })
        return { kind: 'retry' }
      }
      stats.repetitionStops += 1
      emit({ kind: 'repetition-stop', turn: payload.turn, step: payload.step })
      return undefined
    }
    if (failure?.code === BUDGET_CODE) return undefined
    return next()
  }

  /** Keep the guard's turn clock aligned with the loop's own turn numbering. */
  async function preStepListener(payload, next) {
    const decision = await next()
    if (payload !== undefined && payload !== null && payload.agent !== undefined) {
      const sessionId = payload.agent.session?.id
      if (typeof sessionId === 'string') turnState(sessionId, payload.turn)
    }
    return decision
  }

  /** Advance one agent's consecutive-call chains and decide what to do. */
  function observeTool(exec, toolLoop) {
    if (exec === undefined || exec === null || exec.agent === undefined) return null
    if (!tracked(exec.name, toolLoop)) return null
    const exactKey = `${exec.name}|${canonicalize(exec.arguments)}`
    const fuzzyKey = `${exec.name}|${targetToken(exec.name, exec.arguments)}`
    const chain = chains.get(exec.agent)
    const exactCount = chain !== undefined && chain.exactKey === exactKey ? chain.exactCount + 1 : 1
    const fuzzyCount = chain !== undefined && chain.fuzzyKey === fuzzyKey ? chain.fuzzyCount + 1 : 1
    const history = chain !== undefined ? [...chain.history, fuzzyKey].slice(-12) : [fuzzyKey]
    chains.set(exec.agent, { exactKey, exactCount, fuzzyKey, fuzzyCount, history })

    // The built-in exact-repeat guard already nudges exact chains; speak only
    // when the arguments drifted and that guard therefore stays silent.
    if (fuzzyCount === toolLoop.fuzzyAdvisoryAt && exactCount === 1) {
      return { action: 'advisory', count: fuzzyCount, reason: 'near-duplicate', tool: exec.name, key: fuzzyKey, history }
    }
    if (fuzzyCount === toolLoop.hardStopAt) {
      return { action: 'stop', count: fuzzyCount, reason: 'near-duplicate', tool: exec.name, key: fuzzyKey, history }
    }
    // The cycle check answers a different shape: a call that broke the
    // consecutive chain (A→B→A→B) resets the counter above, so it only runs
    // when this call started a fresh chain, and only at the exact history
    // length where the cycle first completes — one notice per cycle.
    if (fuzzyCount === 1) {
      const cycle = detectCycle(history, toolLoop)
      if (cycle !== null) {
        return { action: 'advisory', count: cycle.repeats, reason: 'cycle', tool: exec.name, key: fuzzyKey, history }
      }
    }
    return null
  }

  /**
   * Find a short period repeating across the recent call history (A→B→A→B),
   * which the consecutive-chain counter deliberately resets on.
   * @param history - recent fuzzy keys, oldest first.
   * @param toolLoop - effective tool-loop settings.
   * @returns the cycle shape, or `null`.
   */
  function detectCycle(history, toolLoop) {
    for (let period = 2; period <= 4; period++) {
      const span = period * toolLoop.cycleAdvisoryAt
      if (history.length !== span) continue
      let ok = true
      for (let index = period; index < span && ok; index++) ok = history[index] === history[index - period]
      if (ok) return { period, repeats: toolLoop.cycleAdvisoryAt }
    }
    return null
  }

  /** Model-visible text for one tool-loop decision. */
  function toolNoticeText(outcome, toolLoop, messages) {
    const preview = outcome.key.length > toolLoop.argumentsPreviewChars ? `${outcome.key.slice(0, toolLoop.argumentsPreviewChars)}…` : outcome.key
    if (outcome.action === 'stop') return messages.noticeStop(outcome.tool, outcome.count, preview)
    if (outcome.reason === 'cycle') return messages.noticeCycle(outcome.period, preview)
    return messages.noticeNearDuplicate(outcome.tool, outcome.count, preview)
  }

  /** Post-execute listener: advise on near-duplicate chains, cancel past the hard threshold. */
  async function postToolListener(exec, result, next) {
    const downstream = await next()
    const cfg = settings()
    const { toolLoop, dryRun } = cfg
    if (!cfg.enabled || !toolLoop.enabled) return downstream
    const messages = createMessages(cfg.locale)
    const outcome = observeTool(exec, toolLoop)
    if (outcome === null) return downstream
    if (outcome.action === 'stop') {
      stats.toolStops += 1
      emit({ kind: 'tool-stop', tool: outcome.tool, count: outcome.count, reason: outcome.reason, dryRun })
    } else {
      stats.toolAdvisories += 1
      emit({ kind: 'tool-advisory', tool: outcome.tool, count: outcome.count, reason: outcome.reason, dryRun })
    }
    if (dryRun) return downstream
    if (outcome.action === 'stop') {
      try {
        exec.agent?.cancel?.({ kind: 'hook', reason: messages.cancelReason(outcome.tool, outcome.count) })
      } catch {
        // A cancel racing agent teardown is already satisfied.
      }
    }
    const notice = makeNotice(toolNoticeText(outcome, toolLoop, messages), `${outcome.tool} × ${outcome.count}`)
    if (downstream.kind === 'block') {
      return { kind: 'block', feedback: downstream.feedback, additionalContexts: [notice, ...(downstream.additionalContexts ?? [])] }
    }
    return { ...downstream, additionalContexts: [notice, ...(downstream.additionalContexts ?? [])] }
  }

  return {
    streamListener,
    requestErrorListener,
    preStepListener,
    postToolListener,
    stats: () => ({ ...stats, callsThisHour: hourly.calls, sessions: turns.size }),
  }
}

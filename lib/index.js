/**
 * loop-guard — a DSH plugin that breaks the three ways an agent stops making
 * progress: repeated model output, repeated tool calls, and a turn that never
 * converges. It only uses documented extension seams (`llm/stream`,
 * `agent/request-error`, `agent/pre-step`, `tools/post-execute`) and never
 * rewrites the agent loop.
 *
 * @module dsh-loop-guard
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

import { DEFAULT_CONFIG, createGuard } from './guard.js'

export const name = 'loop-guard'
export const inject = []

const repetition = DEFAULT_CONFIG.repetition
const toolLoop = DEFAULT_CONFIG.toolLoop
const brake = DEFAULT_CONFIG.brake

/** Loader schema; every field falls back to {@link DEFAULT_CONFIG}. */
export const Config = z.object({
  enabled: z.boolean().default(DEFAULT_CONFIG.enabled),
  dryRun: z.boolean().default(DEFAULT_CONFIG.dryRun),
  logEvents: z.boolean().default(DEFAULT_CONFIG.logEvents),
  locale: z.union([z.const('en'), z.const('zh')]).default(DEFAULT_CONFIG.locale),
  repetition: z
    .object({
      enabled: z.boolean().default(repetition.enabled),
      includeReasoning: z.boolean().default(repetition.includeReasoning),
      maxRetries: z.number().min(0).max(5).default(repetition.maxRetries),
      minUnitChars: z.number().min(2).max(200).default(repetition.minUnitChars),
      maxUnitChars: z.number().min(2).max(500).default(repetition.maxUnitChars),
      minRepeats: z.number().min(3).max(64).default(repetition.minRepeats),
      minSpanChars: z.number().min(64).max(20000).default(repetition.minSpanChars),
      windowChars: z.number().min(512).max(65536).default(repetition.windowChars),
      minShingleOccurrences: z.number().min(2).max(64).default(repetition.minShingleOccurrences),
      minShingleCoverage: z.number().min(0.1).max(1).default(repetition.minShingleCoverage),
    })
    .default({}),
  toolLoop: z
    .object({
      enabled: z.boolean().default(toolLoop.enabled),
      fuzzyAdvisoryAt: z.number().min(2).max(64).default(toolLoop.fuzzyAdvisoryAt),
      hardStopAt: z.number().min(3).max(128).default(toolLoop.hardStopAt),
      cycleAdvisoryAt: z.number().min(2).max(16).default(toolLoop.cycleAdvisoryAt),
      exclude: z.array(z.string()).default([...toolLoop.exclude]),
      argumentsPreviewChars: z.number().min(40).max(4000).default(toolLoop.argumentsPreviewChars),
    })
    .default({}),
  brake: z
    .object({
      enabled: z.boolean().default(brake.enabled),
      maxStepsPerTurn: z.number().min(0).default(brake.maxStepsPerTurn),
      maxTurnMinutes: z.number().min(0).default(brake.maxTurnMinutes),
      maxCallsPerHour: z.number().min(0).default(brake.maxCallsPerHour),
      maxOutputCharsPerTurn: z.number().min(0).default(brake.maxOutputCharsPerTurn),
    })
    .default({}),
})

/**
 * Resolve the loader config into the plain document the guard reads. Nested
 * sections may arrive undefined when a patch states none, so each one is
 * passed through as-is and merged over the defaults inside the guard.
 * @param raw - loader-resolved config, possibly partial.
 * @returns plain configuration document.
 */
function readConfig(raw) {
  const section = raw ?? {}
  const live = (node, fallback) => {
    if (node === undefined || node === null) return fallback
    return typeof node.get === 'function' ? node.get() ?? fallback : node
  }
  return {
    enabled: live(section.enabled, DEFAULT_CONFIG.enabled),
    dryRun: live(section.dryRun, DEFAULT_CONFIG.dryRun),
    logEvents: live(section.logEvents, DEFAULT_CONFIG.logEvents),
    locale: live(section.locale, DEFAULT_CONFIG.locale),
    repetition: live(section.repetition, {}),
    toolLoop: live(section.toolLoop, {}),
    brake: live(section.brake, {}),
  }
}

/**
 * Install the guard's listeners. They are scoped to this plugin fiber and
 * disposed with it, so a profile reload leaves nothing behind.
 * @param ctx - plugin context.
 * @param rawConfig - loader-resolved configuration.
 */
export function apply(ctx, rawConfig) {
  const config = readConfig(rawConfig)
  const home = process.env.DSH_HOME ?? path.join(homedir(), '.dsh')
  const logPath = path.join(home, 'loop-guard', 'events.jsonl')
  const overridePath = path.join(home, 'loop-guard', 'config.json')
  let writes = Promise.resolve()

  const emit = (record) => {
    const line = JSON.stringify({ at: new Date().toISOString(), ...record })
    ctx.logger?.info?.(`[loop-guard] ${line}`)
    if (!config.logEvents) return
    writes = writes
      .then(async () => {
        await mkdir(path.dirname(logPath), { recursive: true })
        await appendFile(logPath, `${line}\n`, 'utf8')
      })
      .catch(() => {
        // Observability must never break a turn; a failed append is dropped.
      })
  }

  /**
   * Live override document, merged over the loader configuration by the guard.
   *
   * The profile patch is only read at startup, so tuning it costs a restart.
   * This file is read afresh whenever the guard makes a decision, which makes
   * toggling one knob a save-and-go operation. The text is compared before the
   * parse, so an unchanged file costs one small read and no allocation.
   * @returns the parsed override document, or `null` when there is none.
   */
  let overrideText = null
  let overrideValue = null
  const readOverrides = () => {
    let text = null
    try {
      text = readFileSync(overridePath, 'utf8')
    } catch {
      text = null
    }
    if (text === overrideText) return overrideValue
    overrideText = text
    if (text === null) {
      overrideValue = null
      emit({ kind: 'overrides-absent', path: overridePath })
      return null
    }
    try {
      overrideValue = JSON.parse(text)
      emit({ kind: 'overrides-applied', path: overridePath, keys: Object.keys(overrideValue ?? {}) })
    } catch (error) {
      overrideValue = null
      emit({ kind: 'overrides-invalid', path: overridePath, message: String(error?.message ?? error) })
    }
    return overrideValue
  }

  const guard = createGuard(config, {
    emit,
    readOverrides,
    makeNotice: (text, summary) =>
      createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'loop-guard', form: 'notice', summary },
      }),
  })

  ctx.on('llm/stream', guard.streamListener, { prepend: true })
  ctx.on('agent/request-error', guard.requestErrorListener)
  ctx.on('agent/pre-step', guard.preStepListener)
  ctx.on('tools/post-execute', guard.postToolListener)

  // The durable log line is the load receipt: it proves the loader mounted this
  // entry in the running process, which the console log alone cannot show.
  emit({
    kind: 'plugin-loaded',
    enabled: config.enabled,
    dryRun: config.dryRun,
    locale: config.locale,
    repetition: config.repetition?.enabled !== false,
    toolLoop: config.toolLoop?.enabled !== false,
    brake: config.brake?.enabled !== false,
  })
}

export { DEFAULT_CONFIG }

import assert from 'node:assert/strict'
import test from 'node:test'

import { BUDGET_CODE, REPETITION_CODE, createGuard, targetToken } from '../lib/guard.js'

/** Drain an async iterable into an array. */
async function collect(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

/** A chunk source that records whether the consumer closed it early. */
function source(chunks, onReturn) {
  let index = 0
  return {
    [Symbol.asyncIterator]() {
      return this
    },
    async next() {
      return index < chunks.length ? { value: chunks[index++], done: false } : { value: undefined, done: true }
    },
    async return() {
      onReturn?.()
      return { value: undefined, done: true }
    },
  }
}

/** Build a guard whose observability and notice construction are captured. */
function build(config = {}, hooks = {}) {
  const events = []
  const notices = []
  const guard = createGuard(config, {
    emit: (record) => events.push(record),
    makeNotice: (text, summary) => {
      notices.push({ text, summary })
      return { notice: summary }
    },
    ...hooks,
  })
  return { guard, events, notices }
}

const textDeltas = (text, size = 17) => {
  const chunks = []
  for (let index = 0; index < text.length; index += size) {
    chunks.push({ type: 'text-delta', index: 0, text: text.slice(index, index + size) })
  }
  return chunks
}

test('leaves auxiliary requests untouched', () => {
  const { guard } = build()
  const raw = source([{ type: 'finish', reason: { kind: 'stop' } }])
  const returned = guard.streamListener({ purpose: 'session-title', sessionId: 's1' }, () => raw)
  assert.equal(returned, raw)
})

test('forwards a healthy stream unchanged', async () => {
  const { guard } = build()
  const chunks = [...textDeltas('这是一段正常的中文回答，长度足够但没有任何重复。'.repeat(6)), { type: 'finish', reason: { kind: 'stop' } }]
  const seen = await collect(guard.streamListener({ sessionId: 's1' }, () => source(chunks)))
  assert.deepEqual(seen, chunks)
})

test('cuts a degenerate stream, reports why, and closes the provider stream', async () => {
  const { guard, events } = build()
  let closed = false
  const chunks = textDeltas('好。（输出。）'.repeat(120), 20)
  const seen = await collect(guard.streamListener({ sessionId: 's1' }, () => source(chunks, () => (closed = true))))
  const last = seen.at(-1)
  assert.equal(last.type, 'finish')
  assert.equal(last.reason.kind, 'error')
  assert.equal(last.reason.failure.code, REPETITION_CODE)
  assert.match(last.reason.failure.message, /repeat/i, 'the default locale is English')
  assert.ok(seen.length < chunks.length, 'the stream should stop before the provider finished')
  assert.equal(closed, true)
  assert.equal(events.at(-1).kind, 'repetition')
})

test('renders user-facing messages in the configured locale', async () => {
  const en = build()
  const zh = build({ locale: 'zh' })
  const chunks = textDeltas('好。（输出。）'.repeat(120), 20)
  const english = await collect(en.guard.streamListener({ sessionId: 's1' }, () => source(chunks)))
  const chinese = await collect(zh.guard.streamListener({ sessionId: 's1' }, () => source(chunks)))
  assert.match(english.at(-1).reason.failure.message, /Detected/)
  assert.match(chinese.at(-1).reason.failure.message, /检测到/)
  assert.match(en.events.at(-1).reason, /repeated/)
  assert.match(zh.events.at(-1).reason, /重复/)
})

test('an unknown locale falls back to English', async () => {
  const { guard } = build({ locale: 'fr' })
  const chunks = textDeltas('好。（输出。）'.repeat(120), 20)
  const seen = await collect(guard.streamListener({ sessionId: 's1' }, () => source(chunks)))
  assert.match(seen.at(-1).reason.failure.message, /Detected/)
})

test('owns recovery for its own failure code and delegates every other failure', async () => {
  const { guard } = build({ repetition: { maxRetries: 1 } })
  const agent = {}
  const retry = { kind: 'retry' }
  assert.deepEqual(await guard.requestErrorListener({ agent, turn: 1, step: 1, failure: { code: REPETITION_CODE } }, async () => undefined), retry)
  assert.equal(await guard.requestErrorListener({ agent, turn: 1, step: 1, failure: { code: REPETITION_CODE } }, async () => undefined), undefined)
  assert.deepEqual(await guard.requestErrorListener({ agent, turn: 1, step: 2, failure: { code: REPETITION_CODE } }, async () => undefined), retry)
  assert.equal(await guard.requestErrorListener({ agent, turn: 1, step: 2, failure: { code: BUDGET_CODE } }, async () => undefined), undefined)
  assert.equal(await guard.requestErrorListener({ agent, turn: 1, step: 2, failure: { code: 'RATE_LIMIT' } }, async () => 'delegated'), 'delegated')
})

test('a new turn restores the retry budget', async () => {
  const { guard } = build({ repetition: { maxRetries: 0 } })
  const agent = { session: { id: 's1' } }
  assert.equal(await guard.requestErrorListener({ agent, turn: 1, step: 1, failure: { code: REPETITION_CODE } }, async () => undefined), undefined)
  await guard.preStepListener({ agent, turn: 2, step: 1 }, async () => ({ kind: 'enter', messages: [] }))
  const { guard: fresh } = build({ repetition: { maxRetries: 1 } })
  assert.deepEqual(await fresh.requestErrorListener({ agent, turn: 2, step: 1, failure: { code: REPETITION_CODE } }, async () => undefined), { kind: 'retry' })
})

test('refuses to dispatch once the turn step budget is spent', async () => {
  const { guard, events } = build({ brake: { maxStepsPerTurn: 2 } })
  let dispatches = 0
  const next = () => {
    dispatches += 1
    return source([{ type: 'finish', reason: { kind: 'stop' } }])
  }
  await collect(guard.streamListener({ sessionId: 's1' }, next))
  await collect(guard.streamListener({ sessionId: 's1' }, next))
  const refused = await collect(guard.streamListener({ sessionId: 's1' }, next))
  assert.equal(dispatches, 2, 'the refused call must never reach the provider')
  assert.equal(refused.length, 1)
  assert.equal(refused[0].reason.failure.code, BUDGET_CODE)
  assert.equal(events.at(-1).kind, 'budget-refused')
})

test('cuts a stream that outruns the per-turn output budget', async () => {
  const { guard } = build({ brake: { maxOutputCharsPerTurn: 100 } })
  const chunks = textDeltas('第'.repeat(1) + '一段不重复的说明文字，用来把输出额度撑破。'.repeat(40), 30)
  const seen = await collect(guard.streamListener({ sessionId: 's1' }, () => source(chunks)))
  const last = seen.at(-1)
  assert.equal(last.type, 'finish')
  assert.equal(last.reason.failure.code, BUDGET_CODE)
  assert.ok(seen.length < chunks.length)
})

test('target tokens ignore arguments that only tune the same action', () => {
  const first = targetToken('read', { path: 'D:\\a.md', offset: 1, limit: 50 })
  const second = targetToken('read', { path: 'D:\\a.md', offset: 900, limit: 50 })
  assert.equal(first, second)
  assert.notEqual(first, targetToken('read', { path: 'D:\\b.md', offset: 1, limit: 50 }))
})

test('advises on near-duplicate tool calls and cancels past the hard bar', async () => {
  const { guard, events, notices } = build({ toolLoop: { fuzzyAdvisoryAt: 3, hardStopAt: 5 } })
  const cancelled = []
  const agent = { cancel: (cause) => cancelled.push(cause) }
  const call = (offset) => ({ name: 'read', arguments: { path: 'D:\\a.md', offset }, agent })
  const next = async () => ({ kind: 'accept' })
  const decisions = []
  for (const offset of [1, 100, 200, 300, 400, 500]) {
    decisions.push(await guard.postToolListener(call(offset), {}, next))
  }
  assert.equal(notices.length, 2, 'one advisory at the fuzzy bar, one stop notice')
  assert.deepEqual(decisions[0], { kind: 'accept' })
  assert.deepEqual(decisions[2].additionalContexts, [{ notice: 'read × 3' }])
  assert.equal(cancelled.length, 1)
  assert.equal(cancelled[0].kind, 'hook')
  assert.match(cancelled[0].reason, /read/)
  assert.ok(events.some((event) => event.kind === 'tool-advisory'))
  assert.ok(events.some((event) => event.kind === 'tool-stop'))
})

test('stays silent for excluded tools and for a single call', async () => {
  const { guard, notices } = build({ toolLoop: { fuzzyAdvisoryAt: 2, hardStopAt: 3 } })
  const agent = { cancel: () => assert.fail('excluded tools must never cancel the turn') }
  const next = async () => ({ kind: 'accept' })
  for (const offset of [1, 2, 3, 4]) {
    await guard.postToolListener({ name: 'todo_write', arguments: { offset }, agent }, {}, next)
  }
  await guard.postToolListener({ name: 'read', arguments: { path: 'x' }, agent }, {}, next)
  assert.equal(notices.length, 0)
})

test('dry run reports every decision without enforcing any of them', async () => {
  const { guard, events, notices } = build({ dryRun: true, brake: { maxStepsPerTurn: 1 }, toolLoop: { fuzzyAdvisoryAt: 2, hardStopAt: 3 } })
  const chunks = [...textDeltas('好。（输出。）'.repeat(120), 20), { type: 'finish', reason: { kind: 'stop' } }]
  const seen = await collect(guard.streamListener({ sessionId: 's1' }, () => source(chunks)))
  assert.deepEqual(seen, chunks, 'dry run must forward the degenerate stream untouched')
  assert.equal(events.filter((event) => event.kind === 'repetition').length, 1)
  assert.equal(events.filter((event) => event.kind === 'repetition').at(0).dryRun, true)
  const dispatched = await collect(guard.streamListener({ sessionId: 's1' }, () => source([{ type: 'finish', reason: { kind: 'stop' } }])))
  assert.equal(dispatched.at(-1).reason.kind, 'stop', 'dry run must still dispatch past the step budget')
  const agent = { cancel: () => assert.fail('dry run must not cancel the turn') }
  const next = async () => ({ kind: 'accept' })
  for (const offset of [1, 2, 3]) {
    const decision = await guard.postToolListener({ name: 'read', arguments: { path: 'a', offset }, agent }, {}, next)
    assert.deepEqual(decision, { kind: 'accept' })
  }
  assert.equal(notices.length, 0)
  assert.ok(events.some((event) => event.kind === 'tool-stop'))
})

test('tool-call arguments never count against the output budget', async () => {
  const { guard } = build({ brake: { maxOutputCharsPerTurn: 100 } })
  const chunks = [
    { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'write', argumentsDelta: 'x'.repeat(5000) },
    { type: 'text-delta', index: 0, text: '短' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const seen = await collect(guard.streamListener({ sessionId: 's1' }, () => source(chunks)))
  assert.deepEqual(seen, chunks, 'a large tool payload is real work, not runaway output')
})

test('a live override applies to the next call without rebuilding the guard', async () => {
  let overrides = null
  const events = []
  const guard = createGuard(
    { brake: { maxStepsPerTurn: 1 } },
    { emit: (record) => events.push(record), readOverrides: () => overrides },
  )
  const next = () => source([{ type: 'finish', reason: { kind: 'stop' } }])
  const first = await collect(guard.streamListener({ sessionId: 's1' }, next))
  assert.equal(first.at(-1).reason.kind, 'stop')
  const refused = await collect(guard.streamListener({ sessionId: 's1' }, next))
  assert.equal(refused.at(-1).reason.failure.code, BUDGET_CODE)
  overrides = { brake: { enabled: false } }
  const after = await collect(guard.streamListener({ sessionId: 's1' }, next))
  assert.equal(after.at(-1).reason.kind, 'stop', 'the override must take effect on the next call')
  overrides = { repetition: { enabled: false }, toolLoop: { hardStopAt: 3 } }
  const agent = {}
  const decision = await guard.postToolListener({ name: 'read', arguments: { path: 'a' }, agent }, {}, async () => ({ kind: 'accept' }))
  assert.deepEqual(decision, { kind: 'accept' })
})

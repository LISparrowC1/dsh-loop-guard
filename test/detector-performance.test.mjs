import assert from 'node:assert/strict'
import test from 'node:test'

import { createRepetitionDetector } from '../lib/detector.js'

/**
 * The detector runs on every streamed delta, so its cost has to stay flat as
 * the window fills. This measures the worst realistic shape: a full window of
 * non-repeating text streamed in small deltas.
 */
test('stays cheap per delta once the window is full', () => {
  const detector = createRepetitionDetector()
  const filler = '这一段是互不相同的说明文字，用来把滚动窗口填满并持续推动分片扫描。'
  let counter = 0
  const nextDelta = () => {
    counter += 1
    return `${counter}${filler}`
  }
  for (let index = 0; index < 400; index++) detector.push(nextDelta())
  const started = process.hrtime.bigint()
  for (let index = 0; index < 200; index++) detector.push(nextDelta())
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
  assert.ok(elapsedMs < 500, `200 deltas took ${elapsedMs.toFixed(1)}ms`)
})

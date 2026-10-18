import assert from 'node:assert/strict'
import test from 'node:test'

import { createRepetitionDetector } from '../lib/detector.js'

/** Feed one string to a detector in small deltas, mimicking streaming. */
function feedInDeltas(detector, text, size = 7) {
  let hit = null
  for (let index = 0; index < text.length && hit === null; index += size) {
    hit = detector.push(text.slice(index, index + size))
  }
  return hit
}

test('detects the incident pattern: one short unit repeated to the tail', () => {
  const detector = createRepetitionDetector()
  const hit = feedInDeltas(detector, '好。（输出。）'.repeat(80))
  assert.notEqual(hit, null)
  assert.ok(hit.unit.includes('好。'), `reported unit should quote the repeated text, got ${JSON.stringify(hit.unit)}`)
  assert.ok(hit.spanChars >= 200)
})

test('detects a repeated paragraph through the shingle window', () => {
  const detector = createRepetitionDetector()
  const block =
    '本轮先核对运行环境，再确认配置来源，最后把结果写回工作目录。' +
    '若其中任何一步无法确认，就停下来向用户说明阻塞点，而不是继续尝试。'
  const hit = feedInDeltas(detector, `${'开场白，稍后会被同一段内容淹没。'.repeat(3)}${block.repeat(5)}`)
  assert.notEqual(hit, null)
  assert.ok(hit.coverage >= 0.5)
  assert.ok(hit.copies >= 4)
})

test('stays silent on ordinary varied prose', () => {
  const detector = createRepetitionDetector()
  const prose = [
    '先看第一件事：项目的工作目录里只有一个博客目录，主题是 Butterfly，配置被拆成了两份文件。',
    '第二件事是插件来源，一半来自 npm，一半来自本地 vendor 目录，安装方式不一样。',
    '第三件事是数据落盘的位置，索引在 sqlite 里，原始记录按行追加在 jsonl 文件里。',
    '把这些事实摆在一起之后，真正需要决策的其实只有一条：改动落在哪一层。',
    '如果改动落在配置层，回滚就是改回一行；如果落在代码层，回滚要重新安装插件。',
    '两条路的成本差得很远，所以先把事实查清楚，再决定改哪一层，是更省事的选择。',
    '文件系统那一侧还有一个约束：会话本体删掉之后，投影缓存并不会一起消失。',
    '所以事后想复盘一次事故，仍然能从缓存里读出当时的标题、轮次和用量明细。',
    '真正麻烦的是插件的加载顺序，瀑布式事件里谁在最外层决定了谁能裁掉流。',
    '最外层的监听者拿到的是完整分片，它一旦提前收摊，内层的清理逻辑仍会被触发。',
    '因此中断一次模型输出并不需要改动循环本身，只需要在协议层面交出一个终止分片。',
    '终止分片携带的错误码决定了这一步是重跑、还是就此收尾并把原因交回给用户。',
  ].join('\n')
  const hit = feedInDeltas(detector, prose)
  assert.equal(hit, null)
})

test('stays silent on repeated short fragments below the span bar', () => {
  const detector = createRepetitionDetector()
  const hit = feedInDeltas(detector, `结论是${'哈哈哈'.repeat(20)}，就这样。`)
  assert.equal(hit, null)
})

test('stays silent on a table whose rows merely share a separator', () => {
  const detector = createRepetitionDetector()
  const rows = Array.from({ length: 40 }, (_, index) => `| 项目${index} | 已完成 ${index} |`)
  const hit = feedInDeltas(detector, `| 项目 | 状态 |\n| --- | --- |\n${rows.join('\n')}\n`)
  assert.equal(hit, null)
})

test('keeps scanning shingles after the window saturates', () => {
  const detector = createRepetitionDetector({ windowChars: 1024, minSpanChars: 400 })
  const varied = Array.from({ length: 400 }, (_, index) => `第${index}步的结论各不相同。`).join('')
  assert.equal(feedInDeltas(detector, varied), null)
  const hit = feedInDeltas(detector, '反复出现的同一段内容，用来验证窗口填满之后仍然会继续扫描。'.repeat(20))
  assert.notEqual(hit, null)
})

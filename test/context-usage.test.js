import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contextUsage, effectiveModel, estimateContextTokens, usageTotal } from '../src/project/context-usage.js'

const assistant = (text, usage) => ({ kind: 'assistant', text, usage, at: '2026-01-01T00:00:00.000Z' })
const user = text => ({ kind: 'user', text, at: '2026-01-01T00:00:00.000Z' })

test('usageTotal prefers totalTokens and falls back to the parts', () => {
  assert.equal(usageTotal({ totalTokens: 1234, input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }), 1234)
  // `totalTokens` is absent in older records; the parts must still add up.
  assert.equal(usageTotal({ input: 10, output: 5, cacheRead: 2, cacheWrite: 1 }), 18)
  assert.equal(usageTotal(null), 0)
  assert.equal(usageTotal({}), 0)
})

test('the anchored estimate does NOT re-count the anchored message itself', () => {
  // `usage` already covers the assistant message it is recorded on (its prose
  // is `output`); counting that text again as trailing would double it.
  const entries = [user('q'), assistant('a'.repeat(400), { input: 1000, output: 10 })]
  const result = estimateContextTokens(entries)
  assert.equal(result.anchored, true)
  assert.equal(result.tokens, 1010)
})

test('entries after the anchor are estimated on top of its usage', () => {
  const entries = [
    assistant('hi', { input: 1000, output: 10 }),
    user('x'.repeat(400)),
  ]
  // 1010 (billed) + 400 chars / 4 = 100 (unbilled but in context)
  assert.equal(estimateContextTokens(entries).tokens, 1110)
})

test('a session with no usage record falls back to a pure estimate', () => {
  const entries = [user('x'.repeat(400)), assistant('y'.repeat(400))]
  const result = estimateContextTokens(entries)
  assert.equal(result.anchored, false)
  assert.equal(result.tokens, 200)
})

test('the entry payload pi counts is added once, via usageChars', () => {
  // The projector sums reasoning length + compact tool arguments into ONE
  // field, so the estimator adds it exactly once no matter how many items the
  // entry produced. Counting `process[].arguments` as well would double it.
  const base = assistant('hi', { input: 100, output: 0 })
  const withPayload = [base, { kind: 'assistant', text: '', usage: null, usageChars: 80 }]
  const withoutPayload = [base, { kind: 'assistant', text: '', usage: null }]
  assert.equal(estimateContextTokens(withoutPayload).tokens, 100)
  assert.equal(estimateContextTokens(withPayload).tokens, 120)
})

test('a tool result output counts as context', () => {
  // The folded tool output rides in the context on the next request.
  const entries = [{
    kind: 'assistant', text: '', usage: { input: 100, output: 0 },
    process: [{ name: 'bash', arguments: null, argumentsChars: null, result: 'x'.repeat(400), error: null }],
  }]
  assert.equal(estimateContextTokens(entries).tokens, 200)
})

test('a reasoning-only entry still yields an anchor', () => {
  // A tool-only round reports context usage and no prose; the projector emits
  // a `usage` entry so the ring keeps its anchor.
  const entries = [
    user('q'),
    { kind: 'usage', text: '', usage: { input: 5000, output: 20 }, usageChars: 0, process: [] },
    { kind: 'assistant', text: 'x'.repeat(40), usage: null, usageChars: 0, process: [] },
  ]
  const result = estimateContextTokens(entries)
  assert.equal(result.anchored, true)
  // 5020 anchored + 40 chars / 4 trailing
  assert.equal(result.tokens, 5030)
})

test('a compaction after the anchor discards it', () => {
  // Compaction rewrites the context, so the old usage no longer describes the
  // window. The re-estimate then starts at the compaction: its summary plus
  // whatever follows.
  const entries = [
    user('q'.repeat(40)),
    assistant('a'.repeat(40), { input: 90_000, output: 10 }),
    { kind: 'compaction', text: 'summary', at: '2026-01-01T00:00:00.000Z' },
  ]
  const result = estimateContextTokens(entries)
  assert.equal(result.anchored, false)
  // "summary" (7) / 4 → 2 tokens, and nothing before the compaction counts.
  assert.equal(result.tokens, 2)
})

test('contextUsage needs a window and clamps to 100', () => {
  const entries = [assistant('a'.repeat(40), { input: 500, output: 0 })]
  assert.equal(contextUsage({ entries, contextWindow: null }), null)
  assert.equal(contextUsage({ entries, contextWindow: 0 }), null)
  const usage = contextUsage({ entries, contextWindow: 1000 })
  assert.equal(usage.tokens, 500)
  assert.equal(usage.percent, 50)
  assert.equal(usage.estimated, false)
  // A window smaller than the usage must not produce > 100%.
  assert.equal(contextUsage({ entries, contextWindow: 10 }).percent, 100)
})

test('the effective model is the newest model_change, else the header', () => {
  const changes = [
    { type: 'model_change', provider: 'trae', modelId: 'first' },
    { type: 'message', message: { role: 'user' } },
    { type: 'model_change', provider: 'qoder-cn', modelId: 'last' },
  ]
  assert.deepEqual(effectiveModel(changes, { provider: 'h', model: 'header' }), { provider: 'qoder-cn', id: 'last' })
  // No change entry: the header is the only source.
  assert.deepEqual(effectiveModel([{ type: 'message' }], { provider: 'trae', model: 'glm' }), { provider: 'trae', id: 'glm' })
  assert.equal(effectiveModel([], { cwd: '/tmp' }), null)
})

test('a model_change carrying `model` instead of `modelId` is read too', () => {
  assert.deepEqual(effectiveModel([{ type: 'model_change', provider: 'p', model: 'm' }], null), { provider: 'p', id: 'm' })
})

test('a context edit after the anchor discards it too', () => {
  // pi invalidates the usage anchor on a context_edit as well as a compaction:
  // a context edit REMOVES a block (`replacement: null` in every real session),
  // so the recorded usage no longer describes what is in the window. Missing
  // this made the ring overstate usage by up to 9k tokens on real sessions.
  const entries = [
    user('q'.repeat(40)),
    assistant('a'.repeat(40), { input: 5000, output: 10 }),
    { kind: 'context-edit', at: '2026-01-01T00:00:00.000Z' },
  ]
  const result = estimateContextTokens(entries)
  assert.equal(result.anchored, false)
  assert.ok(result.tokens < 100, `expected a re-estimate, got ${result.tokens}`)
})

test('a context edit BEFORE the anchor leaves it intact', () => {
  const entries = [
    { kind: 'context-edit', at: '2026-01-01T00:00:00.000Z' },
    user('q'),
    assistant('a', { input: 5000, output: 10 }),
  ]
  const result = estimateContextTokens(entries)
  assert.equal(result.anchored, true)
  assert.equal(result.tokens, 5010)
})

test('the fallback measures from the last compaction, not the whole transcript', () => {
  // A compaction REPLACES everything before it with its summary. Summing the
  // whole transcript after a compaction reported 94.6% for a session pi calls
  // 0.3% — the ring would panic the user about a context that was just cleared.
  const entries = [
    user('x'.repeat(400_000)),
    assistant('y'.repeat(400_000), { input: 900_000, output: 10 }),
    { kind: 'compaction', text: 'summary', at: '2026-01-01T00:00:00.000Z' },
    user('z'.repeat(40)),
  ]
  const result = estimateContextTokens(entries)
  assert.equal(result.anchored, false)
  // "summary" (7) + 40 chars = 47/4 = 12 tokens, NOT ~200k.
  assert.equal(result.tokens, 12)
})

test('several compactions keep only the newest prefix', () => {
  const entries = [
    user('a'.repeat(4000)),
    { kind: 'compaction', text: 'first', at: '2026-01-01T00:00:00.000Z' },
    user('b'.repeat(4000)),
    { kind: 'compaction', text: 'second', at: '2026-01-01T00:00:00.000Z' },
  ]
  // "second" only: 6 chars → 2 tokens.
  assert.equal(estimateContextTokens(entries).tokens, 2)
})

test('an image is charged pi\'s flat 4800 characters, not its payload size', () => {
  // pi: ESTIMATED_IMAGE_CHARS = 4800 → 1200 tokens at the 4-chars divisor.
  // 漏掉这笔账，带图会话的圆环就会少报。
  const entries = [user('q'), { kind: 'user', text: '', imageCount: 1, usageChars: 4800, at: '2026-01-01T00:00:00.000Z' }]
  const result = estimateContextTokens(entries)
  assert.equal(result.tokens, Math.ceil(1 / 4) + 1200)
  assert.equal(result.anchored, false)
})

test('an image folded into a tool result is charged even at the usage anchor', () => {
  // 锚点分支只把锚点之后的 tool result 计入尾随上下文；图片那份账必须跟着走，
  // 否则「刚跑完一个截图工具」的那一轮会少报 1200 token。
  const anchored = { kind: 'assistant', text: 'done', usage: { input: 5000, output: 10 }, at: '2026-01-01T00:00:00.000Z', process: [{ callId: 'c1', name: 'screenshot', result: '', error: null, imageChars: 4800 }] }
  assert.equal(estimateContextTokens([user('q'), anchored]).tokens, 5000 + 10 + 1200)

  // 非锚点路径（锚点之后的工具轮）同样要计
  const trailing = { kind: 'assistant', text: '', at: '2026-01-01T00:00:02.000Z', process: [{ callId: 'c2', name: 'screenshot', result: '', error: null, imageChars: 4800 }] }
  assert.equal(estimateContextTokens([user('q'), anchored, trailing]).tokens, 5000 + 10 + 1200 + 1200)
})

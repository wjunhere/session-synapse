import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activeBranch, projectPiSession, parseSessionLines, splitSession, textOf, projectPiEntry } from '../src/project/pi.js'

/** A session shaped like real pi output: header + tree nodes. */
function session(entries) {
  return [{ type: 'session', version: 3, id: 'sess-1', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/tmp/proj' }, ...entries]
}

const user = (id, parentId, text) => ({
  type: 'message', id, parentId, timestamp: `2026-01-01T00:00:0${id.length}.000Z`,
  message: { role: 'user', content: [{ type: 'text', text }], timestamp: 1 },
})

const assistant = (id, parentId, blocks, extra = {}) => ({
  type: 'message', id, parentId, timestamp: `2026-01-01T00:00:0${id.length}.000Z`,
  message: { role: 'assistant', content: blocks, stopReason: 'stop', ...extra },
})

const toolResult = (id, parentId, callId, text) => ({
  type: 'message', id, parentId, timestamp: `2026-01-01T00:00:0${id.length}.000Z`,
  message: { role: 'toolResult', toolCallId: callId, toolName: 'bash', content: [{ type: 'text', text }], isError: false },
})

test('header is not treated as a tree node', () => {
  // The header has an `id` but no `parentId` key at all. Treating it as a node
  // makes every session look like it has two roots.
  const entries = session([user('aaaa', null, 'hello')])
  const branch = activeBranch(entries.slice(1))
  assert.equal(branch.length, 1)
  assert.equal(branch[0].id, 'aaaa')
})

test('active branch follows the last entry back to the root', () => {
  const entries = session([
    user('a1', null, 'q1'),
    assistant('a2', 'a1', [{ type: 'text', text: 'a1' }]),
    user('a3', 'a2', 'q2'),
    assistant('a4', 'a3', [{ type: 'text', text: 'a2' }]),
  ])
  const { entries: rest } = splitSession(entries)
  assert.deepEqual(activeBranch(rest).map(e => e.id), ['a1', 'a2', 'a3', 'a4'])
})

test('a side branch is excluded from the active path', () => {
  // a3 was abandoned; a5 continues from a2 instead.
  const entries = session([
    user('a1', null, 'q1'),
    assistant('a2', 'a1', [{ type: 'text', text: 'a1' }]),
    user('a3', 'a2', 'abandoned'),
    user('a5', 'a2', 'taken'),
    assistant('a6', 'a5', [{ type: 'text', text: 'a2' }]),
  ])
  const { entries: rest } = splitSession(entries)
  assert.deepEqual(activeBranch(rest).map(e => e.id), ['a1', 'a2', 'a5', 'a6'])
})

test('user question becomes a card and assistant reply folds into it', () => {
  const entries = session([
    user('a1', null, '什么是 pi？'),
    assistant('a2', 'a1', [{ type: 'text', text: 'pi 是一个 coding agent。' }]),
  ])
  const { header, entries: rest } = splitSession(entries)
  const projected = projectPiSession(header, rest)
  const kinds = projected.entries.map(e => e.kind)
  assert.deepEqual(kinds, ['user', 'assistant'])
  assert.equal(projected.entries[0].text, '什么是 pi？')
  assert.equal(projected.entries[1].text, 'pi 是一个 coding agent。')
})

test('thinking blocks never reach the canvas', () => {
  const entries = session([
    user('a1', null, 'q'),
    assistant('a2', 'a1', [{ type: 'thinking', thinking: 'secret reasoning' }, { type: 'text', text: 'answer' }]),
  ])
  const { header, entries: rest } = splitSession(entries)
  const projected = projectPiSession(header, rest)
  assert.equal(projected.entries[1].text, 'answer')
  assert.ok(!JSON.stringify(projected.entries).includes('secret reasoning'))
})

test('a tool result carries its parent assistant entry as the turn', () => {
  // A tool result is a child of the assistant entry that made the call, so its
  // `parentId` is what tells the store which turn the result belongs to.
  const entries = session([
    user('a1', null, 'run it'),
    assistant('a2', 'a1', [{ type: 'toolCall', id: 'call_1', name: 'bash', arguments: {} }]),
    toolResult('a3', 'a2', 'call_1', 'file.txt'),
  ])
  const { header, entries: rest } = splitSession(entries)
  const projected = projectPiSession(header, rest)
  const result = projected.entries.find(e => e.kind === 'tool-result')
  assert.equal(result.turn, 'a2')
})

test('tool calls and results are projected with their callId', () => {
  const entries = session([
    user('a1', null, 'run it'),
    assistant('a2', 'a1', [
      { type: 'text', text: 'running' },
      { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'ls' } },
    ]),
    toolResult('a3', 'a2', 'call_1', 'file.txt'),
  ])
  const { header, entries: rest } = splitSession(entries)
  const projected = projectPiSession(header, rest)
  const call = projected.entries.find(e => e.kind === 'tool-call')
  const result = projected.entries.find(e => e.kind === 'tool-result')
  assert.equal(call.callId, 'call_1')
  assert.equal(call.name, 'bash')
  assert.equal(result.callId, 'call_1')
  assert.equal(result.text, 'file.txt')
})

test('session_info supplies the card title', () => {
  const entries = session([
    { type: 'session_info', id: 'a1', parentId: null, timestamp: '2026-01-01T00:00:01.000Z', name: '重构认证模块' },
    user('a2', 'a1', 'q'),
  ])
  const { header, entries: rest } = splitSession(entries)
  const projected = projectPiSession(header, rest)
  const title = projected.entries.find(e => e.kind === 'title')
  assert.equal(title.text, '重构认证模块')
})

test('runtime-context snapshots are not cards', () => {
  const runtime = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n<cwd>/tmp</cwd>'
  const entries = session([
    user('a1', null, runtime),
    user('a2', 'a1', 'real question'),
  ])
  const { header, entries: rest } = splitSession(entries)
  const projected = projectPiSession(header, rest)
  assert.deepEqual(projected.entries.map(e => e.kind), ['user'])
  assert.equal(projected.entries[0].text, 'real question')
})

test('system messages and extension state are dropped', () => {
  const entries = session([
    { type: 'message', id: 'a1', parentId: null, timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'system', content: '', sections: { preamble: 'x'.repeat(100) } } },
    { type: 'custom', id: 'a2', parentId: 'a1', timestamp: '2026-01-01T00:00:02.000Z', customType: 'plannotator', data: {} },
    { type: 'model_change', id: 'a3', parentId: 'a2', timestamp: '2026-01-01T00:00:03.000Z', provider: 'x', modelId: 'y' },
    user('a4', 'a3', 'q'),
  ])
  const { header, entries: rest } = splitSession(entries)
  const projected = projectPiSession(header, rest)
  assert.deepEqual(projected.entries.map(e => e.kind), ['user'])
})

test('compaction becomes a separator entry, not a card', () => {
  const entries = session([
    user('a1', null, 'q'),
    { type: 'compaction', id: 'a2', parentId: 'a1', timestamp: '2026-01-01T00:00:02.000Z', summary: 'earlier work', firstKeptEntryId: 'a1' },
  ])
  const { header, entries: rest } = splitSession(entries)
  const projected = projectPiSession(header, rest)
  const separator = projected.entries.find(e => e.kind === 'compaction')
  assert.equal(separator.text, 'earlier work')
  // It must not look like a user question, or the canvas would draw a card for it.
  assert.ok(!projected.entries.some(e => e.kind === 'user' && e.text.includes('earlier work')))
})

test('a branch summary becomes its own separator entry', () => {
  const entries = session([
    user('a1', null, 'q'),
    { type: 'branch_summary', id: 'a2', parentId: 'a1', timestamp: '2026-01-01T00:00:02.000Z', fromId: 'a1', summary: 'explored approach A' },
  ])
  const { header, entries: rest } = splitSession(entries)
  const projected = projectPiSession(header, rest)
  const separator = projected.entries.find(e => e.kind === 'branch')
  assert.equal(separator.text, 'explored approach A')
})

test('an assistant error stop is projected as an error entry', () => {
  const entries = session([
    user('a1', null, 'q'),
    assistant('a2', 'a1', [], { stopReason: 'error', error: { name: 'APIError', message: 'boom' } }),
  ])
  const { header, entries: rest } = splitSession(entries)
  const projected = projectPiSession(header, rest)
  const error = projected.entries.find(e => e.kind === 'error')
  assert.equal(error.text, 'APIError: boom')
})

test('parseSessionLines tolerates a truncated trailing line', () => {
  const text = '{"type":"session"}\n{"type":"message","id":"a"}\n{"type":"mess'
  const parsed = parseSessionLines(text)
  assert.equal(parsed.length, 2)
})

test('textOf handles a plain string and nested tool results', () => {
  assert.equal(textOf('hello'), 'hello')
  assert.equal(textOf([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb')
  assert.equal(textOf([{ type: 'toolResult', content: [{ type: 'text', text: 'inner' }] }]), 'inner')
})

test('projectPiEntry ignores unknown entry types instead of throwing', () => {
  assert.deepEqual(projectPiEntry({ type: 'something_new', id: 'x', timestamp: '2026-01-01T00:00:00.000Z' }), [])
})

test('a display:false custom_message stays hidden', () => {
  const hidden = { type: 'custom_message', id: 'a1', parentId: null, customType: 'x', content: 'note', display: false, timestamp: '2026-01-01T00:00:01.000Z' }
  const shown = { type: 'custom_message', id: 'a2', parentId: 'a1', customType: 'x', content: 'note', display: true, timestamp: '2026-01-01T00:00:02.000Z' }
  assert.deepEqual(projectPiEntry(hidden), [])
  assert.equal(projectPiEntry(shown)[0].kind, 'user')
})
test('assistant usage is carried on the projected entry', () => {
  // The context-window figure is derived from this usage record, so it must
  // survive projection instead of being dropped with the raw entry.
  const entries = session([
    user('aaaa', null, 'question'),
    assistant('bbbb', 'aaaa', [{ type: 'text', text: 'answer' }], { usage: { input: 100, output: 5 } }),
  ])
  const { header, entries: rest } = splitSession(entries)
  const projected = projectPiSession(header, rest)
  const answer = projected.entries.find(entry => entry.kind === 'assistant')
  assert.deepEqual(answer.usage, { input: 100, output: 5 })
})

test('the session model is resolved from the newest model_change', () => {
  const entries = session([
    { type: 'model_change', id: 'mc1', parentId: 'sess-1', timestamp: '2026-01-01T00:00:00.000Z', provider: 'trae', modelId: 'glm' },
    user('aaaa', 'mc1', 'question'),
  ])
  const { header, entries: rest } = splitSession(entries)
  assert.deepEqual(projectPiSession(header, rest).model, { provider: 'trae', id: 'glm' })
})

test('a tool-selection custom entry becomes a tool-selection note', () => {
  // pi-web pins a session's tool loadout in a `custom` entry; the canvas mirrors
  // it so a btw card can show that its tools are restricted.
  const selection = projectPiEntry({
    type: 'custom', id: 'c1', customType: 'pi-web:tool-selection',
    data: { version: 1, tools: ['read', 'grep', 'read'] }, timestamp: '2026-01-01T00:00:00.000Z',
  })
  assert.equal(selection.length, 1)
  assert.equal(selection[0].kind, 'tool-selection')
  assert.deepEqual(selection[0].tools, ['read', 'grep'])
})

test('a cleared tool selection records no restriction', () => {
  const cleared = projectPiEntry({
    type: 'custom', id: 'c2', customType: 'pi-web:tool-selection',
    data: { version: 1, cleared: true }, timestamp: '2026-01-01T00:00:00.000Z',
  })
  assert.deepEqual(cleared, [{ id: 'c2:tools', kind: 'tool-selection', tools: null, at: '2026-01-01T00:00:00.000Z' }])
})

test('unrelated custom entries are still ignored', () => {
  // Extension state must never leak into the conversation.
  assert.deepEqual(projectPiEntry({ type: 'custom', id: 'c3', customType: 'plannotator:state', data: {} }), [])
})

test('a context_edit projects as a context-edit marker, not dropped', () => {
  // The estimator must see that the context was rewritten, so this entry has to
  // survive projection even though it carries no text of its own.
  const edit = projectPiEntry({ type: 'context_edit', id: 'ce1', targetId: 't1', replacement: null, timestamp: '2026-01-01T00:00:00.000Z' })
  assert.deepEqual(edit, [{ id: 'ce1:context-edit', kind: 'context-edit', at: '2026-01-01T00:00:00.000Z' }])
})

// ── 粘贴图片 ──
// pi 对每个图片块按固定 4800 字符（1200 token）计入上下文；投影必须把这份
// 账带上，否则带图的会话圆环会少报。

const imageBlock = (mimeType = 'image/png') => ({ type: 'image', data: 'aGVsbG8=', mimeType })

/** 与本文件其它用例一致的两步投影：先切 header，再投影活动分支。 */
function project(entries) {
  const { header, entries: rest } = splitSession(entries)
  return projectPiSession(header, rest).entries
}

test('an image-only message still becomes a turn', () => {
  // 没有文字的图片消息以前会被 note() 丢掉，卡片直接消失
  const entries = project([
    { type: 'message', id: 'u1', parentId: null, timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'user', content: [imageBlock()] } },
  ])
  assert.equal(entries.length, 1)
  assert.equal(entries[0].kind, 'user')
  assert.equal(entries[0].text, '')
  assert.equal(entries[0].imageCount, 1)
  assert.equal(entries[0].usageChars, 4800)
})

test('a message with text and images charges one image each', () => {
  const entries = project([
    { type: 'message', id: 'u1', parentId: null, timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: '看这两张图' }, imageBlock(), imageBlock('image/jpeg')] } },
  ])
  assert.equal(entries[0].text, '看这两张图')
  assert.equal(entries[0].imageCount, 2)
  assert.equal(entries[0].usageChars, 9600)
})

test('a text-only message carries no image accounting', () => {
  const entries = project([user('u1', null, '普通提问')])
  assert.equal(entries[0].imageCount, 0)
  assert.equal(entries[0].usageChars, 0)
})

test('a tool result that returned an image still charges for it', () => {
  const entries = project([
    assistant('a1', null, [{ type: 'toolCall', id: 'c1', name: 'screenshot', arguments: {} }]),
    { type: 'message', id: 'r1', parentId: 'a1', timestamp: '2026-01-01T00:00:03.000Z', message: { role: 'toolResult', toolCallId: 'c1', toolName: 'screenshot', content: [imageBlock()], isError: false } },
  ])
  const result = entries.find(entry => entry.kind === 'tool-result')
  assert.equal(result.usageChars, 4800)
  assert.equal(result.imageCount, 1)
})

test('the assistant message itself is not charged for images', () => {
  // pi 的 assistant 估算只看 text/thinking/toolCall，不看图片
  const entries = project([
    assistant('a1', null, [{ type: 'text', text: '喏' }, imageBlock()]),
  ])
  assert.equal(entries[0].usageChars, 0)
})

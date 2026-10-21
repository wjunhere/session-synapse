import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { contextUsageOf, dshEntryId, projectDshEvent, projectDshSession } from '../src/project/dsh.js'

/**
 * The fixtures are REAL DSH sessions, recorded by running `dsh headless` inside a
 * throwaway harness home (`DSH_HOME=<tmp>`) and reading the resulting log with
 * `scripts/dsh-session-events.mjs`. Nothing in them was written by hand.
 *
 *   - `dsh-session-events.json` — three turns: one bash tool call, one plain
 *     answer, one todo write. Also carries injected `user/message` context
 *     (`runtime-context`), two `session/title` events and one out-of-repo plugin
 *     event (`session-log-deepseek/delivery-accepted`).
 *   - `dsh-session-error.json` — a turn that died on an LLM auth failure:
 *     `assistant/attempt` + `turn/end` with `reason.kind === 'error'`.
 *   - `dsh-session-intercom.json` — a session that was CALLED by another one:
 *     `dsh-intercom` injected a relay (`user/message` with
 *     `source.kind === 'intercom'`, carrying the caller's session id), and the
 *     session answered it. Recorded the same way, through two sessions in one
 *     throwaway harness home.
 *
 * The extractor drops `system/message` and `request/header` (both ignored by the
 * projector and both carrying an environment snapshot) and rewrites the probe
 * workspace path to `/probe/workspace`.
 */
const real = JSON.parse(readFileSync(new URL('./fixtures/dsh-session-events.json', import.meta.url), 'utf8'))
const failed = JSON.parse(readFileSync(new URL('./fixtures/dsh-session-error.json', import.meta.url), 'utf8'))
const called = JSON.parse(readFileSync(new URL('./fixtures/dsh-session-intercom.json', import.meta.url), 'utf8'))

/** The pressure shape DSH's token meter projects; the ring must show these numbers. */
const pressure = { pressureTokens: 12_345, surfaceTokens: 12_000, contextWindow: 1_000_000, claim: { start: 0, end: 55, tokens: 12_345 } }

test('a real DSH session projects into the cards the canvas draws', () => {
  const session = projectDshSession(real, { contextPressure: pressure })
  assert.equal(session.header.id, 'session-1060d548-4d0b-458f-a801-5bd3d9322622')
  assert.equal(session.cwd, '/probe/workspace')
  assert.deepEqual(session.model, { provider: 'deepseek-official', id: 'deepseek-flash' })
  assert.equal(session.contextWindow, 1_000_000)
  assert.deepEqual(session.entries.map(entry => entry.kind), [
    'user', 'title', 'title',
    'tool-call', 'tool-result', 'assistant',
    'user', 'assistant',
    'user', 'tool-call', 'todo', 'tool-result', 'assistant',
  ])
  // A turn is named by the user entry that opened it, not by DSH's turn NUMBER:
  // the store and the canvas both key on entry ids.
  const firstUser = session.entries[0]
  assert.equal(firstUser.id, '00000008')
  const call = session.entries.find(entry => entry.kind === 'tool-call')
  const result = session.entries.find(entry => entry.kind === 'tool-result')
  assert.equal(call.turn, firstUser.id)
  assert.equal(result.turn, firstUser.id)
  assert.equal(call.callId, result.callId)
  assert.equal(call.step, 1)
  assert.match(call.arguments, /echo probe-fixture/)
  assert.match(result.text, /probe-fixture/)
})

test('injected context never becomes a card', () => {
  // DSH delivers its own snapshots as `user/message` with another source kind;
  // the human's prompt is the only one the canvas may show.
  const session = projectDshSession(real)
  const injected = real.filter(event => event.type === 'user/message' && event.data.source.kind !== 'user')
  assert.ok(injected.length > 0, 'fixture 应当带有注入的 user/message')
  assert.equal(session.entries.filter(entry => entry.kind === 'user').length, 3)
  for (const entry of session.entries) {
    assert.ok(!String(entry.text ?? '').startsWith('Current runtime context.'), '注入的 runtime-context 不能进卡片')
  }
})

test('entry ids are fixed width, so string order equals numeric order', () => {
  // The canvas resolves a fork's parent card with `sourceEntryId <= seedBoundary`
  // — a STRING comparison. Unpadded seq ids would make '100' < '12'.
  const session = projectDshSession(real)
  const ids = session.entries.map(entry => entry.id)
  for (const id of ids) assert.match(id, /^\d{8}(:|$)/)
  assert.deepEqual([...ids].sort(), ids)
  assert.deepEqual([...session.entries].sort((a, b) => a.order - b.order).map(entry => entry.id), ids)
})

test('timestamps become ISO strings, in event order', () => {
  const session = projectDshSession(real)
  const at = session.entries.map(entry => entry.at)
  for (const value of at) assert.ok(!Number.isNaN(Date.parse(value)), `不是可解析的时间: ${value}`)
  assert.deepEqual([...at].sort(), at)
})

test('a fork cut drops the inherited prefix and names its last entry', () => {
  // DSH reports the cut as an event COUNT; the store and the canvas need the ID
  // of the last inherited entry (an id, never a count — comparing the two is
  // false for every id).
  const cut = 32
  const session = projectDshSession(real, { inheritedEventCount: cut })
  assert.equal(session.inheritedEntryCount, dshEntryId(cut - 1))
  assert.equal(session.inheritedEntryCount, '00000031')
  // Everything before the cut is gone: the child's first card is the turn that
  // started after it (DSH cuts on a turn boundary).
  assert.deepEqual(session.entries.map(entry => entry.kind), ['user', 'assistant', 'user', 'tool-call', 'todo', 'tool-result', 'assistant'])
  assert.equal(session.entries[0].id, '00000032')
  for (const entry of session.entries) assert.ok(Number(entry.id.slice(0, 8)) >= cut)
})

test('an unseeded session reports no inherited prefix at all', () => {
  const session = projectDshSession(real)
  assert.equal(session.inheritedEntryCount, 0)
})

test('the ring shows the host’s own measurement', () => {
  const session = projectDshSession(real, { contextPressure: pressure })
  assert.deepEqual(session.contextUsage, {
    tokens: 12_345,
    contextWindow: 1_000_000,
    percent: 1.2345,
    estimated: false,
  })
  // Without a provider claim the meter is deriving the number, and the ring says so.
  const derived = contextUsageOf({ pressureTokens: 12_345, contextWindow: 1_000_000 }, 1_000_000)
  assert.equal(derived.estimated, true)
  // No window, no ring — rather than a ring against an unknown capacity.
  assert.equal(contextUsageOf({ surfaceTokens: 10 }, null), null)
  assert.equal(contextUsageOf(null, 1_000_000), null)
  // The window may arrive from the pressure projection even when the session's
  // own `request/context` never recorded one.
  assert.equal(contextUsageOf({ pressureTokens: 1, contextWindow: 4096 }, null).contextWindow, 4096)
})

test('a failed turn still answers its question', () => {
  // Without an error card the user's message looks unanswered forever (and the
  // canvas's pending-reply state would never settle). `assistant/attempt` — the
  // failed attempt record — adds no card of its own.
  const session = projectDshSession(failed)
  assert.deepEqual(session.entries.map(entry => entry.kind), ['user', 'title', 'error'])
  const error = session.entries[2]
  assert.equal(error.turn, session.entries[0].id)
  assert.match(error.text, /^AUTH: /)
  assert.match(error.text, /api key/)
  assert.ok(failed.some(event => event.type === 'assistant/attempt'), 'fixture 应当带有 assistant/attempt')
})

test('unknown events are ignored, not guessed at', () => {
  // Out-of-repo plugin events and DSH's own bookkeeping share the log with the
  // conversation; only the mapped types may produce entries.
  const session = projectDshSession(real)
  assert.ok(real.some(event => event.type === 'session-log-deepseek/delivery-accepted'))
  assert.ok(real.some(event => event.type === 'agent/inbox/spliced'))
  assert.equal(session.entries.some(entry => entry.kind === 'delivery-accepted'), false)
  assert.deepEqual(projectDshEvent({ type: 'some/plugin-event', seq: 1, time: 0, data: {} }, { turnEntryId: null, model: null, contextWindow: null }), [])
})

test('a call from another session becomes a card that owns the turn it opened', () => {
  // `dsh-intercom` delivers a peer's message as a `user/message` whose source
  // kind is `intercom`. That IS a turn — the human is not the only one who can
  // start one — so it becomes a `call` card carrying the caller's session id.
  //
  // It must also set the turn anchor. The canvas groups a turn as "everything
  // after a turn-opening entry", so a relay that left the anchor alone would
  // glue the answer to the PREVIOUS card and overwrite that card's answer.
  const session = projectDshSession(called)
  const relays = called.filter(event => event.type === 'user/message' && event.data.source.kind === 'intercom')
  const prompts = called.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')
  assert.ok(relays.length > 0, 'fixture 应当带有 intercom relay')
  assert.equal(session.entries.filter(entry => entry.kind === 'call').length, relays.length)
  // Every OTHER injected kind is still not a card: the relay is the exception,
  // not a hole in the filter.
  assert.equal(session.entries.filter(entry => entry.kind === 'user').length, prompts.length)

  const call = session.entries.find(entry => entry.kind === 'call')
  assert.match(call.from, /^session-[0-9a-f-]+$/)
  assert.equal(call.from, relays[0].data.source.senderSessionId)
  // The relay body is kept verbatim — it carries the caller header and the
  // reply hint, which is exactly what the detail view should show.
  assert.match(call.text, /intercom/)
  const answered = session.entries.filter(entry => entry.kind === 'assistant' && entry.turn === call.id)
  assert.ok(answered.length > 0, 'relay 之后的回答必须挂在这条 call 上，而不是上一张卡')
})

test('a relay with no sender is still a card, with no caller to name', () => {
  // Every observed relay carries `senderSessionId`; a log that lacks it must not
  // invent a caller. The card then says 未知会话 instead of pointing nowhere.
  const state = { turnEntryId: null, model: null, contextWindow: null }
  const entries = projectDshEvent({
    type: 'user/message',
    seq: 7,
    time: 1_700_000_000_000,
    data: { content: [{ type: 'text', text: '来自别处的呼叫' }], source: { kind: 'intercom', form: 'relay' } },
  }, state)
  assert.deepEqual(entries.map(entry => entry.kind), ['call'])
  assert.equal(entries[0].from, null)
  assert.equal(state.turnEntryId, '00000007')
})

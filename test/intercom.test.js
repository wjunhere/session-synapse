import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CALL_EXCERPT_LIMIT, CALL_NOTE_LIMIT, isSessionRow, rosterTargets, resolveSender, callMessageBody, callCardLabel, senderLabel } from '../src/canvas/intercom.js'

/**
 * The card-to-card call decides three things that no browser check can pin
 * down: who may be a target, who may speak, and exactly what text leaves the
 * canvas. All three are pure functions of a roster and a card, which is why
 * they are tested here.
 *
 * The roster literals below are shaped after a real `/intercom/roster` answer:
 * a mix of `session-<uuid>` rows (canvas sessions) and bare-uuid rows (Agent
 * Teams teammates and subagents, which have no card on the map at all), with
 * Windows-style cwds while the workspace carries the same directory with
 * forward slashes.
 */

const ROSTER = {
  enabled: true,
  transport: 'broker',
  sessions: [
    { id: 'session-aaaa1111-1111-1111-1111-111111111111', prefix: 'aaaa1111', name: null, cwd: 'B:\\work\\proj', status: 'idle', local: true },
    { id: 'ebf35e22-7a20-428d-9b42-9c7ab87c02d4', prefix: 'ebf35e22', name: null, cwd: 'B:\\work\\proj', status: 'thinking', local: true },
    { id: 'session-bbbb2222-2222-2222-2222-222222222222', prefix: 'bbbb2222', name: '画布助手', cwd: 'B:\\work\\other', status: 'thinking', local: true },
    { id: 'session-cccc3333-3333-3333-3333-333333333333', prefix: 'cccc3333', name: null, cwd: '/home/user/projects/other', status: 'idle', local: false },
    { id: 'not-a-session', prefix: 'notasess', name: null, cwd: '', status: 'idle', local: true },
  ],
  senders: [
    { id: 'session-aaaa1111-1111-1111-1111-111111111111', name: null },
    { id: 'efc66b60-b464-444e-afd5-56f60c04fef9', name: null },
  ],
}

test('a canvas session id is one with the session- prefix', () => {
  assert.equal(isSessionRow('session-aaaa1111-1111-1111-1111-111111111111'), true)
  assert.equal(isSessionRow('session-ABC'), true)
  // Teammates and subagents are reachable over intercom but have no card here.
  assert.equal(isSessionRow('ebf35e22-7a20-428d-9b42-9c7ab87c02d4'), false)
  assert.equal(isSessionRow('session-'), false)
  assert.equal(isSessionRow(''), false)
  assert.equal(isSessionRow(null), false)
  assert.equal(isSessionRow(42), false)
})

test('a roster row is labelled by its alias, else by its id', () => {
  assert.equal(senderLabel({ id: 'session-aaaa1111-1111-1111-1111-111111111111', name: '画布助手' }), '画布助手')
  assert.equal(senderLabel({ id: 'session-aaaa1111-1111-1111-1111-111111111111', name: null }), 'aaaa1111')
  assert.equal(senderLabel({ id: 'ebf35e22-7a20-428d-9b42-9c7ab87c02d4', name: '   ' }), 'ebf35e22')
  assert.equal(senderLabel({ id: 'session-aaaa1111-1111-1111-1111-111111111111', name: '  spaced  ' }), 'spaced')
  assert.equal(senderLabel(null), '')
})

test('targets exclude the speaker, exclude non-sessions, and lead with the same cwd', () => {
  const self = 'session-aaaa1111-1111-1111-1111-111111111111'
  const targets = rosterTargets(ROSTER, { selfId: self, cwd: 'B:/work/proj/' })
  assert.deepEqual(targets.map(target => target.id), [
    'session-bbbb2222-2222-2222-2222-222222222222',
    'session-cccc3333-3333-3333-3333-333333333333',
  ])
  // The speaker is never a target (the host rejects from === to), the bare-uuid
  // teammate row is not offered, and `not-a-session` is not a session at all.
  assert.equal(targets.some(target => target.id === self), false)
  assert.equal(targets.some(target => target.id === 'ebf35e22-7a20-428d-9b42-9c7ab87c02d4'), false)
  assert.equal(targets.some(target => target.id === 'not-a-session'), false)
  assert.equal(targets[0].label, '画布助手')
  assert.equal(targets[0].status, 'thinking')
  assert.equal(targets[0].cwd, 'B:\\work\\other')
  // With the same-cwd row no longer excluded it leads the list: the roster
  // reports backslashes, the workspace carries forward slashes, and both name
  // the same place.
  const ordered = rosterTargets(ROSTER, { selfId: 'session-9999', cwd: 'b:\\work\\proj' })
  assert.deepEqual(ordered.map(target => target.id), [self, 'session-bbbb2222-2222-2222-2222-222222222222', 'session-cccc3333-3333-3333-3333-333333333333'])
  assert.deepEqual(ordered.map(target => target.sameCwd), [true, false, false])
})

test('a target in the same working directory sorts first, ties keeping roster order', () => {
  const roster = {
    sessions: [
      { id: 'session-1111', cwd: '/elsewhere', status: 'idle' },
      { id: 'session-2222', cwd: 'B:\\work\\here', status: 'idle' },
      { id: 'session-3333', cwd: '/work/here/', status: 'idle' },
      { id: 'session-4444', cwd: 'b:\\WORK\\HERE', status: 'idle' },
    ],
  }
  // Windows against Windows: backslashes and case are not differences.
  const windows = rosterTargets(roster, { selfId: null, cwd: 'B:/work/here' })
  assert.deepEqual(windows.map(target => target.id), ['session-2222', 'session-4444', 'session-1111', 'session-3333'])
  assert.deepEqual(windows.map(target => target.sameCwd), [true, true, false, false])
  // A trailing slash is not a different directory either. A drive-letter path
  // and a POSIX one ARE different, even when they end in the same segments —
  // pretending otherwise would lead the list with a session elsewhere.
  const posix = rosterTargets(roster, { selfId: null, cwd: '/work/here' })
  assert.deepEqual(posix.map(target => target.id), ['session-3333', 'session-1111', 'session-2222', 'session-4444'])
  assert.deepEqual(posix.map(target => target.sameCwd), [true, false, false, false])
})

test('no roster means no targets, not a crash', () => {
  assert.deepEqual(rosterTargets(null), [])
  assert.deepEqual(rosterTargets(undefined, { selfId: 'session-1111' }), [])
  assert.deepEqual(rosterTargets({ sessions: null }), [])
  // An unknown cwd can never make a row "same directory".
  assert.deepEqual(rosterTargets({ sessions: [{ id: 'session-1111', cwd: '' }] }, { cwd: null }).map(target => target.sameCwd), [false])
})

test('the speaker is the card session when the host accepts it, else the current session', () => {
  const card = 'session-aaaa1111-1111-1111-1111-111111111111'
  assert.deepEqual(resolveSender(ROSTER, { cardSessionId: card, currentSessionId: 'session-other' }), { id: card, fallback: false })
  // The card's own session is not hosted by this process: the call can still be
  // made, but as somebody else — and the caller is told which.
  assert.deepEqual(resolveSender(ROSTER, { cardSessionId: 'session-9999', currentSessionId: card }), { id: card, fallback: true })
  assert.deepEqual(resolveSender(ROSTER, { cardSessionId: null, currentSessionId: 'session-aaaa1111-1111-1111-1111-111111111111' }), { id: card, fallback: true })
})

test('no hosted session at all means no speaker, and then no call', () => {
  assert.equal(resolveSender(ROSTER, { cardSessionId: 'session-9999', currentSessionId: 'session-8888' }), null)
  assert.equal(resolveSender(ROSTER), null)
  assert.equal(resolveSender(null, { currentSessionId: 'session-aaaa1111-1111-1111-1111-111111111111' }), null)
  assert.equal(resolveSender({ senders: [] }, { cardSessionId: 'session-aaaa1111-1111-1111-1111-111111111111' }), null)
})

test('the message names the card, its session and its anchor', () => {
  const body = callMessageBody({
    title: '把画布接进 pi-web',
    cwd: 'B:\\work\\proj',
    question: '这张卡片的答案在别的会话里有上下文吗？',
    answer: '有，另一个会话刚刚在看投影的放行规则。',
    note: '请把相关的两份结论一起看。',
    sessionId: 'session-aaaa1111-1111-1111-1111-111111111111',
    seq: '927f88e9',
  })
  assert.match(body, /【呼叫】来自会话「把画布接进 pi-web」的一张卡片/)
  assert.match(body, /工作目录：B:\\work\\proj/)
  assert.match(body, /来源：session-aaaa1111-1111-1111-1111-111111111111 · 卡片锚点 927f88e9/)
  assert.match(body, /问题：\n这张卡片的答案在别的会话里有上下文吗？/)
  assert.match(body, /已经给出的回答（摘录）：\n有，另一个会话刚刚在看投影的放行规则。/)
  assert.match(body, /附言：\n请把相关的两份结论一起看。/)
})

test('the same card and note always produce the same text', () => {
  const input = { title: 'T', cwd: '/w', question: 'Q', answer: 'A', note: 'N', sessionId: 'session-1111', seq: 'ab12cd34' }
  assert.equal(callMessageBody(input), callMessageBody({ ...input }))
})

test('every section is cut at its own limit, with a visible marker', () => {
  const question = 'q'.repeat(CALL_EXCERPT_LIMIT + 40)
  const answer = 'a'.repeat(CALL_EXCERPT_LIMIT + 40)
  const note = 'n'.repeat(CALL_NOTE_LIMIT + 40)
  const body = callMessageBody({ title: 'T', question, answer, note, sessionId: 'session-1111', seq: 'ab12cd34' })
  assert.equal(body.includes('q'.repeat(CALL_EXCERPT_LIMIT + 1)), false)
  assert.equal(body.includes('a'.repeat(CALL_EXCERPT_LIMIT + 1)), false)
  assert.equal(body.includes('n'.repeat(CALL_NOTE_LIMIT + 1)), false)
  assert.equal(body.includes(`${'q'.repeat(CALL_EXCERPT_LIMIT)}…`), true)
  assert.equal(body.includes(`${'a'.repeat(CALL_EXCERPT_LIMIT)}…`), true)
  assert.equal(body.includes(`${'n'.repeat(CALL_NOTE_LIMIT)}…`), true)
  // A limit is content, not content-plus-marker: the marker is what tells the
  // reader the card was cut off rather than ended there.
  const exact = callMessageBody({ question: 'q'.repeat(CALL_EXCERPT_LIMIT) })
  assert.equal(exact.includes('…'), false)
})

test('empty sections are omitted instead of padded', () => {
  const body = callMessageBody({ title: 'T', question: 'Q', sessionId: 'session-1111' })
  assert.equal(body.includes('已经给出的回答'), false)
  assert.equal(body.includes('附言'), false)
  assert.equal(body.includes('卡片锚点'), false)
  // Whitespace is not content.
  const blank = callMessageBody({ title: '   ', cwd: '  ', question: '\n\n', answer: ' ', note: '\t', sessionId: '', seq: '' })
  assert.match(blank, /来自会话「未命名会话」/)
  assert.match(blank, /工作目录：未知工作目录/)
  assert.match(blank, /来源：未知会话/)
  assert.equal(blank.includes('问题：'), false)
  assert.equal(callMessageBody().includes('【呼叫】'), true)
})

test('a received call names its sender, or admits it does not know', () => {
  const threads = [
    { sessionId: 'session-aaaa1111-1111-1111-1111-111111111111', sessionTitle: '把画布接进 pi-web', title: '旧标题' },
    { sessionId: 'session-bbbb2222-2222-2222-2222-222222222222', title: '只有 title 的会话' },
  ]
  assert.equal(callCardLabel('session-aaaa1111-1111-1111-1111-111111111111', threads), '来自「把画布接进 pi-web」')
  assert.equal(callCardLabel('session-bbbb2222-2222-2222-2222-222222222222', threads), '来自「只有 title 的会话」')
  // A sender from another working directory (or one that aged out): the card
  // still names the id prefix rather than claiming to be from nowhere.
  assert.equal(callCardLabel('session-cccc3333-3333-3333-3333-333333333333', threads), '来自「cccc3333」')
  assert.equal(callCardLabel(null, threads), '来自未知会话')
  assert.equal(callCardLabel('', threads), '来自未知会话')
  assert.equal(callCardLabel(undefined, null), '来自未知会话')
})

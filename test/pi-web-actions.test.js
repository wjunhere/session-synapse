import { test } from 'node:test'
import assert from 'node:assert/strict'
import { capabilities } from '../src/adapters/contract.js'
import { createPiWebActions, HostRequestError } from '../src/adapters/pi-web-actions.js'

/** A fetch stub that records calls and replays scripted responses. */
function stubFetch(responses = []) {
  const calls = []
  const queue = [...responses]
  const impl = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ?? null, headers: init?.headers ?? {} })
    const next = queue.shift() ?? { status: 200, body: {} }
    return {
      ok: next.status === undefined || (next.status >= 200 && next.status < 300),
      status: next.status ?? 200,
      json: async () => next.body ?? {},
    }
  }
  return { impl, calls }
}

test('capabilities default to false and accept overrides', () => {
  const base = capabilities()
  assert.equal(base.sendMessage, false)
  assert.equal(base.renameSession, false)
  assert.equal(base.archiveSession, false)
  assert.equal(capabilities({ renameSession: true }).renameSession, true)
  // An override must not disturb the other flags.
  assert.equal(capabilities({ renameSession: true }).sendMessage, false)
})

test('rename PATCHes the session with the trimmed name', async () => {
  const { impl, calls } = stubFetch([{ status: 200, body: { ok: true } }])
  const actions = createPiWebActions({ fetch: impl })
  await actions.renameSession('sess-1', '  新名字  ')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/api/sessions/sess-1')
  assert.equal(calls[0].method, 'PATCH')
  assert.deepEqual(JSON.parse(calls[0].body), { name: '新名字' })
})

test('rename rejects an empty name without calling the host', async () => {
  const { impl, calls } = stubFetch()
  const actions = createPiWebActions({ fetch: impl })
  await assert.rejects(() => actions.renameSession('sess-1', '   '), HostRequestError)
  assert.equal(calls.length, 0)
})

test('archive uses action:set for both directions', async () => {
  // `restore` is a different request (an exact prior-values snapshot for undo),
  // so unarchiving must also be `set` with archived:false.
  const { impl, calls } = stubFetch([{ status: 200, body: { state: {} } }, { status: 200, body: { state: {} } }])
  const actions = createPiWebActions({ fetch: impl })
  await actions.archiveSession('sess-1', true)
  await actions.archiveSession('sess-1', false)
  assert.deepEqual(JSON.parse(calls[0].body), { action: 'set', ids: ['sess-1'], archived: true })
  assert.deepEqual(JSON.parse(calls[1].body), { action: 'set', ids: ['sess-1'], archived: false })
})

test('sendMessage queues while the session is streaming', async () => {
  // A streaming session rejects a plain prompt, so `streamingBehavior` must be
  // added or the message is lost.
  const { impl, calls } = stubFetch([
    { status: 200, body: { running: true, state: { isStreaming: true } } },
    { status: 200, body: { success: true } },
  ])
  const actions = createPiWebActions({ fetch: impl })
  await actions.sendMessage('sess-1', '继续')
  const prompt = JSON.parse(calls[1].body)
  assert.equal(prompt.type, 'prompt')
  assert.equal(prompt.message, '继续')
  assert.equal(prompt.streamingBehavior, 'followUp')
})

test('sendMessage omits streamingBehavior when the session is idle', async () => {
  const { impl, calls } = stubFetch([
    { status: 200, body: { running: false, state: { isStreaming: false } } },
    { status: 200, body: { success: true } },
  ])
  const actions = createPiWebActions({ fetch: impl })
  await actions.sendMessage('sess-1', '你好')
  assert.equal('streamingBehavior' in JSON.parse(calls[1].body), false)
})

test('a host refusal surfaces its own message', async () => {
  const { impl } = stubFetch([{ status: 400, body: { error: { message: '名称过长' } } }])
  const actions = createPiWebActions({ fetch: impl })
  await assert.rejects(() => actions.renameSession('sess-1', 'x'.repeat(500)), /名称过长/)
})

test('fork returns the new session id and rejects a malformed reply', async () => {
  const ok = stubFetch([{ status: 200, body: { sessionId: 'new-1' } }])
  assert.equal(await createPiWebActions({ fetch: ok.impl }).forkSession('sess-1'), 'new-1')

  const bad = stubFetch([{ status: 200, body: {} }])
  await assert.rejects(() => createPiWebActions({ fetch: bad.impl }).forkSession('sess-1'), HostRequestError)
})

test('openSession navigates instead of fetching', async () => {
  const seen = []
  const actions = createPiWebActions({ navigate: id => seen.push(id) })
  await actions.openSession('sess-9')
  assert.deepEqual(seen, ['sess-9'])
})

test('every advertised capability has an implementation', () => {
  // The declaration and the implementation must not drift: a capability is
  // advertised exactly when the function exists.
  const actions = createPiWebActions({ fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) })
  for (const [name, supported] of Object.entries(actions.capabilities())) {
    assert.equal(supported, typeof actions[name] === 'function', `${name} capability does not match its implementation`)
  }
})
test('set_tools posts the pinned loadout for one session', async () => {
  const { impl, calls } = stubFetch([{ status: 200, body: { success: true, data: {} } }])
  const actions = createPiWebActions({ fetch: impl })
  await actions.setTools('sess-2', ['read', 'grep'])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/api/agent/sess-2')
  assert.equal(calls[0].method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].body), { type: 'set_tools', toolNames: ['read', 'grep'] })
})

test('btw forks, pins read-only tools, then archives — in that order', async () => {
  // The order is the contract: set_tools is per-session state and cannot be
  // applied before the fork exists; archiving must not precede the pin either,
  // or pi-web could hide the session mid-setup.
  const { impl, calls } = stubFetch([
    { status: 200, body: { sessionId: 'forked-1' } },
    { status: 200, body: { success: true, data: {} } },
    { status: 200, body: { success: true } },
  ])
  const actions = createPiWebActions({ fetch: impl })
  const result = await actions.btw('source-1')
  assert.deepEqual(result, { sessionId: 'forked-1', tools: ['read', 'grep', 'find', 'ls'], archived: true })
  assert.equal(calls[0].url, '/api/sessions/source-1/fork')
  assert.equal(calls[1].url, '/api/agent/forked-1')
  assert.deepEqual(JSON.parse(calls[1].body), { type: 'set_tools', toolNames: ['read', 'grep', 'find', 'ls'] })
  assert.equal(calls[2].url, '/api/sessions/ui-state')
  assert.deepEqual(JSON.parse(calls[2].body), { action: 'set', ids: ['forked-1'], archived: true })
})

test('btw keeps the side thread when archiving fails', async () => {
  // Archiving only tidies pi-web's main list. A side question that could not be
  // archived is still a working side question, so it must not be reported as a
  // failure — the card would vanish for no good reason.
  const { impl } = stubFetch([
    { status: 200, body: { sessionId: 'forked-2' } },
    { status: 200, body: { success: true, data: {} } },
    { status: 500, body: { error: 'ui-state unavailable' } },
  ])
  const actions = createPiWebActions({ fetch: impl })
  const result = await actions.btw('source-2')
  assert.equal(result.sessionId, 'forked-2')
  assert.equal(result.archived, false)
})

test('btw honours a custom tool list', async () => {
  const { impl, calls } = stubFetch([
    { status: 200, body: { sessionId: 'forked-3' } },
    { status: 200, body: { success: true, data: {} } },
    { status: 200, body: { success: true } },
  ])
  const actions = createPiWebActions({ fetch: impl })
  await actions.btw('source-3', { tools: ['read'] })
  assert.deepEqual(JSON.parse(calls[1].body).toolNames, ['read'])
})

test('btw rejects a missing session id before forking', async () => {
  const { impl, calls } = stubFetch([])
  const actions = createPiWebActions({ fetch: impl })
  await assert.rejects(() => actions.btw(''), HostRequestError)
  assert.equal(calls.length, 0)
})

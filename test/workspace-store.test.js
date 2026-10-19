import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceStore, normalizeState } from '../src/store/workspace-store.js'

async function withStore(run) {
  const dir = await mkdtemp(join(tmpdir(), 'synapse-store-'))
  try {
    await run(join(dir, 'workspaces.json'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('a fresh store starts empty and persists', async () => {
  await withStore(async dataFile => {
    const store = new WorkspaceStore(dataFile)
    assert.deepEqual(await store.list(), [])
    const workspace = await store.create('我的工作区')
    assert.equal(workspace.title, '我的工作区')
    const reopened = new WorkspaceStore(dataFile)
    const list = await reopened.list()
    assert.equal(list.length, 1)
    assert.equal(list[0].title, '我的工作区')
  })
})

test('projecting a session groups it by cwd and builds cards', async () => {
  await withStore(async dataFile => {
    const store = new WorkspaceStore(dataFile)
    await store.projectSession({
      id: 'sess-1',
      cwd: 'B:\\proj\\demo',
      filePath: 'B:\\proj\\demo\\a.jsonl',
      parentSessionFile: null,
      title: null,
      inheritedEntryCount: 0,
      entries: [
        { id: 'e1', order: 0, kind: 'user', text: '第一个问题', at: '2026-01-01T00:00:01.000Z' },
        { id: 'e2', order: 1, kind: 'assistant', text: '回答', at: '2026-01-01T00:00:02.000Z' },
        { id: 'e3', order: 2, kind: 'tool-call', callId: 'c1', name: 'bash', arguments: 'ls', at: '2026-01-01T00:00:03.000Z' },
        { id: 'e4', order: 3, kind: 'tool-result', callId: 'c1', name: 'bash', text: 'file.txt', at: '2026-01-01T00:00:04.000Z' },
      ],
    })
    const list = await store.list()
    assert.equal(list.length, 1)
    assert.equal(list[0].title, 'demo')
    assert.equal(list[0].kind, 'projection')
    const workspace = await store.get(list[0].id)
    assert.equal(workspace.threads.length, 1)
    const messages = workspace.threads[0].messages
    assert.deepEqual(messages.map(m => m.kind), ['user', 'assistant'])
    // The tool call folded into the assistant card rather than becoming a card.
    assert.equal(messages[1].process.length, 1)
    assert.equal(messages[1].process[0].name, 'bash')
    assert.equal(messages[1].process[0].result, 'file.txt')
  })
})

test('repeated projection does not duplicate cards', async () => {
  await withStore(async dataFile => {
    const store = new WorkspaceStore(dataFile)
    const session = {
      id: 'sess-1', cwd: '/tmp/p', filePath: '/tmp/p/a.jsonl', parentSessionFile: null, title: null, inheritedEntryCount: 0,
      entries: [{ id: 'e1', order: 0, kind: 'user', text: 'q', at: '2026-01-01T00:00:01.000Z' }],
    }
    await store.projectSession(session)
    await store.projectSession(session)
    const list = await store.list()
    const workspace = await store.get(list[0].id)
    assert.equal(workspace.threads[0].messages.length, 1)
  })
})

test('the workspace list says which sessions live in each workspace', async () => {
  // The canvas uses this to follow the host's current session across directories
  // without loading every workspace: one session, one workspace, one lookup.
  await withStore(async dataFile => {
    const store = new WorkspaceStore(dataFile)
    const project = (id, cwd) => store.projectSession({
      id, cwd, filePath: `${cwd}/${id}.jsonl`, parentSessionFile: null, title: null, inheritedEntryCount: 0,
      entries: [{ id: 'e1', order: 0, kind: 'user', text: 'q', at: '2026-01-01T00:00:01.000Z' }],
    })
    await project('sess-a', '/tmp/a')
    await project('sess-b', '/tmp/b')
    await project('sess-a2', '/tmp/a')
    const byCwd = new Map((await store.list()).map(workspace => [workspace.cwd, [...workspace.sessionIds].sort()]))
    assert.deepEqual(byCwd.get('/tmp/a'), ['sess-a', 'sess-a2'])
    assert.deepEqual(byCwd.get('/tmp/b'), ['sess-b'])
  })
})

test('a fork links to its parent through parentSessionFile', async () => {
  await withStore(async dataFile => {
    const store = new WorkspaceStore(dataFile)
    await store.projectSession({
      id: 'parent', cwd: '/tmp/p', filePath: '/tmp/p/parent.jsonl', parentSessionFile: null, title: '父会话', inheritedEntryCount: 0,
      entries: [{ id: 'e1', order: 0, kind: 'user', text: 'q', at: '2026-01-01T00:00:01.000Z' }],
    })
    await store.projectSession({
      id: 'child', cwd: '/tmp/p', filePath: '/tmp/p/child.jsonl', parentSessionFile: '/tmp/p/parent.jsonl', title: '子会话', inheritedEntryCount: 0,
      entries: [{ id: 'f1', order: 0, kind: 'user', text: 'forked q', at: '2026-01-01T00:00:05.000Z' }],
    })
    const list = await store.list()
    const workspace = await store.get(list[0].id)
    const parent = workspace.threads.find(t => t.sessionId === 'parent')
    const child = workspace.threads.find(t => t.sessionId === 'child')
    assert.equal(child.parentId, parent.id)
  })
})

test('a child projected before its parent is repaired afterwards', async () => {
  await withStore(async dataFile => {
    const store = new WorkspaceStore(dataFile)
    await store.projectSession({
      id: 'child', cwd: '/tmp/p', filePath: '/tmp/p/child.jsonl', parentSessionFile: '/tmp/p/parent.jsonl', title: '子会话', inheritedEntryCount: 0,
      entries: [{ id: 'f1', order: 0, kind: 'user', text: 'q', at: '2026-01-01T00:00:05.000Z' }],
    })
    await store.projectSession({
      id: 'parent', cwd: '/tmp/p', filePath: '/tmp/p/parent.jsonl', parentSessionFile: null, title: '父会话', inheritedEntryCount: 0,
      entries: [{ id: 'e1', order: 0, kind: 'user', text: 'q', at: '2026-01-01T00:00:01.000Z' }],
    })
    const list = await store.list()
    const workspace = await store.get(list[0].id)
    const parent = workspace.threads.find(t => t.sessionId === 'parent')
    const child = workspace.threads.find(t => t.sessionId === 'child')
    assert.equal(child.parentId, parent.id)
  })
})

test('an archived session is not recreated by a later projection', async () => {
  await withStore(async dataFile => {
    const store = new WorkspaceStore(dataFile)
    const session = {
      id: 'sess-1', cwd: '/tmp/p', filePath: '/tmp/p/a.jsonl', parentSessionFile: null, title: null, inheritedEntryCount: 0,
      entries: [{ id: 'e1', order: 0, kind: 'user', text: 'q', at: '2026-01-01T00:00:01.000Z' }],
    }
    await store.projectSession(session)
    const list = await store.list()
    const workspace = await store.get(list[0].id)
    await store.removeThread(workspace.threads[0].id)
    await store.projectSession(session)
    assert.deepEqual(await store.list(), [])
  })
})

test('tool calls fold across a multi-step turn', async () => {
  // A turn is often several assistant entries (one per tool round) and only the
  // last carries prose. Calls made before any assistant message exists wait in
  // `pendingProcess` and are claimed by the assistant message that follows.
  await withStore(async dataFile => {
    const store = new WorkspaceStore(dataFile)
    await store.projectSession({
      id: 's', cwd: '/tmp/p', filePath: '/tmp/p/a.jsonl', parentSessionFile: null, title: null, inheritedEntryCount: 0,
      entries: [
        { id: 'u1', order: 0, kind: 'user', text: 'do it', at: '2026-01-01T00:00:01.000Z' },
        { id: 'c1', order: 1, kind: 'tool-call', callId: 'k1', name: 'read', arguments: '{}', at: '2026-01-01T00:00:02.000Z' },
        { id: 'r1', order: 2, kind: 'tool-result', callId: 'k1', name: 'read', text: 'contents', at: '2026-01-01T00:00:03.000Z' },
        { id: 'c2', order: 3, kind: 'tool-call', callId: 'k2', name: 'bash', arguments: '{}', at: '2026-01-01T00:00:04.000Z' },
        { id: 'r2', order: 4, kind: 'tool-result', callId: 'k2', name: 'bash', text: 'ok', at: '2026-01-01T00:00:05.000Z' },
        { id: 'a1', order: 5, kind: 'assistant', text: 'done', at: '2026-01-01T00:00:06.000Z' },
      ],
    })
    const list = await store.list()
    const workspace = await store.get(list[0].id)
    const thread = workspace.threads[0]
    assert.equal(thread.messages.length, 2, 'one user card and one assistant reply')
    const answer = thread.messages[1]
    assert.equal(answer.kind, 'assistant')
    assert.equal(answer.process.length, 2, 'both tool rounds landed on the answer')
    assert.deepEqual(answer.process.map(p => p.name), ['read', 'bash'])
    assert.deepEqual(answer.process.map(p => p.result), ['contents', 'ok'])
    assert.equal(thread.pendingProcess.length, 0, 'nothing stranded')
  })
})

test('a second turn starts its own pending list', async () => {
  await withStore(async dataFile => {
    const store = new WorkspaceStore(dataFile)
    await store.projectSession({
      id: 's', cwd: '/tmp/p', filePath: '/tmp/p/a.jsonl', parentSessionFile: null, title: null, inheritedEntryCount: 0,
      entries: [
        { id: 'u1', order: 0, kind: 'user', text: 'q1', at: '2026-01-01T00:00:01.000Z' },
        { id: 'a1', order: 1, kind: 'assistant', text: 'a1', at: '2026-01-01T00:00:02.000Z' },
        { id: 'c1', order: 2, kind: 'tool-call', callId: 'k1', name: 'read', arguments: '{}', at: '2026-01-01T00:00:03.000Z' },
        { id: 'u2', order: 3, kind: 'user', text: 'q2', at: '2026-01-01T00:00:04.000Z' },
        { id: 'a2', order: 4, kind: 'assistant', text: 'a2', at: '2026-01-01T00:00:05.000Z' },
      ],
    })
    const list = await store.list()
    const workspace = await store.get(list[0].id)
    const messages = workspace.threads[0].messages
    // The call made before q2 attaches to the most recent assistant message,
    // which is still a1's turn boundary; a2 must not inherit it.
    const a1 = messages.find(m => m.text === 'a1')
    const a2 = messages.find(m => m.text === 'a2')
    assert.equal(a1.process.length, 1)
    assert.equal(a2.process.length, 0)
  })
})

test('long replies are truncated with a marker', async () => {
  await withStore(async dataFile => {
    const store = new WorkspaceStore(dataFile)
    const long = 'x'.repeat(9_000)
    await store.projectSession({
      id: 's', cwd: '/tmp/p', filePath: '/tmp/p/a.jsonl', parentSessionFile: null, title: null, inheritedEntryCount: 0,
      entries: [{ id: 'e1', order: 0, kind: 'assistant', text: long, at: '2026-01-01T00:00:01.000Z' }],
    })
    const list = await store.list()
    const workspace = await store.get(list[0].id)
    const text = workspace.threads[0].messages[0].text
    assert.ok(text.length < long.length)
    assert.ok(text.includes('详情查看全文'))
  })
})

test('legacy v4 dsh data migrates to the neutral schema', () => {
  const legacy = {
    version: 4,
    hiddenSessionIds: ['gone'],
    workspaces: [{
      id: 'w1', kind: 'dsh', cwd: '/tmp/p', title: 'p',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      threads: [{
        id: 't1', title: 't', parentId: null, dshSessionId: 'sess-1', dshSessionTitle: 'st',
        sourceParentSessionId: null, sourceSeedLength: null, color: '#0f766e', position: { x: 0, y: 0 },
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        messages: [{ id: 'm1', text: 'hi', kind: 'user', at: '2026-01-01T00:00:01.000Z' }],
        pendingProcess: [],
      }],
    }],
  }
  const { state, migrated } = normalizeState(legacy)
  assert.equal(migrated, true)
  assert.equal(state.workspaces[0].kind, 'projection')
  assert.equal(state.workspaces[0].threads[0].sessionId, 'sess-1')
  assert.equal(state.workspaces[0].threads[0].sessionTitle, 'st')
  assert.equal(state.workspaces[0].threads[0].dshSessionId, undefined)
})

test('a v1 store migrates its events into a thread', () => {
  const { state, migrated } = normalizeState({
    version: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    workspaces: [{ id: 'w1', title: '旧空间', events: [{ id: 'e1', text: 'note', at: '2026-01-01T00:00:01.000Z' }] }],
  })
  assert.equal(migrated, true)
  assert.equal(state.workspaces[0].threads.length, 1)
  assert.equal(state.workspaces[0].threads[0].messages[0].text, 'note')
})

test('an unreadable data file fails loudly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'synapse-store-'))
  try {
    const dataFile = join(dir, 'workspaces.json')
    await writeFile(dataFile, 'not json', 'utf8')
    const store = new WorkspaceStore(dataFile)
    await assert.rejects(() => store.list(), /cannot read/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
test('a session with a known window gets a context figure', async () => {
  await withStore(async dataFile => {
    const store = new WorkspaceStore(dataFile)
    await store.projectSession({
      id: 'sess-ctx', cwd: '/tmp/ctx', filePath: '/tmp/ctx/a.jsonl', parentSessionFile: null, title: null, inheritedEntryCount: 0,
      contextWindow: 1000,
      entries: [
        { id: 'e1', order: 0, kind: 'user', text: 'q', at: '2026-01-01T00:00:01.000Z' },
        { id: 'e2', order: 1, kind: 'assistant', text: 'answer', at: '2026-01-01T00:00:02.000Z', usage: { input: 400, output: 10 } },
      ],
    })
    const workspace = await store.get((await store.list())[0].id)
    assert.equal(workspace.threads[0].contextUsage.tokens, 410)
    assert.equal(workspace.threads[0].contextUsage.contextWindow, 1000)
    assert.equal(workspace.threads[0].contextUsage.percent, 41)
  })
})

test('no context window means no context figure, not a wrong one', async () => {
  // Drawing a ring from an unknown denominator would be a fabrication; the
  // field stays absent so the UI omits it.
  await withStore(async dataFile => {
    const store = new WorkspaceStore(dataFile)
    await store.projectSession({
      id: 'sess-nowin', cwd: '/tmp/nowin', filePath: '/tmp/nowin/a.jsonl', parentSessionFile: null, title: null, inheritedEntryCount: 0,
      contextWindow: null,
      entries: [{ id: 'e1', order: 0, kind: 'assistant', text: 'a', at: '2026-01-01T00:00:01.000Z', usage: { input: 400, output: 10 } }],
    })
    const workspace = await store.get((await store.list())[0].id)
    assert.equal(workspace.threads[0].contextUsage, null)
  })
})

test('a tool-selection entry pins the thread tools and clears on retraction', async () => {
  await withStore(async dataFile => {
    const store = new WorkspaceStore(dataFile)
    const session = id => ({
      id, cwd: '/tmp/tools', filePath: `/tmp/tools/${id}.jsonl`, parentSessionFile: null, title: null, inheritedEntryCount: 0,
      contextWindow: null,
      entries: [
        { id: 'e1', order: 0, kind: 'user', text: 'q', at: '2026-01-01T00:00:01.000Z' },
        { id: 'e2', order: 1, kind: 'tool-selection', tools: ['read', 'grep'], at: '2026-01-01T00:00:02.000Z' },
      ],
    })
    await store.projectSession(session('sess-tools'))
    let workspace = await store.get((await store.list())[0].id)
    assert.deepEqual(workspace.threads[0].tools, ['read', 'grep'])
    // A later `cleared` pin retracts the restriction.
    await store.projectSession({
      ...session('sess-tools'),
      entries: [
        ...session('sess-tools').entries,
        { id: 'e3', order: 2, kind: 'tool-selection', tools: null, at: '2026-01-01T00:00:03.000Z' },
      ],
    })
    workspace = await store.get((await store.list())[0].id)
    assert.equal(workspace.threads[0].tools, null)
  })
})

test('branch records a btw thread with its pinned tools', async () => {
  await withStore(async dataFile => {
    const store = new WorkspaceStore(dataFile)
    await store.projectSession({
      id: 'parent', cwd: '/tmp/btw', filePath: '/tmp/btw/p.jsonl', parentSessionFile: null, title: '父', inheritedEntryCount: 0, contextWindow: null,
      entries: [{ id: 'e1', order: 0, kind: 'user', text: 'q', at: '2026-01-01T00:00:01.000Z' }],
    })
    const workspaceId = (await store.list())[0].id
    const parent = (await store.get(workspaceId)).threads[0]
    const thread = await store.branch(parent.id, { sessionId: 'forked', title: '侧问', kind: 'btw', tools: ['read', 'grep', 'find', 'ls'] })
    assert.equal(thread.kind, 'btw')
    assert.equal(thread.parentId, parent.id)
    assert.deepEqual(thread.tools, ['read', 'grep', 'find', 'ls'])
    // A plain fork is still a branch.
    const plain = await store.branch(parent.id, { sessionId: 'forked-2', title: '分支' })
    assert.equal(plain.kind, 'branch')
  })
})

test('the /btw tool pins can be read back for re-applying after a restart', async () => {
  // The HOST cannot answer this question after a restart: a tool restriction is
  // a live effect on one agent scope, not session state. So this file is the
  // only record of "this session is a side question pinned to these tools", and
  // it must survive a reopen — that is the entire point of the accessor.
  await withStore(async dataFile => {
    const store = new WorkspaceStore(dataFile)
    await store.projectSession({
      id: 'parent', cwd: '/tmp/pins', filePath: '/tmp/pins/p.jsonl', parentSessionFile: null, title: '父', inheritedEntryCount: 0, contextWindow: null,
      entries: [{ id: 'e1', order: 0, kind: 'user', text: 'q', at: '2026-01-01T00:00:01.000Z' }],
    })
    const workspaceId = (await store.list())[0].id
    const parent = (await store.get(workspaceId)).threads[0]
    await store.branch(parent.id, { sessionId: 'side', title: '侧问', kind: 'btw', tools: ['read', 'glob'] })
    // A side question with no recorded loadout is skipped rather than guessed
    // at: pinning nothing would be worse than not pinning.
    await store.branch(parent.id, { sessionId: 'side-blank', title: '侧问', kind: 'btw' })
    await store.branch(parent.id, { sessionId: 'plain', title: '分支' })
    assert.deepEqual(store.btwPins(), [{ sessionId: 'side', tools: ['read', 'glob'] }])
    const reopened = new WorkspaceStore(dataFile)
    await reopened.ready
    assert.deepEqual(reopened.btwPins(), [{ sessionId: 'side', tools: ['read', 'glob'] }])
  })
})

test('a projection that arrives after the btw link keeps the btw marker', async () => {
  // The browser links the forked session while the projection rescan may find
  // the same file; the race must not downgrade a side question to a branch.
  await withStore(async dataFile => {
    const store = new WorkspaceStore(dataFile)
    await store.projectSession({
      id: 'parent', cwd: '/tmp/race', filePath: '/tmp/race/p.jsonl', parentSessionFile: null, title: '父', inheritedEntryCount: 0, contextWindow: null,
      entries: [{ id: 'e1', order: 0, kind: 'user', text: 'q', at: '2026-01-01T00:00:01.000Z' }],
    })
    const workspaceId = (await store.list())[0].id
    const parent = (await store.get(workspaceId)).threads[0]
    await store.branch(parent.id, { sessionId: 'forked', title: '侧问', kind: 'btw', tools: ['read'] })
    await store.projectSession({
      id: 'forked', cwd: '/tmp/race', filePath: '/tmp/race/f.jsonl', parentSessionFile: '/tmp/race/p.jsonl',
      title: null, inheritedEntryCount: 0, contextWindow: null,
      entries: [{ id: 'f1', order: 0, kind: 'user', text: 'side', at: '2026-01-01T00:00:02.000Z' }],
    })
    const child = (await store.get(workspaceId)).threads.find(item => item.sessionId === 'forked')
    assert.equal(child.kind, 'btw')
    assert.deepEqual(child.tools, ['read'])
  })
})

test('transient usage messages are dropped from persisted state', () => {
  // `usage` entries feed the context estimator but must never be persisted:
  // projection MERGES into a thread, so anything written stays forever and
  // renders as a blank row in the detail view.
  const { state, migrated } = normalizeState({
    version: 5,
    hiddenSessionIds: [],
    workspaces: [{
      id: 'w1', kind: 'projection', cwd: '/tmp/x', title: 'x', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      threads: [{
        id: 't1', title: 'q', parentId: null, sessionId: 's1', sessionTitle: null, sessionFile: null,
        color: '#0f766e', position: { x: 0, y: 0 }, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        messages: [
          { id: 'm1', text: 'q', kind: 'user', sourceEntryId: 'e1', at: '2026-01-01T00:00:01.000Z' },
          { id: 'm2', text: '', kind: 'usage', sourceEntryId: 'e2', at: '2026-01-01T00:00:02.000Z', usage: { input: 5, output: 1 } },
          { id: 'm3', text: 'a', kind: 'assistant', sourceEntryId: 'e3', at: '2026-01-01T00:00:03.000Z' },
        ],
      }],
    }],
  })
  assert.equal(migrated, true)
  assert.deepEqual(state.workspaces[0].threads[0].messages.map(m => m.kind), ['user', 'assistant'])
})

test('clean state is not reported as migrated', () => {
  // Otherwise every restart would rewrite the data file for nothing.
  const { migrated } = normalizeState({ version: 5, hiddenSessionIds: [], workspaces: [] })
  assert.equal(migrated, false)
})

test('re-projecting a session does not duplicate its tool calls', async () => {
  // The projection MERGES into a thread, and a rescan re-folds every entry. A
  // fold that searched only the "last assistant message" missed the entry it
  // created previously and appended another copy: real data reached 104 copies
  // of one call, an 86.9% duplicate rate, and a 449 MB data file.
  await withStore(async dataFile => {
    const store = new WorkspaceStore(dataFile)
    const session = {
      id: 'sess-tools', cwd: '/tmp/tools2', filePath: '/tmp/tools2/a.jsonl', parentSessionFile: null, title: null, inheritedEntryCount: 0, contextWindow: null,
      entries: [
        { id: 'e1', order: 0, kind: 'user', text: 'q', at: '2026-01-01T00:00:01.000Z' },
        { id: 'e2', order: 1, kind: 'assistant', text: 'a', at: '2026-01-01T00:00:02.000Z' },
        { id: 'e3', order: 2, kind: 'tool-call', callId: 'c1', name: 'bash', arguments: 'ls', at: '2026-01-01T00:00:03.000Z' },
        { id: 'e4', order: 3, kind: 'tool-result', callId: 'c1', name: 'bash', text: 'file.txt', at: '2026-01-01T00:00:04.000Z' },
        { id: 'e5', order: 4, kind: 'assistant', text: 'done', at: '2026-01-01T00:00:05.000Z' },
      ],
    }
    await store.projectSession(session)
    const count = async () => {
      const workspace = await store.get((await store.list())[0].id)
      return workspace.threads[0].messages.reduce((n, m) => n + (m.process ?? []).length, 0)
    }
    assert.equal(await count(), 1)
    // Re-projection is what a rescan does; it must be a no-op.
    await store.projectSession(session)
    assert.equal(await count(), 1)
    await store.projectSession(session)
    assert.equal(await count(), 1)
  })
})

test('a tool result still pairs with a call projected in an earlier batch', async () => {
  // The idempotent lookup must not break the normal incremental path: a result
  // arriving after its call still updates that call's entry.
  await withStore(async dataFile => {
    const store = new WorkspaceStore(dataFile)
    const base = { id: 's', cwd: '/tmp/t3', filePath: '/tmp/t3/a.jsonl', parentSessionFile: null, title: null, inheritedEntryCount: 0, contextWindow: null }
    await store.projectSession({
      ...base,
      entries: [
        { id: 'e1', order: 0, kind: 'user', text: 'q', at: '2026-01-01T00:00:01.000Z' },
        { id: 'e2', order: 1, kind: 'assistant', text: 'a', at: '2026-01-01T00:00:02.000Z' },
        { id: 'e3', order: 2, kind: 'tool-call', callId: 'c9', name: 'bash', arguments: 'ls', at: '2026-01-01T00:00:03.000Z' },
      ],
    })
    await store.projectEntries(base, [{ id: 'e4', kind: 'tool-result', callId: 'c9', name: 'bash', text: 'ok', at: '2026-01-01T00:00:04.000Z' }])
    const workspace = await store.get((await store.list())[0].id)
    const process = workspace.threads[0].messages.flatMap(m => m.process ?? [])
    assert.equal(process.length, 1)
    assert.equal(process[0].result, 'ok')
    assert.equal(process[0].arguments, 'ls')
  })
})

test('a tool call survives many rescans without growing', async () => {
  // The growth bug's signature: the file size climbing on every rescan. Ten
  // replays must leave a byte-identical state, not a linearly growing one.
  await withStore(async dataFile => {
    const store = new WorkspaceStore(dataFile)
    const entries = [
      { id: 'e1', order: 0, kind: 'user', text: 'q', at: '2026-01-01T00:00:01.000Z' },
      { id: 'e2', order: 1, kind: 'assistant', text: 'a', at: '2026-01-01T00:00:02.000Z' },
      { id: 'e3', order: 2, kind: 'tool-call', callId: 'c1', name: 'bash', arguments: 'x'.repeat(200), at: '2026-01-01T00:00:03.000Z' },
      { id: 'e4', order: 3, kind: 'tool-result', callId: 'c1', name: 'bash', text: 'y'.repeat(200), at: '2026-01-01T00:00:04.000Z' },
    ]
    const session = { id: 's', cwd: '/tmp/grow', filePath: '/tmp/grow/a.jsonl', parentSessionFile: null, title: null, inheritedEntryCount: 0, contextWindow: null, entries }
    await store.projectSession(session)
    let first = null
    for (let i = 0; i < 10; i++) {
      await store.projectSession(session)
      const size = JSON.stringify(await store.get((await store.list())[0].id)).length
      if (first === null) first = size
      assert.equal(size, first, `state grew on replay ${i + 1}: ${first} → ${size}`)
    }
  })
})


// 图片消息：pi 把图片存成内容块，画布只带 COUNT。两个地方曾经会把「只有图片、
// 没有文字」的消息整条丢掉（投影的 note() 与存储的 noteProjection()），结果是
// 贴了截图的那一轮在画布上根本不存在。
test('an image-only user message still becomes a stored turn', async () => {
  await withStore(async dataFile => {
    const store = new WorkspaceStore(dataFile)
    await store.projectSession({
      id: 'sess-img',
      cwd: 'B:/proj/img',
      filePath: 'B:/proj/img/a.jsonl',
      parentSessionFile: null,
      title: null,
      inheritedEntryCount: 0,
      entries: [
        { id: 'e1', order: 0, kind: 'user', text: '', imageCount: 1, usageChars: 4800, at: '2026-01-01T00:00:01.000Z' },
      ],
    })
    const list = await store.list()
    const workspace = await store.get(list[0].id)
    const messages = workspace.threads[0].messages
    assert.equal(messages.length, 1)
    assert.equal(messages[0].kind, 'user')
    assert.equal(messages[0].text, '')
    assert.equal(messages[0].imageCount, 1)
    // 标题不能留空，否则侧栏与卡片都是空白条目
    assert.equal(workspace.threads[0].title, '[图片]')
  })
})

test('a text message with images keeps both the text and the count', async () => {
  await withStore(async dataFile => {
    const store = new WorkspaceStore(dataFile)
    await store.projectSession({
      id: 'sess-img2',
      cwd: 'B:/proj/img2',
      filePath: 'B:/proj/img2/a.jsonl',
      parentSessionFile: null,
      title: null,
      inheritedEntryCount: 0,
      entries: [
        { id: 'e1', order: 0, kind: 'user', text: '看这两张图', imageCount: 2, usageChars: 9600, at: '2026-01-01T00:00:01.000Z' },
      ],
    })
    const list = await store.list()
    const workspace = await store.get(list[0].id)
    assert.equal(workspace.threads[0].messages[0].text, '看这两张图')
    assert.equal(workspace.threads[0].messages[0].imageCount, 2)
    assert.equal(workspace.threads[0].title, '看这两张图')
  })
})

test('a plain message carries no imageCount key at all', async () => {
  await withStore(async dataFile => {
    const store = new WorkspaceStore(dataFile)
    await store.projectSession({
      id: 'sess-plain',
      cwd: 'B:/proj/plain',
      filePath: 'B:/proj/plain/a.jsonl',
      parentSessionFile: null,
      title: null,
      inheritedEntryCount: 0,
      entries: [
        { id: 'e1', order: 0, kind: 'user', text: '普通提问', at: '2026-01-01T00:00:01.000Z' },
      ],
    })
    const list = await store.list()
    const workspace = await store.get(list[0].id)
    assert.equal('imageCount' in workspace.threads[0].messages[0], false)
  })
})

test('a failed save reports the error and does not kill the process', async () => {
  // A rejected flush used to be an unhandled rejection, which terminates Node
  // with no output: the server vanished mid-write (leaving a `.tmp` behind) and
  // the user saw nothing. It must surface the failure instead.
  await withStore(async dataFile => {
    const store = new WorkspaceStore(dataFile)
    // `ready` is the constructor's own load — calling load() again would run a
    // SECOND initial save, and both write `<data>.<pid>.tmp`, so one rename
    // wins and the other fails with ENOENT (a race in the test, not in the
    // store: real callers go through `mutate`, which serializes saves).
    await store.ready
    store.save = async () => { throw new Error('ENOSPC: no space left on device') }
    const written = []
    const original = process.stderr.write.bind(process.stderr)
    process.stderr.write = chunk => { written.push(String(chunk)); return true }
    try {
      store.markDirty()
      await new Promise(resolve => setTimeout(resolve, 1200))
    } finally {
      process.stderr.write = original
    }
    assert.equal(written.some(line => line.includes('ENOSPC')), true, '失败必须被打印出来')
  })
})

// ---------------------------------------------------------------------------
// Deletion: `removedSessionIds` is the caller's confirmed-gone list.
// ---------------------------------------------------------------------------

const storedSession = (id, cwd, text = 'q') => ({
  id,
  cwd,
  filePath: `${cwd}/${id}.jsonl`,
  parentSessionFile: null,
  title: null,
  inheritedEntryCount: 0,
  contextWindow: null,
  entries: [{ id: 'e1', order: 0, kind: 'user', text, at: '2026-01-01T00:00:01.000Z' }],
})

test('a session the host no longer has loses its card, and its emptied workspace goes', async () => {
  await withStore(async dataFile => {
    const store = new WorkspaceStore(dataFile)
    await store.projectSession(storedSession('sess-keep', '/tmp/keep'))
    await store.projectSession(storedSession('sess-gone', '/tmp/gone'))
    assert.equal((await store.list()).length, 2)

    await store.syncSessions([{ id: 'sess-keep', cwd: '/tmp/keep' }], ['sess-gone'])

    const list = await store.list()
    assert.equal(list.length, 1)
    const workspace = await store.get(list[0].id)
    assert.deepEqual(workspace.threads.map(thread => thread.sessionId), ['sess-keep'])
  })
})

test('a session the host still has keeps its card, and nothing else changes', async () => {
  await withStore(async dataFile => {
    const store = new WorkspaceStore(dataFile)
    await store.projectSession(storedSession('sess-1', '/tmp/p'))
    const before = await store.get((await store.list())[0].id)

    // An unrelated id in `removedSessionIds` must not touch this session.
    await store.syncSessions([{ id: 'sess-1', cwd: '/tmp/p' }], ['sess-that-decided-elsewhere'])

    const after = await store.get((await store.list())[0].id)
    assert.deepEqual(after, before)
  })
})

test('removing a session prunes its archive marker', async () => {
  await withStore(async dataFile => {
    const store = new WorkspaceStore(dataFile)
    await store.projectSession(storedSession('sess-1', '/tmp/p'))
    await store.projectSession(storedSession('sess-2', '/tmp/p'))
    const workspaceId = (await store.list())[0].id
    const first = (await store.get(workspaceId)).threads.find(thread => thread.sessionId === 'sess-1')
    await store.removeThread(first.id)
    assert.deepEqual(store.state.hiddenSessionIds, ['sess-1'])

    await store.syncSessions([{ id: 'sess-2', cwd: '/tmp/p' }], ['sess-1'])

    assert.deepEqual(store.state.hiddenSessionIds, [])
    const workspace = await store.get(workspaceId)
    assert.deepEqual(workspace.threads.map(thread => thread.sessionId), ['sess-2'])
  })
})

test('the archive marker of a session that is merely missing for one pass survives', async () => {
  await withStore(async dataFile => {
    const store = new WorkspaceStore(dataFile)
    await store.projectSession(storedSession('sess-1', '/tmp/p'))
    await store.projectSession(storedSession('sess-2', '/tmp/p'))
    const workspaceId = (await store.list())[0].id
    const first = (await store.get(workspaceId)).threads.find(thread => thread.sessionId === 'sess-1')
    await store.removeThread(first.id)

    // The host listed only the other session and confirmed no deletion: the
    // marker must stay, or an unreadable session would resurrect on a later scan.
    await store.syncSessions([{ id: 'sess-2', cwd: '/tmp/p' }], [])
    assert.deepEqual(store.state.hiddenSessionIds, ['sess-1'])
  })
})

test('a canvas-only thread is never removed by a session deletion', async () => {
  await withStore(async dataFile => {
    const store = new WorkspaceStore(dataFile)
    const workspace = await store.create('手写工作区')
    await store.createThread(workspace.id, { title: '草稿卡片' })

    await store.syncSessions([], ['sess-gone'])

    // `sessionId` is null on a thread the canvas created, so no removed id can
    // match it — the check is on the session, not on the missing session file.
    const after = await store.get(workspace.id)
    assert.deepEqual(after.threads.map(thread => thread.title), ['草稿卡片'])
    assert.equal(after.threads[0].sessionId, null)
  })
})

test('thread visibility is tri-state: hidden, pinned visible, and back to default', async () => {
  await withStore(async dataFile => {
    const store = new WorkspaceStore(dataFile)
    await store.projectSession(storedSession('sess-1', '/tmp/p'))
    const workspaceId = (await store.list())[0].id
    const first = (await store.get(workspaceId)).threads[0]
    // Fresh projection carries NO `hidden` field: the canvas default decides.
    assert.equal('hidden' in first, false)

    await store.updateThread(first.id, { hidden: true })
    assert.equal((await store.get(workspaceId)).threads[0].hidden, true)

    await store.updateThread(first.id, { hidden: false })
    assert.equal((await store.get(workspaceId)).threads[0].hidden, false)

    // `null` clears the field again, handing the decision back to the default
    // (the recent-activity window).
    await store.updateThread(first.id, { hidden: null })
    assert.equal('hidden' in (await store.get(workspaceId)).threads[0], false)

    await assert.rejects(() => store.updateThread(first.id, { hidden: 'yes' }), /hidden 必须是布尔值/)
  })
})

test('a hidden flag survives a reopen', async () => {
  await withStore(async dataFile => {
    const store = new WorkspaceStore(dataFile)
    await store.projectSession(storedSession('sess-1', '/tmp/p'))
    const workspaceId = (await store.list())[0].id
    const threadId = (await store.get(workspaceId)).threads[0].id
    await store.updateThread(threadId, { hidden: true })

    const reopened = new WorkspaceStore(dataFile)
    assert.equal((await reopened.get(workspaceId)).threads[0].hidden, true)
  })
})

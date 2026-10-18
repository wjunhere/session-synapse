/**
 * Reconciliation: the canvas must not keep cards for sessions the host no longer has.
 *
 * These use the REAL pi adapter against a temporary sessions directory rather
 * than a stand-in: the whole point of the pass is how the host's own session
 * list is read and judged, so a fake would test the fake. The adapter's poll
 * interval is raised so only the reconciliation calls under test can see the
 * directory change.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPiAdapter } from '../src/adapters/pi.js'
import { Synapse } from '../src/synapse.js'

const PROBE_CWD = 'B:\\probe\\reconcile'
/** pi encodes a cwd as a directory name by replacing separators with `-`. */
const PROBE_DIR = '--B--probe-reconcile--'

function sessionFile(id, text = 'q') {
  return [
    JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-01-01T00:00:00.000Z', cwd: PROBE_CWD }),
    JSON.stringify({
      type: 'message',
      id: 'e1',
      parentId: null,
      timestamp: '2026-01-01T00:00:01.000Z',
      message: { role: 'user', content: [{ type: 'text', text }], timestamp: 1 },
    }),
  ].join('\n') + '\n'
}

async function withSynapse(run, { autoProjection = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'synapse-reconcile-'))
  const sessionsDir = join(root, 'sessions')
  const sessionDir = join(sessionsDir, PROBE_DIR)
  await mkdir(sessionDir, { recursive: true })
  const adapter = createPiAdapter({ sessionsDir, agentDir: root, pollIntervalMs: 60_000 })
  const synapse = new Synapse({ adapter, dataFile: join(root, 'workspaces.json'), autoProjection })
  try {
    await run({ synapse, sessionDir })
  } finally {
    // `stop()` returns the flush it asked the store for; awaiting it means the
    // trailing write is finished before the tree goes. Without that the write
    // lands mid-`rm` and the removal fails with ENOTEMPTY (the store coalesces
    // projection writes into one deferred flush).
    await synapse.stop()
    await rm(root, { recursive: true, force: true })
  }
}

const write = (dir, id) => writeFile(join(dir, `${id}.jsonl`), sessionFile(id))
const remove = (dir, id) => rm(join(dir, `${id}.jsonl`))

const threads = async synapse => {
  const list = await synapse.listWorkspaces()
  const workspaces = await Promise.all(list.map(summary => synapse.getWorkspace(summary.id)))
  return workspaces.flatMap(workspace => workspace.threads)
}

test('a deleted session loses its card on the second missing pass', async () => {
  await withSynapse(async ({ synapse, sessionDir }) => {
    await write(sessionDir, 'sess-a')
    await write(sessionDir, 'sess-b')
    await synapse.start()
    assert.deepEqual((await threads(synapse)).map(thread => thread.sessionId).sort(), ['sess-a', 'sess-b'])

    await remove(sessionDir, 'sess-a')

    // One miss is not enough: it is also what a transient read failure looks
    // like, and a wrongly deleted thread returns with a new id and no layout.
    const first = await synapse.reconcile()
    assert.deepEqual(first.removed, [])
    assert.deepEqual((await threads(synapse)).map(thread => thread.sessionId).sort(), ['sess-a', 'sess-b'])

    const second = await synapse.reconcile()
    assert.deepEqual(second.removed, ['sess-a'])
    assert.deepEqual((await threads(synapse)).map(thread => thread.sessionId), ['sess-b'])
  })
})

test('an empty host list never wipes the canvas', async () => {
  await withSynapse(async ({ synapse, sessionDir }) => {
    await write(sessionDir, 'sess-only')
    await synapse.start()
    await remove(sessionDir, 'sess-only')

    // A directory read that fails, or returns nothing at all, is
    // indistinguishable from "the user deleted everything" — and keeping a
    // phantom card is recoverable while wiping a hand-arranged canvas is not.
    await synapse.reconcile()
    await synapse.reconcile()
    assert.deepEqual((await threads(synapse)).map(thread => thread.sessionId), ['sess-only'])
    assert.deepEqual(synapse.missingSessionIds, new Set())
  })
})

test('an archived session is hidden, not deleted, while its file exists', async () => {
  await withSynapse(async ({ synapse, sessionDir }) => {
    await write(sessionDir, 'sess-archived')
    await synapse.start()
    const [thread] = await threads(synapse)
    await synapse.removeThread(thread.id)
    assert.deepEqual(synapse.store.state.hiddenSessionIds, ['sess-archived'])

    // pi-web's archive writes ui-state only; the session file stays, so the
    // host still lists it and reconciliation must leave the marker alone.
    await synapse.reconcile()
    await synapse.reconcile()
    assert.deepEqual(synapse.store.state.hiddenSessionIds, ['sess-archived'])
    assert.deepEqual(await threads(synapse), [])
  })
})

test('a thread left in the data file by an earlier run is reconciled too', async () => {
  await withSynapse(async ({ synapse, sessionDir }) => {
    await write(sessionDir, 'sess-live')
    await synapse.start()
    assert.deepEqual((await threads(synapse)).map(thread => thread.sessionId), ['sess-live'])

    // A session deleted while nothing was watching leaves its thread behind: it
    // is in the data file, not in the in-memory session map.
    await synapse.store.projectSession({
      id: 'sess-stale',
      cwd: PROBE_CWD,
      filePath: join(sessionDir, 'sess-stale.jsonl'),
      parentSessionFile: null,
      title: null,
      inheritedEntryCount: 0,
      contextWindow: null,
      entries: [{ id: 'e1', order: 0, kind: 'user', text: 'old', at: '2026-01-01T00:00:01.000Z' }],
    })
    assert.deepEqual((await threads(synapse)).map(thread => thread.sessionId).sort(), ['sess-live', 'sess-stale'])

    await synapse.reconcile()
    const second = await synapse.reconcile()
    assert.deepEqual(second.removed, ['sess-stale'])
    assert.deepEqual((await threads(synapse)).map(thread => thread.sessionId), ['sess-live'])
  })
})

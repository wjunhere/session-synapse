/**
 * Session-removal reconciliation, end to end.
 *
 * The canvas used to keep a card forever for a session the host had deleted: the
 * projection only ever appended, so the card pointed at a session that no longer
 * opened, the archive markers grew without bound, and the data file only grew.
 *
 * Two halves, because they prove different things:
 *
 *   A. In-process, on a temporary agent directory, with the reconcile interval
 *      turned down. The real pi adapter reads real session files; nothing about
 *      the pass under test is stood in for. This is where the guards are
 *      checked, because they need a host directory that can be made empty.
 *   B. Against the RUNNING service (BASE), with a one-off session created through
 *      pi-web. This is the half that proves the automatic timer actually fires:
 *      nothing in it calls reconcile by hand.
 *
 * Usage: BASE=http://127.0.0.1:30143 PROBE_CWD=B:/_probe/removal node scripts/verify-session-removal.mjs
 * The probe session is deleted by the script itself; run scripts/clean-probes.mjs
 * afterwards (with the service stopped) for the pi-web bookkeeping it leaves.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPiAdapter } from '../src/adapters/pi.js'
import { Synapse } from '../src/synapse.js'

const BASE = process.env.BASE ?? 'http://127.0.0.1:30143'
const PROBE_CWD = process.env.PROBE_CWD
/** Short enough that a two-miss deletion lands in a second or two. */
const RECONCILE_MS = 300
/** How long to wait for the running service to drop a card (two 5 s passes). */
const LIVE_TIMEOUT_MS = 60_000

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return true
    if (Date.now() > deadline) return false
    await sleep(100)
  }
}

const PROBE_DIR_NAME = '--B--probe-removal--'

function sessionLines(id) {
  return [
    JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-01-01T00:00:00.000Z', cwd: 'B:\\probe\\removal' }),
    JSON.stringify({
      type: 'message',
      id: 'e1',
      parentId: null,
      timestamp: '2026-01-01T00:00:01.000Z',
      message: { role: 'user', content: [{ type: 'text', text: '探测' }], timestamp: 1 },
    }),
  ].join('\n') + '\n'
}

/**
 * One Synapse on a throwaway agent directory, with the polling watcher almost
 * disabled so only the reconcile timer can see a directory change.
 */
async function withSynapse(run) {
  const root = await mkdtemp(join(tmpdir(), 'pi-synapse-verify-removal-'))
  const sessionsDir = join(root, 'sessions')
  const dir = join(sessionsDir, PROBE_DIR_NAME)
  await mkdir(dir, { recursive: true })
  const adapter = createPiAdapter({ sessionsDir, agentDir: root, pollIntervalMs: 86_400_000 })
  const synapse = new Synapse({ adapter, dataFile: join(root, 'workspaces.json'), reconcileIntervalMs: RECONCILE_MS })
  try {
    await run({ synapse, dir })
  } finally {
    await synapse.stop()
    await rm(root, { recursive: true, force: true })
  }
}

const sessionIdsOf = async synapse => {
  const list = await synapse.listWorkspaces()
  const workspaces = await Promise.all(list.map(summary => synapse.getWorkspace(summary.id)))
  return workspaces.flatMap(workspace => workspace.threads.map(thread => thread.sessionId))
}

// ---------------------------------------------------------------------------
// A. guards, on a temporary host directory
// ---------------------------------------------------------------------------
console.log('— A. 临时宿主目录（真实 adapter + 对账定时器）')

await withSynapse(async ({ synapse, dir }) => {
  await writeFile(join(dir, 'sess-keep.jsonl'), sessionLines('sess-keep'))
  await writeFile(join(dir, 'sess-gone.jsonl'), sessionLines('sess-gone'))
  await synapse.start()
  const before = await sessionIdsOf(synapse)
  check('两个会话都投影成卡片', before.length === 2, JSON.stringify(before))

  await rm(join(dir, 'sess-gone.jsonl'))
  const gone = await waitFor(async () => (await sessionIdsOf(synapse)).length === 1, 6 * RECONCILE_MS)
  const after = await sessionIdsOf(synapse)
  check('删掉的会话在几轮对账后消失（无需手工触发）', gone, JSON.stringify(after))
  check('仍在的会话保留', after.includes('sess-keep'), JSON.stringify(after))
})

await withSynapse(async ({ synapse, dir }) => {
  await writeFile(join(dir, 'sess-only.jsonl'), sessionLines('sess-only'))
  await synapse.start()
  await rm(join(dir, 'sess-only.jsonl'))
  // An empty host list while the canvas has cards is a failed directory read,
  // not "the user deleted everything": the pass is skipped entirely rather than
  // treated as a two-miss deletion.
  await sleep(8 * RECONCILE_MS)
  const ids = await sessionIdsOf(synapse)
  check('活会话集为空时不清空画布', ids.includes('sess-only'), `${JSON.stringify(ids)}，missing=${JSON.stringify([...synapse.missingSessionIds])}`)
})

await withSynapse(async ({ synapse, dir }) => {
  await writeFile(join(dir, 'sess-archived.jsonl'), sessionLines('sess-archived'))
  await synapse.start()
  const [thread] = (await Promise.all((await synapse.listWorkspaces()).map(async s => (await synapse.getWorkspace(s.id)).threads))).flat()
  await synapse.removeThread(thread.id)
  await sleep(8 * RECONCILE_MS)
  const markers = synapse.store.state.hiddenSessionIds
  check('归档≠删除：会话文件还在，归档标记不被剪掉', markers.includes('sess-archived'), JSON.stringify(markers))
  check('归档≠删除：卡片没有被重新投影出来', (await sessionIdsOf(synapse)).length === 0)
})

// ---------------------------------------------------------------------------
// B. the running service
// ---------------------------------------------------------------------------
if (PROBE_CWD === undefined) {
  console.log('\n— B. 跳过：未设置 PROBE_CWD（需要一个空目录做一次性会话）')
} else {
  console.log('\n— B. 运行中的服务')
  await mkdir(PROBE_CWD, { recursive: true })
  let sessionId = null
  try {
    const created = await fetch(`${BASE}/api/agent/new`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: PROBE_CWD, type: 'ensure_session' }),
    })
    const body = await created.json().catch(() => ({}))
    sessionId = typeof body.sessionId === 'string' ? body.sessionId : null
    check('一次性会话已创建', sessionId !== null, `HTTP ${created.status} ${JSON.stringify(body).slice(0, 120)}`)
    if (sessionId !== null) {
      // `ensure_session` only registers the session in memory: pi writes the
      // session FILE with the first prompt, and the projection reads files, so
      // a prompt is what makes the card exist at all. The reply is not under
      // test here, but the run must FINISH before the file goes — deleting it
      // mid-run lets the agent append to a file that is being removed.
      const post = async payload => {
        const response = await fetch(`${BASE}/api/agent/${encodeURIComponent(sessionId)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
        return response.json().catch(() => ({}))
      }
      await post({ type: 'set_model', provider: 'trae', modelId: 'DeepSeek-V4-Flash' })
      await post({ type: 'set_thinking_level', level: 'off' })
      await post({ type: 'prompt', message: '请只回复两个字：好的。' })

      // The service projects on its own schedule; find the thread by sessionId
      // across every workspace (probe workspaces accumulate historical threads).
      const findThread = async () => {
        const list = await (await fetch(`${BASE}/synapse/api/workspaces`)).json()
        for (const summary of list.workspaces) {
          const full = await (await fetch(`${BASE}/synapse/api/workspaces/${summary.id}`)).json()
          const hit = full.workspace.threads.find(thread => thread.sessionId === sessionId)
          if (hit !== undefined) return hit
        }
        return null
      }
      let thread = null
      await waitFor(async () => { thread = await findThread(); return thread !== null }, 90_000)
      check('探测会话投影成了卡片', thread !== null, thread === null ? '90s 内未出现' : `thread=${thread.id.slice(0, 8)} file=${thread.sessionFile}`)

      const idle = await waitFor(async () => {
        const running = await (await fetch(`${BASE}/api/agent/running`)).json()
        return !(running.runningSessionIds ?? []).includes(sessionId)
      }, 120_000)
      check('探测会话的运行已结束（删除文件前必须落定）', idle, idle ? '' : '120s 内仍未结束')

      if (thread !== null && typeof thread.sessionFile === 'string') {
        const before = await (async () => {
          const list = await (await fetch(`${BASE}/synapse/api/workspaces`)).json()
          const all = await Promise.all(list.workspaces.map(async summary => (await (await fetch(`${BASE}/synapse/api/workspaces/${summary.id}`)).json()).workspace))
          return all.flatMap(workspace => workspace.threads.map(t => t.sessionId)).filter(id => typeof id === 'string')
        })()
        await rm(thread.sessionFile)
        const removed = await waitFor(async () => (await findThread()) === null, LIVE_TIMEOUT_MS)
        check('删除会话文件后卡片自动消失（服务自己的对账定时器）', removed, removed ? '' : `等待上限 ${LIVE_TIMEOUT_MS / 1000}s`)

        const after = await (async () => {
          const list = await (await fetch(`${BASE}/synapse/api/workspaces`)).json()
          const all = await Promise.all(list.workspaces.map(async summary => (await (await fetch(`${BASE}/synapse/api/workspaces/${summary.id}`)).json()).workspace))
          return all.flatMap(workspace => workspace.threads.map(t => t.sessionId)).filter(id => typeof id === 'string')
        })()
        const lost = before.filter(id => !after.includes(id))
        check('只少了这一个会话的卡片（没有误删其他会话）', lost.length === 1 && lost[0] === sessionId, `少了 ${JSON.stringify(lost)}`)
        check('画布没有被清空', after.length > 0, `${after.length} 张卡仍在`)
      }
    }
  } catch (error) {
    check('B 段无异常', false, error?.message ?? String(error))
  } finally {
    await rm(PROBE_CWD, { recursive: true, force: true }).catch(() => {})
  }
}

const failed = results.filter(result => !result.ok)
console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
if (failed.length > 0) {
  console.log('失败项:', failed.map(result => result.name).join('；'))
  process.exit(1)
}

/**
 * Remove every trace a probe run left behind.
 *
 * A probe session is a real session: pi writes it to the sessions directory, the
 * projection turns it into a real workspace, and pi-web records its cwd in
 * `projectOrder`. None of that goes away when the probe's cwd directory is
 * deleted, so repeated verification runs accumulate workspaces in
 * `workspaces.json` (measured: 24 probe threads in one workspace) and the file
 * grows until every save rewrites ~80 MB — which is slow, disk-hungry, and was
 * how a full disk ended up killing the server mid-write.
 *
 * Run this after any probe that writes a session (verify-branch,
 * verify-image-paste, verify-streaming-card, verify-btw, verify-send,
 * verify-streaming, verify-writes, verify-navigation).
 *
 * STOP THE SERVER FIRST. The store keeps its state in memory and rewrites the
 * whole file on the next mutation, so cleaning while it runs just gets undone.
 * The lock/temp half of the cleanup additionally refuses to touch files whose
 * owner is still alive (see step 4), because getting that wrong once cost a live
 * instance a save.
 *
 * Usage: node scripts/clean-probes.mjs [--dry-run] [--data <path>]
 */
import { readFileSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { commandLineLooksLikeOurs } from '../src/store/instance-lock.js'

const DRY = process.argv.includes('--dry-run')
/**
 * `--data <path>` points the CANVAS part of the cleanup at another file.
 * `scripts/verify-all.mjs` runs its own service against an isolated data file,
 * so the probe workspaces are there, not in the user's real one. The session
 * directory and pi-web's state file are shared and always the real ones.
 */
const dataIndex = process.argv.indexOf('--data')
const dataOverride = dataIndex === -1 ? null : process.argv[dataIndex + 1] ?? ''
if (dataIndex !== -1 && dataOverride === '') {
  process.stderr.write('clean-probes: --data 需要一个路径\n')
  process.exit(1)
}
const agentDir = join(homedir(), '.pi', 'agent')
const dataFile = dataOverride ?? join(agentDir, 'synapse', 'workspaces.json')
const sessionsDir = join(agentDir, 'sessions')
const stateFile = join(agentDir, 'pi-web-session-state.json')

/**
 * PID recorded in a leftover file, or `null` when its format carries none.
 *
 * The three shapes are the store's own: `<data>.instance` is a JSON payload
 * written once at startup, `<data>.lock` is a bare PID written per save, and
 * `<data>.<pid>.tmp` is the in-flight write. A corrupt one is treated as
 * ownerless, which is what makes a corrupt lock reclaimable.
 */
function readPid(path) {
  try {
    const text = readFileSync(path, 'utf8')
    if (text.trimStart().startsWith('{')) {
      const pid = JSON.parse(text)?.pid
      return Number.isInteger(pid) && pid > 0 ? pid : null
    }
    const pid = Number.parseInt(text, 10)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/**
 * Is this PID a live synapse instance right now?
 *
 * `false` only when the process is definitely gone or definitely not ours. An
 * unreadable command line counts as **alive**: leaving a stale lock behind is
 * harmless (the next start reclaims it), stealing a live one is not.
 */
function ownerIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (pid === process.pid) return true
  try {
    // Signal 0 only performs the existence/permission check.
    process.kill(pid, 0)
  } catch (error) {
    // EPERM means it exists but belongs to someone else.
    if (error?.code !== 'EPERM') return false
  }
  return commandLineLooksLikeOurs(pid) !== false
}

/**
 * A path belongs to a probe when ANY of its segments starts with `_probe` or
 * `_e2e`.
 *
 * Segment-wise, not last-segment-wise, and anchored on the leading underscore:
 * probes put their marker in different positions (`_probe-cwd`,
 * `_probe-branch-1020`, `_e2e\branch-probe`, `_probe/cwd`), and a
 * last-segment test missed every nested one. The underscore is what keeps real
 * directories safe — a user workspace named `probe-tools` must survive.
 */
const isProbePath = value => String(value ?? '').split(/[\\/]+/).some(segment => /^_(probe|e2e)/i.test(segment))
const report = []
const writeJson = (path, value) => { if (!DRY) writeFileSync(path, JSON.stringify(value, null, 2), 'utf8') }

// 1. Canvas workspaces: drop the probe ones and forget their sessions.
//    Absent is a valid state: a verify run whose service never got far enough to
//    write its isolated file still needs the session/pi-web halves of the cleanup.
let state = { workspaces: [], hiddenSessionIds: [] }
if (existsSync(dataFile)) state = JSON.parse(readFileSync(dataFile, 'utf8'))
const droppedWorkspaces = state.workspaces.filter(workspace => isProbePath(workspace.cwd))
const probeSessionIds = new Set(droppedWorkspaces.flatMap(workspace => workspace.threads.map(thread => thread.sessionId)).filter(id => typeof id === 'string'))
state.workspaces = state.workspaces.filter(workspace => !isProbePath(workspace.cwd))
report.push(`画布工作区 ${droppedWorkspaces.length} 个（会话 ${probeSessionIds.size} 个）`)
if (existsSync(dataFile)) writeJson(dataFile, state)

// 2. Session files on disk: the projection reads these, so leaving them behind
//    recreates the workspace on the next scan.
const removedDirs = []
if (existsSync(sessionsDir)) {
  for (const dir of readdirSync(sessionsDir)) {
    const full = join(sessionsDir, dir)
    // The directory name is the cwd with separators replaced by `-`, so a probe
    // cwd shows up as `...-_probe-cwd` or `...-_e2e-branch-probe`.
    if (!isProbePath(dir.replaceAll('-', '/')) && !/probe|_e2e/i.test(dir)) continue
    removedDirs.push(dir)
    if (!DRY) rmSync(full, { recursive: true, force: true })
  }
}
report.push(`会话目录 ${removedDirs.length} 个`)

// 3. pi-web's own state: an archived flag survives the session's deletion as an
//    orphan, and `projectOrder` keeps the dead cwd.
if (existsSync(stateFile)) {
  const web = JSON.parse(readFileSync(stateFile, 'utf8'))
  const alive = new Set()
  if (existsSync(sessionsDir)) {
    for (const dir of readdirSync(sessionsDir)) {
      const full = join(sessionsDir, dir)
      if (!existsSync(full)) continue
      for (const name of readdirSync(full)) {
        if (name.endsWith('.jsonl')) alive.add(name.replace(/^.*_/, '').replace(/\.jsonl$/, ''))
      }
    }
  }
  const orphans = Object.keys(web.sessions ?? {}).filter(id => !alive.has(id))
  for (const id of orphans) delete web.sessions[id]
  const orderBefore = (web.projectOrder ?? []).length
  web.projectOrder = (web.projectOrder ?? []).filter(entry => !isProbePath(entry))
  // Bump the revision so a browser holding the old state reloads it.
  web.revision = Number(web.revision ?? 0) + 1
  report.push(`pi-web 孤儿归档 ${orphans.length} 个，projectOrder ${orderBefore} → ${web.projectOrder.length}，revision → ${web.revision}`)
  writeJson(stateFile, web)
}

// 4. Locks and temp files: a *killed* writer always leaves them (docs/runtime.md 坑 37).
//
//    Two guards, each added after this step sabotaged a LIVE instance:
//
//      - 只碰**本次这份数据文件**的附属产物（`--data` 决定）。它以前写死扫
//        `~/.pi/agent/synapse`，于是 `npm run verify`（`--data <临时文件>`）也会去删
//        用户正在跑的那个实例的锁与临时文件。
//      - 持有者还活着就不碰。删掉 `<data>.<pid>.tmp` 会让那次写入的 rename 报 ENOENT
//        —— **那一笔保存直接丢掉**（实测：日志里就一行 rename 失败，工作区少了那次改动）；
//        删掉 `<data>.instance` 更糟，它只在启动时写一次，于是实例从此裸奔
//        （第二个实例可以同时写同一份文件，正是 docs/runtime.md 坑 36 的地形）。
const dataDir = dirname(dataFile)
const dataBase = basename(dataFile)
for (const name of existsSync(dataDir) ? readdirSync(dataDir) : []) {
  if (!name.startsWith(`${dataBase}.`)) continue
  const suffix = name.slice(dataBase.length + 1)
  const full = join(dataDir, name)
  const owner = suffix === 'instance' || suffix === 'lock' ? readPid(full)
    : /^\d+\.tmp$/.test(suffix) ? Number(suffix.slice(0, -4))
      : suffix === 'before-drop' ? null
        : undefined
  if (owner === undefined) continue
  if (owner !== null && ownerIsRunning(owner)) {
    report.push(`留着 ${name}（持有者 ${owner} 还活着）`)
    continue
  }
  if (!DRY) rmSync(full, { force: true })
  report.push(`清掉 ${name}`)
}

console.log(`${DRY ? '[dry-run] ' : ''}清理结果:`)
for (const line of report) console.log('  ' + line)

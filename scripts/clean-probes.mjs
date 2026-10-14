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
 *
 * Usage: node scripts/clean-probes.mjs [--dry-run]
 */
import { readFileSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

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

// 4. Locks and temp files: a killed writer always leaves them (AGENTS.md 坑 37).
const synapseDir = join(agentDir, 'synapse')
for (const name of readdirSync(synapseDir)) {
  if (!/^workspaces\.json\.(instance|lock|\d+\.tmp)$/.test(name) && !/^workspaces\.json\.before-drop$/.test(name)) continue
  if (!DRY) rmSync(join(synapseDir, name), { force: true })
  report.push(`清掉 ${name}`)
}

console.log(`${DRY ? '[dry-run] ' : ''}清理结果:`)
for (const line of report) console.log('  ' + line)

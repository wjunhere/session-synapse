#!/usr/bin/env node
/**
 * The whole regression suite in one command.
 *
 * It runs `bin/synapse.js start` against an ISOLATED data file and a
 * throwaway probe cwd, runs every suite with `BASE`/`PROBE_CWD` pointing at
 * them, then cleans up and prints a table. Reasons this exists:
 *
 *   - eleven browser suites had to be started by hand with the right env vars,
 *     and three environment mistakes cost real time in one afternoon (two
 *     service instances at once, probe workspaces piling up, the wrong model);
 *   - the canvas store must not be the user's real one: a probe run would
 *     otherwise append probe workspaces to a 90 MB file that then never shrinks;
 *   - cleanup has to happen even when a suite fails, or the next run measures
 *     polluted state.
 *
 * PI-WEB MUST ALREADY BE RUNNING on the upstream port (the canvas proxies to it
 * and the probe sessions are created through its API). It is NOT started or
 * killed here: killing a pi-web the user started is worse than a clear error.
 *
 * Usage:
 *   npm run verify                        # everything
 *   npm run verify -- --skip-browser      # the non-browser suites only
 *   npm run verify -- --only streaming    # substring filter on the script name
 *   SYNAPSE_VERIFY_PORT=30999 npm run verify
 *
 * Full output of every suite is written to <run>/logs/<suite>.log. The run
 * directory is deleted on success and KEPT on failure, with its path printed.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = process.cwd()
const PORT = Number(process.env.SYNAPSE_VERIFY_PORT ?? 30143)
const UPSTREAM = Number(process.env.SYNAPSE_VERIFY_UPSTREAM ?? 30100)
const BASE = `http://127.0.0.1:${PORT}`
const UPSTREAM_BASE = `http://127.0.0.1:${UPSTREAM}`
const CHROME_PATH = process.env.CHROME_PATH ?? 'C:/Users/wjun/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe'

const argv = process.argv.slice(2)
const SKIP_BROWSER = argv.includes('--skip-browser')
const onlyIndex = argv.indexOf('--only')
const ONLY = onlyIndex === -1 ? null : (argv[onlyIndex + 1] ?? '')
if (onlyIndex !== -1 && ONLY === '') fatal('--only 需要一个子串参数')

const SUITES = [
  { script: 'e2e-real-data.mjs', browser: false, needsService: false, timeoutMs: 300_000 },
  { script: 'verify-context.mjs', browser: false, needsService: false, timeoutMs: 600_000 },
  { script: 'verify-single-instance.mjs', browser: false, needsService: false, timeoutMs: 600_000 },
  { script: 'verify-clean-probes.mjs', browser: false, needsService: false, timeoutMs: 300_000 },
  { script: 'verify-session-removal.mjs', browser: false, needsService: true, timeoutMs: 300_000 },
  { script: 'verify-canvas.mjs', browser: true, needsService: true, timeoutMs: 180_000 },
  { script: 'verify-detail-rows.mjs', browser: true, needsService: true, timeoutMs: 180_000 },
  { script: 'verify-folding.mjs', browser: true, needsService: true, timeoutMs: 180_000 },
  { script: 'verify-theme.mjs', browser: true, needsService: true, timeoutMs: 180_000 },
  { script: 'verify-ring-levels.mjs', browser: true, needsService: true, timeoutMs: 180_000 },
  { script: 'verify-card-header.mjs', browser: true, needsService: true, timeoutMs: 180_000 },
  { script: 'verify-switch-bar.mjs', browser: true, needsService: true, timeoutMs: 180_000 },
  { script: 'verify-navigation.mjs', browser: true, needsService: true, timeoutMs: 300_000 },
  { script: 'verify-visibility.mjs', browser: true, needsService: true, timeoutMs: 420_000 },
  { script: 'verify-send.mjs', browser: true, needsService: true, timeoutMs: 420_000 },
  { script: 'verify-streaming.mjs', browser: true, needsService: true, timeoutMs: 420_000 },
  { script: 'verify-streaming-card.mjs', browser: true, needsService: true, timeoutMs: 420_000 },
  { script: 'verify-selection-dismiss.mjs', browser: true, needsService: true, timeoutMs: 300_000 },
  { script: 'verify-card-drag.mjs', browser: true, needsService: true, timeoutMs: 300_000 },
  { script: 'verify-image-paste.mjs', browser: true, needsService: true, timeoutMs: 420_000 },
  { script: 'verify-btw.mjs', browser: true, needsService: true, timeoutMs: 600_000 },
  { script: 'verify-branch.mjs', browser: true, needsService: true, timeoutMs: 600_000 },
  { script: 'verify-writes.mjs', browser: true, needsService: true, timeoutMs: 420_000 },
]

function fatal(message) {
  process.stderr.write(`verify: ${message}\n`)
  process.exit(1)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function reachable(url, timeoutMs = 2_000) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return response.status < 500
  } catch {
    return false
  }
}

/**
 * Spawn a child and resolve with `{ code, output }` once it exits.
 *
 * The output is kept in memory for the failure report AND streamed to a log
 * file, because a suite that hangs produces no visible progress otherwise.
 */
function runProcess(command, args, { env, timeoutMs, logPath }) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks = []
    const keep = chunk => {
      chunks.push(String(chunk))
      if (chunks.length > 400) chunks.shift()
    }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    const timer = setTimeout(() => {
      keep(`\nverify: 超时 ${timeoutMs / 1000}s，结束这个子进程\n`)
      child.kill('SIGKILL')
    }, timeoutMs)
    child.on('error', error => {
      clearTimeout(timer)
      keep(`\nverify: 无法启动 ${command}: ${error.message}\n`)
      resolve({ code: 1, output: chunks.join(''), logPath })
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, output: chunks.join(''), logPath })
    })
  })
}

// ---------------------------------------------------------------------------
// preconditions
// ---------------------------------------------------------------------------
if (!(await reachable(`${UPSTREAM_BASE}/`))) {
  fatal(`pi-web 未在 ${UPSTREAM_BASE} 运行。请先启动：npx -y @agegr/pi-web@latest --port ${UPSTREAM} --no-open\n`
    + '      （本脚本不替你启停 pi-web：杀掉用户自己启的 pi-web 比一个明确的报错更糟。）')
}
const selected = SUITES.filter(suite => (ONLY === null || suite.script.includes(ONLY)) && !(SKIP_BROWSER && suite.browser))
if (selected.length === 0) fatal('没有匹配的套件')
if (!SKIP_BROWSER && selected.some(suite => suite.browser) && !existsSync(CHROME_PATH)) {
  fatal(`Chromium 不在 ${CHROME_PATH}（用 CHROME_PATH 指定，或 --skip-browser 只跑非浏览器套件）`)
}
if (await reachable(BASE, 500)) fatal(`端口 ${PORT} 上已经有东西在响应；换 SYNAPSE_VERIFY_PORT 或先停掉它`)

const runRoot = await mkdtemp(join(tmpdir(), '_probe-verify-'))
const dataFile = join(runRoot, 'workspaces.json')
const probeCwd = join(runRoot, 'cwd')
const logDir = join(runRoot, 'logs')
await mkdir(probeCwd, { recursive: true })
await mkdir(logDir, { recursive: true })
process.stdout.write(`verify: run 目录 ${runRoot}\n`)
process.stdout.write(`verify: 画布 ${BASE}（隔离数据文件），上游 pi-web ${UPSTREAM_BASE}\n\n`)

const writeLog = async (name, output) => {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(logDir, `${name}.log`), output, 'utf8')
}

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------
let service = null
async function startService() {
  const log = []
  const child = spawn(process.execPath, [join(ROOT, 'bin/synapse.js'), 'start', '--port', String(PORT), '--upstream', String(UPSTREAM), '--data', dataFile], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let exited = null
  child.on('close', code => { exited = code ?? 1 })
  child.stdout.on('data', chunk => log.push(String(chunk)))
  child.stderr.on('data', chunk => log.push(String(chunk)))
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    if (log.join('').includes('已启动')) return { child, log }
    if (exited !== null) break
    await sleep(200)
  }
  child.kill('SIGKILL')
  throw new Error(`服务未能在 180s 内启动：\n${log.join('')}`)
}

async function stopService() {
  if (service === null) return
  service.kill('SIGKILL')
  service = null
  await sleep(300)
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------
const results = []
let failed = 0
let serviceUp = false
try {
  if (selected.some(suite => suite.needsService)) {
    const started = await startService()
    service = started.child
    serviceUp = true
    process.stdout.write(`verify: 服务已启动（PID ${service.pid}）\n\n`)
    await writeLog('service', started.log.join(''))
  }

  for (const suite of selected) {
    if (suite.needsService && !serviceUp) {
      results.push({ name: suite.script, status: 'SKIP', seconds: 0 })
      process.stdout.write(`SKIP ${suite.script}（服务未启动）\n`)
      continue
    }
    process.stdout.write(`▶ ${suite.script}\n`)
    // Recreate the probe cwd before EVERY suite: some of them remove it when they
    // finish (verify-branch, verify-session-removal), and `POST /api/agent/new`
    // answers 400 `Directory does not exist` for a missing cwd — which reads like
    // "the proxy is broken" rather than "the directory is gone".
    await mkdir(probeCwd, { recursive: true })
    const started = Date.now()
    const run = await runProcess(process.execPath, [join(ROOT, 'scripts', suite.script)], {
      env: { BASE, PROBE_CWD: probeCwd, CHROME_PATH },
      timeoutMs: suite.timeoutMs,
      logPath: join(logDir, `${suite.script}.log`),
    })
    await writeLog(suite.script, run.output)
    const seconds = (Date.now() - started) / 1000
    const status = run.code === 0 ? 'PASS' : 'FAIL'
    if (status === 'FAIL') failed++
    results.push({ name: suite.script, status, seconds })
    process.stdout.write(`${status} ${suite.script}  ${seconds.toFixed(1)}s\n`)
    if (status === 'FAIL') {
      const tail = run.output.trimEnd().split('\n').slice(-30)
      process.stdout.write(`----- ${suite.script} 尾部输出 -----\n${tail.join('\n')}\n-------------------------------\n`)
    }
  }
} catch (error) {
  failed++
  process.stderr.write(`verify: ${error?.message ?? error}\n`)
} finally {
  // Order matters and mirrors docs/verification.md: the service must be down before the
  // probe cleanup, because the store keeps its state in memory and would
  // otherwise write the probe sessions back.
  await stopService()
  const cleanup = await runProcess(process.execPath, [join(ROOT, 'scripts/clean-probes.mjs'), '--data', dataFile], {
    env: {},
    timeoutMs: 120_000,
    logPath: join(logDir, 'clean-probes.log'),
  })
  await writeLog('clean-probes', cleanup.output)
  process.stdout.write(`\n${cleanup.output.trimEnd()}\n`)
}

const width = Math.max(...results.map(result => result.name.length))
process.stdout.write('\n套件'.padEnd(width + 8) + '结果   用时\n')
for (const result of results) {
  process.stdout.write(`${result.name.padEnd(width + 2)}${result.status.padEnd(7)}${result.seconds.toFixed(1)}s\n`)
}
process.stdout.write(`\n合计 ${results.length} 个套件，通过 ${results.filter(r => r.status === 'PASS').length}，失败 ${failed}，跳过 ${results.filter(r => r.status === 'SKIP').length}\n`)

if (failed === 0) {
  await rm(runRoot, { recursive: true, force: true }).catch(() => {})
  process.stdout.write(`verify: 全部通过，run 目录已清理\n`)
  process.exit(0)
}
process.stdout.write(`verify: 有失败，run 目录保留在 ${runRoot}（logs 在 ${logDir}）\n`)
process.exit(1)

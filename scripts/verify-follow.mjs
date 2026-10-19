/**
 * 地图跟着宿主的会话换工作区。
 *
 * 用户报的现象：在宿主里切到另一个目录的会话，画布还停在上一个工作区 ——
 * 画布只在「宿主的会话真的变了」时跟随，而且首次加载时宿主那条
 * current-session 消息发早了（iframe 还没装监听），画布根本不知道宿主在哪，
 * 于是它按「最近活跃」挑一个工作区就再也不动了。
 *
 * 三条规则，都在真实浏览器里验：
 *   1. 打开页面时画布进的是**宿主当前会话所在的工作区**，不是「最近活跃」那个；
 *   2. 宿主的会话换到另一个目录 → 画布跟着换（跨工作区）；
 *   3. 用户自己在画布侧栏选了工作区之后，宿主没动就不许把它拽回去（宿主 1 秒一次
 *      的 postCurrent 只报变化，画布也只认变化）。
 *
 * pi-web 的会话切换本来就是整页导航（`?session=` 只在初始化时读），所以这里验的
 * 主要是规则 1；规则 2 的「不重新加载就跟着走」在 DSH 侧（`npm run verify:dsh`）。
 *
 * 需要 PROBE_CWD 与运行中的服务；造两条真会话（两个目录），结束时删掉目录。
 */
import { chromium } from 'file:///D:/Nodejs/node_global/node_modules/@playwright/mcp/node_modules/playwright-core/index.mjs'
import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

const EXE = process.env.CHROME_PATH ?? 'C:/Users/wjun/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe'
const BASE = process.env.BASE ?? 'http://127.0.0.1:30143'
const PROBE_CWD = process.env.PROBE_CWD
if (PROBE_CWD === undefined) { console.log('需要 PROBE_CWD（一次性会话目录）'); process.exit(1) }
const PROBE_CWD_B = `${PROBE_CWD}-b`
await mkdir(PROBE_CWD, { recursive: true })
await mkdir(PROBE_CWD_B, { recursive: true })
const MODEL = { provider: process.env.PROBE_PROVIDER ?? 'trae', modelId: process.env.PROBE_MODEL ?? 'DeepSeek-V4-Flash' }

const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`) }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** 画布服务端的 JSON API（Node 侧，用来造会话与读工作区）。 */
async function api(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, { ...options, headers: { 'content-type': 'application/json', ...(options.headers ?? {}) } })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status} ${JSON.stringify(body).slice(0, 120)}`)
  return body
}

/** 造一条真会话并发一条 prompt（会话文件落盘才有卡片与工作区）。 */
async function createSession(cwd) {
  const created = await api('/api/agent/new', { method: 'POST', body: JSON.stringify({ cwd, type: 'ensure_session' }) })
  const sessionId = typeof created.sessionId === 'string' ? created.sessionId : null
  if (sessionId === null) throw new Error(`无法创建一次性会话: ${JSON.stringify(created).slice(0, 160)}`)
  const post = payload => api(`/api/agent/${encodeURIComponent(sessionId)}`, { method: 'POST', body: JSON.stringify(payload) })
  await post({ type: 'set_model', ...MODEL })
  await post({ type: 'set_thinking_level', level: 'off' })
  await post({ type: 'prompt', message: '请只回复两个字：好的。' })
  return sessionId
}

/**
 * 等一条会话真的跑完。
 *
 * 两段：先等它**开始**跑，再等它跑完 —— 刚发完 prompt 时 `running` 里还没有它，
 * 只看「不在 running」会立刻返回，结果两条会话的回答谁先落盘变成随机的。
 */
async function settle(sessionId) {
  const running = async () => (await api('/api/agent/running')).runningSessionIds ?? []
  await untilValue(async () => ((await running()).includes(sessionId) ? true : null), 90_000)
  await untilValue(async () => ((await running()).includes(sessionId) ? null : true), 180_000)
}

/**
 * 把第二条工作区从画布数据里去掉（会话本身留给 clean-probes）。
 *
 * 探针留下的工作区会一直在，而且它比共享的探测目录新 —— 后续套件按标题子串选
 * 工作区、画布默认又开「最近活跃」那个，于是它们会选到一个已经删掉的目录
 * （实测：verify-image-paste / -btw / -branch / -streaming-card 四个套件因此失败）。
 * 删掉最后一个线程，工作区会跟着消失（store 对空掉的投影工作区就是这么做），
 * 这个会话也被记进 hiddenSessionIds，不会再被投影拉回来。
 */
async function dropWorkspace(sessionId) {
  const listed = (await api('/synapse/api/workspaces')).workspaces
  for (const summary of listed) {
    const full = await api(`/synapse/api/workspaces/${summary.id}`)
    const thread = full.workspace.threads.find(item => item.sessionId === sessionId)
    if (thread === undefined) continue
    await api(`/synapse/api/threads/${thread.id}`, { method: 'DELETE' })
    return true
  }
  return false
}

/** 轮询到条件成立（投影是异步的：会话文件落盘之后才出现工作区）。 */
async function untilValue(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn().catch(() => null)
    if (value !== null && value !== undefined && value !== false) return value
    if (Date.now() > deadline) return null
    await sleep(1_000)
  }
}

// 服务端回的工作区 cwd 是 Windows 反斜杠，PROBE_CWD 可能是正斜杠（手跑套件时
// 常是），所以比之前先归一化 —— 否则套件会在自己的探针路径上误报。
const samePath = (a, b) => typeof a === 'string' && resolve(a) === resolve(b)
const workspaceIdOf = async cwd => (await api('/synapse/api/workspaces')).workspaces.find(item => samePath(item.cwd, cwd))?.id ?? null

/** 打开宿主页面（带 ?session=），进地图，读画布当前工作区。 */
async function openMapAt(sessionId) {
  await page.goto(`${BASE}/?session=${encodeURIComponent(sessionId)}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3_000)
  await page.locator('.pi-synapse-switch button[data-view="map"]').click()
  await page.waitForTimeout(5_000)
  const frame = page.frames().find(f => f.url().includes('/synapse/'))
  if (frame === undefined) throw new Error('画布 iframe 未加载')
  await frame.waitForSelector('.thread-card, .empty-canvas', { state: 'attached', timeout: 60_000 })
  return frame
}

const canvasState = frame => frame.evaluate(() => ({
  cwd: window.__synapse.state.workspace?.cwd ?? null,
  workspaceId: window.__synapse.state.workspace?.id ?? null,
  hostSession: window.__synapse.state.currentSession?.id ?? null,
}))

const browser = await chromium.launch({ executablePath: EXE, headless: true })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const errors = []
page.on('pageerror', e => errors.push('pageerror: ' + e.message))

let sessionA = null
let sessionB = null
try {
  // A 先造、跑完，再造 B：这样「最近活跃」一定是 B，规则 1 才是可区分的
  // （两条会话并发跑模型的话，谁的回答最后落盘是随机的）。
  sessionA = await createSession(PROBE_CWD)
  console.log('会话 A:', sessionA, '@', PROBE_CWD)
  const workspaceA = await untilValue(() => workspaceIdOf(PROBE_CWD), 90_000)
  await settle(sessionA)

  sessionB = await createSession(PROBE_CWD_B)
  console.log('会话 B:', sessionB, '@', PROBE_CWD_B)
  const workspaceB = await untilValue(() => workspaceIdOf(PROBE_CWD_B), 90_000)
  await settle(sessionB)

  check('两条探测会话各自投影成一个工作区', workspaceA !== null && workspaceB !== null, `${workspaceA} / ${workspaceB}`)
  if (workspaceA === null || workspaceB === null) throw new Error('探测会话没有投影成工作区')

  // 让「最近活跃」与宿主当前会话**不同**，否则规则 1 测不出东西（B 是后造的）。
  const listed = (await api('/synapse/api/workspaces')).workspaces
  const latest = [...listed].sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))[0]
  check('前置：最近活跃的工作区是 B（所以「跟着会话走」和「跟着最近活跃走」可区分）', latest?.id === workspaceB, `latest=${latest?.cwd ?? latest?.id}`)

  // ── 规则 1：打开宿主页面时，画布进宿主会话的工作区 ──
  let frame = await openMapAt(sessionA)
  const atA = await canvasState(frame)
  check('宿主停在 A：画布在 A 的工作区（不是最近活跃的 B）', samePath(atA.cwd, PROBE_CWD), JSON.stringify(atA))
  check('画布知道宿主当前是 A', atA.hostSession === sessionA, `host=${atA.hostSession}`)

  frame = await openMapAt(sessionB)
  const atB = await canvasState(frame)
  check('宿主切到 B：画布在 B 的工作区', samePath(atB.cwd, PROBE_CWD_B), JSON.stringify(atB))

  // ── 规则 3：手动选的工作区不许被宿主的会话拽走 ──
  await frame.locator('select[data-action="select-workspace"]').selectOption(workspaceA)
  await page.waitForTimeout(3_000)
  const picked = await canvasState(frame)
  check('在画布侧栏手动选回 A：画布就在 A', samePath(picked.cwd, PROBE_CWD), JSON.stringify(picked))
  // 宿主那 1 秒一次的 postCurrent 只报「变化」，所以这里等几秒就该纹丝不动。
  await page.waitForTimeout(6_000)
  const stillPicked = await canvasState(frame)
  check('等 6 秒（宿主没动）：画布仍在 A，没被宿主的会话拽回去', stillPicked.workspaceId === workspaceA, JSON.stringify(stillPicked))

  check('全程没有页面错误', errors.length === 0, errors.slice(0, 3).join(' | '))
} catch (error) {
  check('套件自身没有崩', false, String(error?.message ?? error).slice(0, 300))
  console.log(error?.stack ?? error)
} finally {
  await browser.close()
  if (sessionB !== null) await dropWorkspace(sessionB).catch(() => {})
  await rm(PROBE_CWD, { recursive: true, force: true }).catch(() => {})
  await rm(PROBE_CWD_B, { recursive: true, force: true }).catch(() => {})
  const failed = results.filter(item => !item.ok).length
  console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed}，失败 ${failed}`)
  process.exitCode = failed > 0 ? 1 : 0
}

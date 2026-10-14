/**
 * 「哪些会话在地图上」的两条规则，在真实浏览器里验证：
 *
 *   1. 默认只画最近 7 天有活动的会话；更早的默认收起，侧栏那一行标「7 天前」。
 *   2. 侧栏每一行有一个眼睛按钮：点一下就收起/放回这条会话的卡片，并且**写进
 *      画布数据文件**（重新加载、换浏览器都还生效）。
 *
 * 卡片集合看的是画布自己的 card 模型（`state.canvasCards`），不是 DOM：地图上的
 * 卡片是虚拟化的，视口外的卡本来就不在 DOM 里 —— 只看「DOM 里没有这张卡」会把
 * 虚拟化当成「已收起」。
 *
 * 顺序很关键：工作区标题来自 cwd，所以**必须先造出会话**，画布的工作区下拉里
 * 才会有那一项；按 cwd 精确匹配工作区 id，而不是拿标题去撞（两个同名目录会选错）。
 *
 * 需要 PROBE_CWD 与运行中的服务（BASE）。会创建一个一次性会话；为了验证「7 天」
 * 这条规则还会**直接写一个 8 天前的探测会话文件**（没法等七天，而投影读的就是
 * 文件，所以这是真实输入而不是替身），脚本结束时删掉它。
 */
import { chromium } from 'file:///D:/Nodejs/node_global/node_modules/@playwright/mcp/node_modules/playwright-core/index.mjs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const EXE = process.env.CHROME_PATH ?? 'C:/Users/wjun/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe'
const BASE = process.env.BASE ?? 'http://127.0.0.1:30143'
const PROBE_CWD = process.env.PROBE_CWD
if (PROBE_CWD === undefined) { console.log('需要 PROBE_CWD（一次性会话目录）'); process.exit(1) }
await mkdir(PROBE_CWD, { recursive: true })
const MODEL = { provider: 'trae', modelId: 'DeepSeek-V4-Flash' }

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

/** 画布服务端的 JSON API（Node 侧，用于造会话与读状态）。 */
async function api(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, { ...options, headers: { 'content-type': 'application/json', ...(options.headers ?? {}) } })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status} ${JSON.stringify(body).slice(0, 120)}`)
  return body
}

/** 轮询一个 Node 侧的判断，返回第一个非空结果。 */
async function untilValue(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn().catch(() => null)
    if (value !== null && value !== undefined && value !== false) return value
    if (Date.now() > deadline) return null
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
}

/** 造一条真实的一次性会话并发一条 prompt（会话文件落盘才有卡片）。 */
async function createProbeSession() {
  const created = await api('/api/agent/new', { method: 'POST', body: JSON.stringify({ cwd: PROBE_CWD, type: 'ensure_session' }) })
  const sessionId = typeof created.sessionId === 'string' ? created.sessionId : null
  if (sessionId === null) throw new Error(`无法创建一次性会话: ${JSON.stringify(created).slice(0, 160)}`)
  const post = payload => api(`/api/agent/${encodeURIComponent(sessionId)}`, { method: 'POST', body: JSON.stringify(payload) })
  await post({ type: 'set_model', ...MODEL })
  await post({ type: 'set_thinking_level', level: 'off' })
  await post({ type: 'prompt', message: '请只回复两个字：好的。' })
  return sessionId
}

async function probeWorkspaceId() {
  const list = await api('/synapse/api/workspaces')
  const summary = list.workspaces.find(item => item.cwd === PROBE_CWD)
  return summary?.id ?? null
}

const browser = await chromium.launch({ executablePath: EXE, headless: true })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const errors = []
page.on('pageerror', e => errors.push('pageerror: ' + e.message))

const WORKSPACE_SELECT = 'select[data-action="select-workspace"]'

/** 打开画布并切到指定工作区（按 value = 工作区 id 选，不撞标题）。 */
async function openWorkspace(workspaceId) {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3000)
  await page.locator('.pi-synapse-switch button[data-view="map"]').click()
  await page.waitForTimeout(4000)
  const frame = page.frames().find(f => f.url().includes('/synapse/'))
  if (frame === undefined) throw new Error('画布 iframe 未加载')
  const present = await frame.evaluate(({ selector, id }) => document.querySelector(`${selector} option[value="${id}"]`) !== null, { selector: WORKSPACE_SELECT, id: workspaceId })
  if (!present) {
    const options = await frame.locator(`${WORKSPACE_SELECT} option`).allTextContents()
    throw new Error(`画布的工作区列表里没有 ${workspaceId}：现有 ${options.length} 个 ${JSON.stringify(options.slice(0, 8))}`)
  }
  await frame.locator(WORKSPACE_SELECT).selectOption(workspaceId)
  await page.waitForTimeout(3000)
  return frame
}

/** 画布认为这条会话有几张卡 + 侧栏那一行的状态（读画布自己的状态，不猜）。 */
const inspect = (frame, sessionId) => frame.evaluate(id => {
  const { state } = window.__synapse
  const thread = (state.workspace?.threads ?? []).find(item => item.sessionId === id)
  const cards = (state.canvasCards ?? []).filter(card => card.hostThreadId === thread?.id)
  const toggle = thread === undefined ? null : document.querySelector(`[data-action="toggle-visibility"][data-thread="${thread.id}"]`)
  const row = toggle?.closest('.tree-item') ?? null
  const iconRect = toggle?.querySelector('svg')?.getBoundingClientRect()
  return {
    threadFound: thread !== undefined,
    threadId: thread?.id ?? null,
    hidden: thread?.hidden ?? null,
    cards: cards.length,
    rowOff: row === null ? null : row.classList.contains('is-off'),
    pressed: toggle?.getAttribute('aria-pressed') ?? null,
    toggleTitle: toggle?.getAttribute('title') ?? null,
    // 图标可见性：本仓的 svg 逐容器定尺寸，漏写就是「按钮在、图标 0×0」
    iconPx: iconRect === undefined ? 0 : Math.round(iconRect.width),
    badge: row?.querySelector('.tree-row i')?.textContent ?? null,
    countLabel: document.querySelector('.sidebar-count')?.textContent ?? null,
  }
}, sessionId)

const clickToggle = (frame, threadId) => frame.evaluate(tid => {
  const button = document.querySelector(`[data-action="toggle-visibility"][data-thread="${tid}"]`)
  button?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  return button !== null
}, threadId)

/** 轮询画布状态，返回第一个满足条件的结果。 */
async function untilInspect(frame, sessionId, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const seen = await inspect(frame, sessionId)
    if (predicate(seen)) return seen
    if (Date.now() > deadline) return null
    await page.waitForTimeout(1000)
  }
}

let created = null
let staleFile = null
try {
  // 先造会话：工作区标题来自 cwd，没有会话就没有那个工作区。
  created = await createProbeSession()
  console.log('一次性会话:', created)
  const workspaceId = await untilValue(probeWorkspaceId, 60_000)
  if (workspaceId === null) throw new Error('服务端没有把探测会话投影成工作区')
  let frame = await openWorkspace(workspaceId)

  const fresh = await untilInspect(frame, created, seen => seen.threadFound && seen.cards > 0, 90_000)
  check('最近活跃的会话默认就在画布上', fresh !== null, JSON.stringify(fresh))
  if (fresh === null) throw new Error('探测会话没有投影成卡片')
  // 等它跑完再动它：一边流式追加一边改可见性，测出来的东西说不清。
  await untilValue(async () => {
    const running = await api('/api/agent/running')
    return (running.runningSessionIds ?? []).includes(created) ? null : true
  }, 120_000)

  const freshThreadId = fresh.threadId
  check('侧栏那一行的眼睛是「显示中」', fresh.rowOff === false && fresh.pressed === 'false', JSON.stringify({ rowOff: fresh.rowOff, pressed: fresh.pressed, title: fresh.toggleTitle }))
  check('眼睛图标真的画出来了（不是 0×0）', fresh.iconPx >= 10, `icon=${fresh.iconPx}px`)

  // ── 收起：卡片离开画布，状态写进服务端 ──
  check('点到眼睛按钮', await clickToggle(frame, freshThreadId))
  const hidden = await untilInspect(frame, created, seen => seen.cards === 0 && seen.hidden === true, 20_000)
  check('收起后卡片不再出现在画布上', hidden !== null && hidden.cards === 0, JSON.stringify({ cards: hidden?.cards }))
  check('收起后那一行标成 off', hidden?.rowOff === true && hidden?.pressed === 'true', JSON.stringify({ rowOff: hidden?.rowOff, pressed: hidden?.pressed, title: hidden?.toggleTitle }))
  check('服务端记住了（thread.hidden = true）', hidden?.hidden === true, `hidden=${String(hidden?.hidden)}`)

  // ── 重新加载：收起状态跨页面加载有效，而那一行仍然在（可逆）──
  frame = await openWorkspace(workspaceId)
  const reloaded = await untilInspect(frame, created, seen => seen.threadFound, 60_000)
  check('重新加载后仍然是收起的', reloaded !== null && reloaded.cards === 0 && reloaded.hidden === true, JSON.stringify({ cards: reloaded?.cards, hidden: reloaded?.hidden }))
  check('收起后侧栏仍然列出这条会话（还能放回来）', reloaded?.threadFound === true, JSON.stringify({ found: reloaded?.threadFound }))

  // ── 放回 ──
  check('再点一次眼睛按钮', await clickToggle(frame, freshThreadId))
  const shown = await untilInspect(frame, created, seen => seen.cards > 0 && seen.hidden === false, 20_000)
  check('放回后卡片回到画布', shown !== null && shown.cards > 0, JSON.stringify({ cards: shown?.cards }))
  check('服务端记住了（thread.hidden = false）', shown?.hidden === false, `hidden=${String(shown?.hidden)}`)

  // ── 7 天规则：写一条 8 天前的真实会话文件 ──
  const sessionFile = await frame.evaluate(async sessionId => {
    const list = await (await fetch('/synapse/api/workspaces')).json()
    for (const summary of list.workspaces) {
      const full = await (await fetch(`/synapse/api/workspaces/${summary.id}`)).json()
      const hit = full.workspace.threads.find(thread => thread.sessionId === sessionId)
      if (hit !== undefined) return hit.sessionFile ?? null
    }
    return null
  }, created)
  if (typeof sessionFile !== 'string') throw new Error('拿不到探测会话的文件路径')
  const staleId = `stale-${Date.now()}`
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
  const stamp = eightDaysAgo.toISOString().replaceAll(':', '-')
  staleFile = join(dirname(sessionFile), `${stamp}_${staleId}.jsonl`)
  const lines = [
    JSON.stringify({ type: 'session', version: 3, id: staleId, timestamp: eightDaysAgo.toISOString(), cwd: PROBE_CWD }),
    JSON.stringify({ type: 'message', id: 'e1', parentId: null, timestamp: eightDaysAgo.toISOString(), message: { role: 'user', content: [{ type: 'text', text: '八天前的老会话' }], timestamp: 1 } }),
    JSON.stringify({ type: 'message', id: 'e2', parentId: 'e1', timestamp: eightDaysAgo.toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: '八天前的回答' }], timestamp: 2 } }),
  ]
  await writeFile(staleFile, `${lines.join('\n')}\n`)

  const stale = await untilInspect(frame, staleId, seen => seen.threadFound, 60_000)
  check('8 天前的会话默认不在画布上', stale !== null && stale.cards === 0, JSON.stringify({ found: stale?.threadFound, cards: stale?.cards }))
  check('那一行标出「7 天前」并且眼睛是 off', stale?.badge === '7 天前' && stale?.pressed === 'true', JSON.stringify({ badge: stale?.badge, pressed: stale?.pressed }))
  check('计数显示「显示中 / 全部」', typeof stale?.countLabel === 'string' && stale.countLabel.includes('/'), `count=${String(stale?.countLabel)}`)

  check('点开这条老会话', await clickToggle(frame, stale.threadId))
  const staleShown = await untilInspect(frame, staleId, seen => seen.cards > 0, 20_000)
  check('老会话被手动放回画布（覆盖默认）', staleShown !== null && staleShown.cards > 0, JSON.stringify({ cards: staleShown?.cards, hidden: staleShown?.hidden }))
} catch (error) {
  check('验证过程无异常', false, error?.message ?? String(error))
} finally {
  await browser.close()
  if (staleFile !== null) await rm(staleFile, { force: true }).catch(() => {})
}

const failed = results.filter(result => !result.ok)
console.log('页面错误:', errors.length ? errors.slice(0, 3) : '无')
console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
if (failed.length > 0) {
  console.log('失败项:', failed.map(result => result.name).join('；'))
  process.exit(1)
}

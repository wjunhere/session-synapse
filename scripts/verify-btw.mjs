// 验证 #1 上下文圆圈 + #2 /btw 侧问（fork + 只读工具 + 自动归档）
//
// 全部操作都在一次性会话上做；脚本只读地报告，清理由调用方完成。
import { chromium } from 'file:///D:/Nodejs/node_global/node_modules/@playwright/mcp/node_modules/playwright-core/index.mjs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EXE = process.env.CHROME_PATH ?? 'C:/Users/wjun/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe'
const BASE = process.env.BASE ?? 'http://127.0.0.1:30143'
const PROBE_CWD = process.env.PROBE_CWD
// The probe model is overridable for the same reason as in verify-streaming-card:
// a provider can go down wholesale (empty assistant bodies, no error surfaced),
// and then every "the button is missing" check is really "there was no answer".
const MODEL = { provider: process.env.PROBE_PROVIDER ?? 'trae', modelId: process.env.PROBE_MODEL ?? 'DeepSeek-V4-Flash' }
const READ_ONLY = ['read', 'grep', 'find', 'ls']

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
}

const browser = await chromium.launch({ executablePath: EXE })
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
const errors = []
page.on('pageerror', e => errors.push('pageerror: ' + e.message))
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()) })

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2000)

// ---------- 一次性会话 ----------
const created = await page.evaluate(async ({ cwd, model }) => {
  const r = await fetch('/api/agent/new', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd, type: 'ensure_session' }),
  })
  const b = await r.json()
  if (typeof b.sessionId !== 'string') return null
  await fetch(`/api/agent/${b.sessionId}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'set_model', ...model }),
  })
  await fetch(`/api/agent/${b.sessionId}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'prompt', message: '请只回复两个字：好的。' }),
  })
  return b.sessionId
}, { cwd: PROBE_CWD, model: MODEL })
console.log('一次性会话:', created)
if (created === null) { console.log('创建失败'); await browser.close(); process.exit(1) }

// 等第一轮跑完并落盘
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(3000)
  const running = await page.evaluate(async () => (await (await fetch('/api/agent/running')).json()).runningSessionIds ?? [])
  const hasAssistant = await page.evaluate(async sid => {
    const msgs = await (await fetch(`/api/sessions/${sid}/context`)).json()
    return (msgs.messages ?? []).some(m => m.role === 'assistant' && String(m.content ?? '').trim() !== '')
  }, created)
  if (!running.includes(created) && hasAssistant) break
}
check('一次性会话产出助手回复', true)

// ---------- 打开画布 ----------
await page.locator('.pi-synapse-switch button[data-view="map"]').click()
await page.waitForTimeout(4000)
const frame = page.frames().find(f => f.url().includes('/synapse/'))
check('画布 iframe 已加载', frame !== undefined)
if (frame === undefined) { await browser.close(); process.exit(1) }

const probeTitle = PROBE_CWD.split(/[\\/]/).filter(Boolean).at(-1)
let opts = []
for (let i = 0; i < 15; i++) {
  opts = await frame.locator('select option').allTextContents()
  if (opts.some(o => o.includes(probeTitle))) break
  await page.waitForTimeout(3000)
}
check('探测工作区出现在画布', opts.some(o => o.includes(probeTitle)), opts.slice(0, 5).join(' | '))
await frame.locator('select').selectOption({ label: opts.find(o => o.includes(probeTitle)) })
await page.waitForTimeout(5000)
// 画布只挂载视口附近的卡片；探测工作区会累积历史产物，
// 故先「定位」到当前会话，否则目标卡片不在 DOM 里。
await frame.evaluate(() => {
  const button = document.querySelector('[data-action="focus-active"]')
  if (button !== null) button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
})
await page.waitForTimeout(1500)

// ---------- #1 上下文圆圈 ----------
const ring = await frame.evaluate(() => {
  const el = document.querySelector('.thread-card .context-ring')
  if (el === null) return null
  const arc = el.querySelector('.context-ring-arc')
  return {
    label: el.getAttribute('aria-label'),
    dash: arc?.getAttribute('stroke-dasharray') ?? null,
    track: el.querySelector('.context-ring-track')?.getAttribute('r') ?? null,
    tip: el.querySelector('.context-ring-tip')?.textContent ?? null,
    color: getComputedStyle(el).color,
  }
})
check('卡片渲染出上下文圆圈', ring !== null, JSON.stringify(ring))
if (ring !== null) {
  // 弧长必须等于周长的百分比，否则「圆圈线条张长多少」就是假的
  const r = Number(ring.track)
  const circumference = 2 * Math.PI * r
  const [arcLen] = String(ring.dash).split(' ').map(Number)
  const percentMatch = /([\d.]+)%/.exec(ring.label ?? '')
  // label 的百分比四舍五入到 0.1%，所以真实占用落在 ±0.05% 区间内。正确的断言
  // 是「弧长落在该区间对应的弧长范围内」，而不是拿一个拍脑袋的固定容差去比 ——
  // 在 1M 窗口上 0.05% 就是 0.028 的弧长，固定容差 0.01/0.02 都会偶发误报。
  const percent = Number(percentMatch?.[1] ?? '0')
  const tolerance = circumference * 0.0005
  const expected = circumference * percent / 100
  check('弧长 = 周长 × 占用百分比', Math.abs(arcLen - expected) <= tolerance, `arc=${arcLen.toFixed(3)} expected=${expected.toFixed(3)} ±${tolerance.toFixed(3)}`)
  const strokeColor = await frame.evaluate(() => {
    const arc = document.querySelector('.thread-card .context-ring-arc')
    return arc === null ? null : getComputedStyle(arc).stroke
  })
  check('圆圈有可见描边色', typeof strokeColor === 'string' && strokeColor !== 'none', String(strokeColor))
  check('悬停提示含 已用/总量', /\/\s*[\d.]+k?/.test(ring.tip ?? ''), String(ring.tip))
}

// ---------- #2 /btw ----------
const threadsBefore = await page.evaluate(async () => {
  const list = (await (await fetch('/synapse/api/workspaces')).json()).workspaces
  let n = 0
  for (const w of list) n += ((await (await fetch(`/synapse/api/workspaces/${w.id}`)).json()).workspace.threads ?? []).length
  return n
})

const btwButtonExists = await frame.evaluate(() => document.querySelectorAll('[data-action="open-btw"]').length)
check('卡片上有 btw 按钮', btwButtonExists > 0, `count=${btwButtonExists}`)

// 通过 sessionId → threadId 精确定位，避免命中历史探测会话
const threadIdFor = async sessionId => {
  const list = await page.evaluate(async () => (await (await fetch('/synapse/api/workspaces')).json()).workspaces)
  for (const w of list) {
    const full = await page.evaluate(async id => (await (await fetch(`/synapse/api/workspaces/${id}`)).json()).workspace, w.id)
    const hit = full.threads.find(t => t.sessionId === sessionId)
    if (hit) return hit.id
  }
  return null
}
const probeThreadId = await threadIdFor(created)
check('探测会话已投影成画布卡片', probeThreadId !== null)

// 点击探测卡片上的 btw 按钮。卡片可能因虚拟化未挂载，先定位并等待。
// 先点侧栏那一行把这条会话选中并聚焦到视野中央。同一个探测 cwd 会累积多轮
// 探测的 thread，「定位」按钮聚焦的是 activeId 那条 —— 不先选中，目标卡片常常
// 根本没挂载（虚拟化只挂视口附近的卡），于是「按钮点不到」被误报成功能坏了。
await frame.evaluate(tid => {
  const row = document.querySelector(`.tree-row[data-thread="${tid}"]`)
  row?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}, probeThreadId)
await page.waitForTimeout(2000)

let clicked = false
for (let i = 0; i < 10 && !clicked; i++) {
  clicked = await frame.evaluate(tid => {
    const button = [...document.querySelectorAll('[data-action="open-btw"]')].find(b => b.dataset.thread === tid)
    if (button === undefined) return false
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return true
  }, probeThreadId)
  if (!clicked) {
    await frame.evaluate(tid => {
      const row = document.querySelector(`.tree-row[data-thread="${tid}"]`)
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      const focus = document.querySelector('[data-action="focus-active"]')
      if (focus !== null) focus.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    }, probeThreadId)
    await page.waitForTimeout(1500)
  }
}
check('btw 按钮可点击', clicked)
await page.waitForTimeout(1200)

const draftShown = await frame.evaluate(() => document.querySelector('[data-draft] textarea') !== null)
check('btw 打开追问草稿', draftShown)

// 填问题并提交
const draftReady = await frame.evaluate(() => document.querySelector('[data-draft] textarea') !== null)
check('btw 草稿就绪', draftReady)
if (!draftReady) {
  console.log('草稿未出现，无法继续')
  await browser.close()
  process.exit(1)
}
await frame.evaluate(() => {
  const textarea = document.querySelector('[data-draft] textarea')
  textarea.value = '刚才你回复了什么？只回答那两个字。'
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
})
await frame.evaluate(() => {
  document.querySelector('[data-draft]')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
})

// 等 btw 会话建立。必须按 parentId 限定到本地这次的父卡片：画布数据会累积
// 历史探测的 thread，取「任意一个 kind==='btw'」会命中上一次运行的产物。
let forked = null
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(3000)
  forked = await page.evaluate(async parentThreadId => {
    const list = (await (await fetch('/synapse/api/workspaces')).json()).workspaces
    for (const w of list) {
      const threads = (await (await fetch(`/synapse/api/workspaces/${w.id}`)).json()).workspace.threads
      const hit = threads.find(t => t.kind === 'btw' && t.parentId === parentThreadId)
      if (hit) return hit
    }
    return null
  }, probeThreadId)
  if (forked !== null) break
}
check('btw 会话已登记到画布', forked !== null, forked === null ? '' : `sessionId=${forked.sessionId}`)

if (forked !== null) {
  check('btw 是 fork 出来的新会话', forked.sessionId !== created, `parent=${created} child=${forked.sessionId}`)
  check('btw 固定为只读工具', JSON.stringify(forked.tools) === JSON.stringify(READ_ONLY), JSON.stringify(forked.tools))
  check('btw 挂在父卡片下', forked.parentId === probeThreadId)

  // 落盘验证：fork 继承了父会话的条目（真·上下文继承）
  const inherited = await page.evaluate(async sid => {
    const b = await (await fetch(`/api/sessions/${encodeURIComponent(sid)}`)).json()
    return { path: b.info?.path ?? null, messageCount: b.info?.messageCount ?? null }
  }, forked.sessionId)
  check('btw 会话已落盘', typeof inherited.path === 'string' && inherited.path.includes('sessions'), JSON.stringify(inherited))

  // pi-web 归档验证
  const uiState = await page.evaluate(async sid => {
    const s = await (await fetch('/api/sessions/ui-state')).json()
    return s.state?.sessions?.[sid] ?? null
  }, forked.sessionId)
  check('btw 已在 pi-web 自动归档', uiState?.archivedAt !== undefined && uiState?.archivedAt !== null, JSON.stringify(uiState))

  // 归档视图仍可见（路线 2 的核心承诺：能追问）
  const archiveView = await page.evaluate(async sid => {
    const list = await (await fetch('/api/sessions')).json()
    return (list.sessions ?? []).some(s => s.id === sid)
  }, forked.sessionId)
  check('btw 仍在会话列表中（归档视图可见、可继续）', archiveView)
}

// 画布上出现 btw 挂件。必须按 data-btw-widget 精确定位到本次的 thread：
// 画布数据会累积历史探测的产物，取「第一个 .btw-widget」会命中旧挂件。
// 画布每 ~1s 轮询一次投影，所以这里要给它几次机会，而不是只看一眼。
let widget = null
for (let i = 0; i < 10; i++) {
  widget = await frame.evaluate(tid => {
    const el = document.querySelector(`.btw-widget[data-btw-widget="${tid}"]`)
    if (el === null) return null
    return {
      badge: el.querySelector('.btw-widget-badge')?.textContent ?? '',
      title: el.querySelector('.btw-widget-title')?.textContent ?? '',
      left: el.style.left,
      top: el.style.top,
    }
  }, forked?.id ?? '')
  if (widget !== null) break
  await page.waitForTimeout(1500)
}
check('画布渲染 btw 挂件', widget !== null, JSON.stringify(widget))

// 点挂件 → 打开该侧问的详情，且在那里可以继续追问（路线 2 的核心承诺）
if (forked !== null) {
  const opened = await frame.evaluate(tid => {
    const button = document.querySelector(`.btw-widget[data-btw-widget="${tid}"] .btw-widget-open`)
    if (button === null) return false
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return true
  }, forked.id)
  await page.waitForTimeout(1500)
  const detail = await frame.evaluate(() => ({
    open: document.querySelector('.detail-view') !== null,
    badge: document.querySelector('.detail-badge')?.textContent?.trim() ?? '',
    hasComposer: document.querySelector('.message-composer textarea') !== null,
    tools: document.querySelector('.detail-tools')?.textContent?.trim() ?? '',
    // 无锚点进入详情应落在最新消息：视区里要能看到最后一条，或滚动已到底。
    landedOnLatest: (() => {
      const scroller = document.querySelector('.detail-scroll')
      if (scroller === null) return null
      const messages = [...scroller.querySelectorAll('.message')]
      const rect = scroller.getBoundingClientRect()
      const visible = messages.filter(el => { const r = el.getBoundingClientRect(); return r.bottom > rect.top && r.top < rect.bottom })
      const lastSeq = messages.at(-1)?.dataset.messageSeq ?? null
      return { total: messages.length, atEnd: visible.some(el => el.dataset.messageSeq === lastSeq) || scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 80 }
    })(),
  }))
  check('点挂件打开侧问详情', opened && detail.open, JSON.stringify(detail))
  check('详情标注为侧问', detail.badge === '侧问', detail.badge)
  check('侧问里可以继续追问', detail.hasComposer)
  check('详情显示只读工具数', /\d/.test(detail.tools), detail.tools)
  check('挂件进入详情落在最新消息', detail.landedOnLatest === null || detail.landedOnLatest.total <= 1 || detail.landedOnLatest.atEnd === true, JSON.stringify(detail.landedOnLatest))
}

const after = await page.evaluate(async () => {
  const list = (await (await fetch('/synapse/api/workspaces')).json()).workspaces
  let n = 0
  for (const w of list) n += ((await (await fetch(`/synapse/api/workspaces/${w.id}`)).json()).workspace.threads ?? []).length
  return n
})
check('画布 thread 数增加 1', after === threadsBefore + 1, `${threadsBefore} → ${after}`)

// 截图写到系统临时目录（以前写死在仓库的 _btw/ 下，成了没人清的残渣）
await page.screenshot({ path: join(tmpdir(), 'synapse-verify-btw.png'), fullPage: false })

// btw 完成后回到画布截图（挂件与圆圈同框）
await page.waitForTimeout(4000)
await frame.locator('[data-action="show-canvas"]').first().click().catch(() => {})
await page.waitForTimeout(2500)
await page.screenshot({ path: join(tmpdir(), 'synapse-verify-btw-canvas.png') })

const failed = results.filter(r => !r.ok)
console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
console.log('页面错误:', errors.length ? errors.slice(0, 5) : '无')
if (forked !== null) console.log('btw sessionId（清理用）:', forked.sessionId)
await browser.close()
process.exit(failed.length === 0 ? 0 : 1)

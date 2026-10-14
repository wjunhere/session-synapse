// 会话进行中的卡片要有蓝色动效提示。
//
// 流程：一次性会话发真实 prompt → 打开画布 → 断言该会话最新一张卡片带
// `.is-streaming` 且边框是 --info 色 → 回复结束后断言类消失。
//
// 注意：验证的是浏览器里真实可见的计算样式，不是类名本身 —— 类挂上了但 CSS
// 没写（或被动画层覆盖）同样是坏的。
import { chromium } from 'file:///D:/Nodejs/node_global/node_modules/@playwright/mcp/node_modules/playwright-core/index.mjs'
import { mkdir } from 'node:fs/promises'

const EXE = process.env.CHROME_PATH ?? 'C:/Users/wjun/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe'
const BASE = process.env.BASE ?? 'http://127.0.0.1:30143'
const PROBE_CWD = process.env.PROBE_CWD
const MODEL = { provider: 'trae', modelId: 'DeepSeek-V4-Flash' }
// PROBE_CWD 必须先存在：POST /api/agent/new 对不存在的目录返回 400（不是「代理坏了」）。
await mkdir(PROBE_CWD, { recursive: true })

const browser = await chromium.launch({ executablePath: EXE })
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
const errors = []
page.on('pageerror', e => errors.push('pageerror: ' + e.message))

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2500)

// 一次性会话，先换成可用模型再发一条会花时间的 prompt
const created = await page.evaluate(async ({ cwd, model }) => {
  const r = await fetch('/api/agent/new', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd, type: 'ensure_session' }) })
  const b = await r.json()
  if (typeof b.sessionId !== 'string') return null
  await fetch(`/api/agent/${encodeURIComponent(b.sessionId)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'set_model', ...model }),
  })
  return b.sessionId
}, { cwd: PROBE_CWD, model: MODEL })
console.log('一次性会话:', created)
if (created === null) { console.log('创建失败'); await browser.close(); process.exit(1) }

// 发一条会花时间的 prompt：本脚本要验证的就是「进行中」状态，没有真实
// 流式回复就测不到。会话用一次性 cwd，测完由调用方清理（与 verify-send 同
// 一路数）。
const prompted = await page.evaluate(async ({ id, model }) => {
  await fetch(`/api/agent/${encodeURIComponent(id)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'set_model', ...model }),
  })
  const r = await fetch(`/api/agent/${encodeURIComponent(id)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'prompt', message: '请只回复两个字：好的。' }),
  })
  return r.json()
}, { id: created, model: MODEL })
console.log('prompt 受理:', prompted.success === true ? 'ok' : JSON.stringify(prompted).slice(0, 120))

// 打开画布，切到探测工作区
await page.locator('.pi-synapse-switch button[data-view="map"]').click()
await page.waitForTimeout(4500)
const frame = page.frames().find(f => f.url().includes('/synapse/'))
const probeTitle = PROBE_CWD.split(/[\\/]/).filter(Boolean).at(-1)
let opts = []
for (let i = 0; i < 15; i++) {
  opts = await frame.locator('select option').allTextContents()
  if (opts.some(o => o.includes(probeTitle))) break
  await page.waitForTimeout(3000)
}
await frame.locator('select').selectOption({ label: opts.find(o => o.includes(probeTitle)) })
await page.waitForTimeout(4000)

// 从画布内发一条追问（走真实的 pendingReplies → 流式回复链路）
// 只能在探测工作区里找 thread：画布数据累积了所有工作区的会话，「第一个有
// sessionId 的 thread」会命中别人的会话，得出错误的结论。投影由会话文件驱动，
// 新会话要等落盘后重扫才出现，所以这里必须轮询等待。
// 必须按 sessionId 精确定位到本次创建的会话：探测工作区会累积历史运行的 thread，
// 取「第一条有 sessionId 的 thread」是在对别人的会话做断言（已经踩过）。
let threadId = null
for (let i = 0; i < 20 && threadId === null; i++) {
  await page.waitForTimeout(3000)
  threadId = await frame.evaluate(async sessionId => {
    const list = await (await fetch('/synapse/api/workspaces')).json()
    for (const w of list.workspaces) {
      const full = await (await fetch(`/synapse/api/workspaces/${w.id}`)).json()
      const hit = full.workspace.threads.find(t => t.sessionId === sessionId)
      if (hit) return hit.id
    }
    return null
  }, created)
}
console.log('threadId:', threadId)
if (threadId === null) { console.log('FAIL 探测会话未投影成卡片'); await browser.close(); process.exit(1) }

// 卡片可能未挂载（虚拟化只挂视口附近的卡），而且新会话不一定是 active thread。
// 先点侧栏那一行把它选中并聚焦到视野中央，再找卡上的按钮。
await frame.evaluate(tid => document.querySelector(`.tree-row[data-thread="${tid}"]`)?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })), threadId)
await page.waitForTimeout(2000)
await frame.evaluate(() => document.querySelector('[data-action="focus-active"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
await page.waitForTimeout(1500)
const cards = await frame.evaluate(tid => document.querySelectorAll(`.thread-card[data-thread="${tid}"]`).length, threadId)
console.log('当前卡片数:', cards)
const opened = await frame.evaluate(tid => {
  const button = [...document.querySelectorAll('.graph-continue-button')].find(b => b.dataset.thread === tid)
  if (button === undefined) return false
  button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  return true
}, threadId)
console.log('追问框打开:', opened)
if (!opened) { console.log('FAIL 卡片上没有追问按钮'); await browser.close(); process.exit(1) }
await frame.evaluate(() => {
  const textarea = document.querySelector('[data-draft] textarea')
  textarea.value = '请从 1 数到 15，每个数字单独一行，不要用任何工具。'
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
})
await frame.evaluate(() => document.querySelector('[data-draft]')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))

// 提交后立刻采样：pendingReplies 已同步置位，卡片此刻就应该亮
const during = []
for (let i = 0; i < 10; i++) {
  await page.waitForTimeout(2500)
  const state = await frame.evaluate(tid => {
    const cards = [...document.querySelectorAll(`.thread-card[data-thread="${tid}"]`)]
    const card = cards.at(-1)
    if (card === undefined) return null
    const cs = getComputedStyle(card)
    return {
      cls: card.classList.contains('is-streaming'),
      border: cs.borderColor,
      animation: cs.animationName,
      text: card.querySelector('.thread-answer')?.textContent?.slice(0, 24) ?? '',
    }
  }, threadId)
  during.push(state)
  console.log(`  t=${(i + 1) * 2.5}s`, JSON.stringify(state))
  if (state !== null && state.cls === false && during.length > 2) break
}

const lit = during.filter(s => s?.cls === true)
const blue = during.filter(s => s?.cls === true && /31,\s*108,\s*159/.test(s.border) === true)
const animated = lit.some(s => s.animation === 'card-streaming' || s.animation === 'card-streaming-dark')

// 等回复结束（agent 不在 running 里且画布上类已消失）
let settled = false
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(3000)
  const running = await page.evaluate(async () => (await (await fetch('/api/agent/running')).json()).runningSessionIds ?? [])
  const cls = await frame.evaluate(tid => document.querySelector(`.thread-card[data-thread="${tid}"].is-streaming`) !== null, threadId)
  if (!running.includes(created) && cls === false) { settled = true; break }
}

// 失败时把「宿主说还在跑」与「画布自己以为在跑」分开：两者的修法完全不同
const diagnosis = await frame.evaluate(sessionId => {
  // 画布内部状态：模块化后不再有裸 `state` 全局，改用画布显式暴露的句柄。
  const { state } = window.__synapse
  const thread = state.workspace?.threads.find(item => item.sessionId === sessionId)
  const cards = thread === undefined ? [] : [...document.querySelectorAll(`.thread-card[data-thread="${thread.id}"]`)]
  return {
    threadFound: thread !== undefined,
    pendingReply: state.pendingReplies.has(sessionId),
    liveReply: state.liveReplies.get(sessionId) ?? null,
    markedForThisThread: cards.filter(card => card.classList.contains('is-streaming')).length,
    cardsForThisThread: cards.length,
    markedAnywhere: document.querySelectorAll('.thread-card.is-streaming').length,
  }
}, created)
const stillRunningOnHost = await page.evaluate(async () => (await (await fetch('/api/agent/running')).json()).runningSessionIds ?? [])
console.log('诊断:', JSON.stringify(diagnosis), '宿主仍在跑:', JSON.stringify(stillRunningOnHost.includes(created)))

console.log()
console.log(`流式期间亮起的采样: ${lit.length}/${during.length}`)
console.log(lit.length > 0 ? 'PASS 进行中的卡片带 is-streaming 类' : 'FAIL 进行中的卡片没有动效类')
console.log(blue.length === lit.length ? 'PASS 边框是蓝色（--info）' : `FAIL 边框颜色不是蓝（${lit.find(s => true)?.border ?? '—'}）`)
console.log(animated ? 'PASS 呼吸动画在播（card-streaming）' : 'FAIL 动画名不是 card-streaming')
console.log(settled ? 'PASS 回复结束后动效消失' : 'FAIL 回复结束后动效仍在')

const ok = lit.length > 0 && blue.length === lit.length && animated && settled
console.log('页面错误:', errors.length ? errors.slice(0, 3) : '无')
await page.screenshot({ path: 'B:/vibe_program/pi-synapse/_stream.png', fullPage: false })
await browser.close()
process.exit(ok ? 0 : 1)

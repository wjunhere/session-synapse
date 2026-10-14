// 两个导航行为回归：
//   1. 点卡片本体 → 进画布自己的详情视图（不再跳 pi-web），并定位到那一轮
//   2. 从 btw 挂件 / 侧栏 / 详情 tab 进入 → 定位到该会话**最新**一条消息
//
// 旧实现：点卡片调 openSessionInHost（整页跳走），详情默认落在顶部或记忆的
// 旧偏移 —— 长会话打开后看到的是第一句提问，像从没被回答过。
import { chromium } from 'file:///D:/Nodejs/node_global/node_modules/@playwright/mcp/node_modules/playwright-core/index.mjs'

const EXE = process.env.CHROME_PATH ?? 'C:/Users/wjun/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe'
const BASE = process.env.BASE ?? 'http://127.0.0.1:30143'
const PROBE_CWD = process.env.PROBE_CWD

const browser = await chromium.launch({ executablePath: EXE })
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
const errors = []
page.on('pageerror', e => errors.push('pageerror: ' + e.message))

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(3000)
await page.locator('.pi-synapse-switch button[data-view="map"]').click()
await page.waitForTimeout(5000)
const frame = page.frames().find(f => f.url().includes('/synapse/'))

// 选一个消息数多的真实工作区（长会话才能区分「顶部」和「最新」）
const workspaceTitle = await frame.evaluate(async () => {
  const list = await (await fetch('/synapse/api/workspaces')).json()
  let best = null
  for (const w of list.workspaces) {
    if (String(w.cwd ?? '').includes('probe')) continue
    const full = await (await fetch(`/synapse/api/workspaces/${w.id}`)).json()
    const count = full.workspace.threads.reduce((n, t) => n + (t.messages?.length ?? 0), 0)
    if (best === null || count > best.count) best = { title: w.title, count }
  }
  return best?.title ?? null
})
console.log('选用工作区:', workspaceTitle)
await frame.locator('select').selectOption({ label: workspaceTitle })
await page.waitForTimeout(5000)
await frame.evaluate(() => document.querySelector('[data-action="focus-active"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
await page.waitForTimeout(1500)

// ── 1. 点卡片本体：必须留在画布（URL 不变）、进入详情视图，并落在那一轮 ──
const urlBefore = page.url()
const clickedCard = await frame.evaluate(() => {
  // 刻意点第 2 张（不是最新一张）：落点才会区分「那一轮」和「最新」
  const cards = [...document.querySelectorAll('.thread-card[data-thread]:not(.draft-card)')]
  const card = cards[1] ?? cards[0]
  if (card === undefined) return null
  const cardId = card.dataset.cardId
  card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  return { cardId, seq: cardId?.split(':turn:').at(-1) ?? null }
})
console.log('点击卡片:', JSON.stringify(clickedCard))
await page.waitForTimeout(2500)
const urlAfter = page.url()
const detailOpen = await frame.evaluate(() => document.querySelector('.detail-view') !== null)
const stayedHere = urlBefore === urlAfter
console.log(`点卡片: stayed=${stayedHere} detail=${detailOpen} url=${urlAfter}`)

// 落点断言：被点那一轮的问题消息必须出现在视口顶部（不是落到最新、也不是开头）
const landing = await frame.evaluate(seq => {
  const scroller = document.querySelector('.detail-scroll')
  if (scroller === null) return null
  const messages = [...scroller.querySelectorAll('.message')]
  const anchor = seq === null ? null : scroller.querySelector(`[data-message-seq="${CSS.escape(seq)}"]`)
  const rect = scroller.getBoundingClientRect()
  const offset = anchor === null ? null : Math.round(anchor.getBoundingClientRect().top - rect.top)
  return {
    seq,
    anchorFound: anchor !== null,
    anchorOffsetFromViewportTop: offset,
    atBottom: scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4,
    atTop: scroller.scrollTop <= 4,
    total: messages.length,
    lastSeq: messages.at(-1)?.dataset.messageSeq ?? null,
  }
}, clickedCard?.seq ?? null)
console.log('落点:', JSON.stringify(landing))

// ── 1b. 停一会儿再量一次：投影轮询每秒 render 一遍，落点必须是「一次性」的。
// 旧实现把「无锚点 → 滚到最新」放在每次 render 里，于是 1 秒后的重渲染会把
// 用户刚点的那一轮甩到底部（实测偏移 0px → -11423px）。这条断言就是为了拦住它。
await page.waitForTimeout(4000)
const landingAfterPoll = await frame.evaluate(seq => {
  const scroller = document.querySelector('.detail-scroll')
  if (scroller === null) return null
  const anchor = seq === null ? null : scroller.querySelector(`[data-message-seq="${CSS.escape(seq)}"]`)
  const rect = scroller.getBoundingClientRect()
  return {
    anchorFound: anchor !== null,
    offset: anchor === null ? null : Math.round(anchor.getBoundingClientRect().top - rect.top),
    atBottom: scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4,
  }
}, clickedCard?.seq ?? null)
console.log('轮询后落点:', JSON.stringify(landingAfterPoll))

// ── 2. 返回画布，从「无明确锚点」入口进：应落在最新消息 ──
await frame.evaluate(() => document.querySelector('[data-action="show-canvas"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
await page.waitForTimeout(2000)
const detail = await frame.evaluate(() => {
  // 顶部「详情」tab 没有锚点 → 应回到最新
  const tab = document.querySelector('.canvas-tabs [data-action="show-thread"]')
  tab?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  return true
})
await page.waitForTimeout(2500)
const latest = await frame.evaluate(() => {
  const scroller = document.querySelector('.detail-scroll')
  if (scroller === null) return null
  const messages = [...scroller.querySelectorAll('.message')]
  const rect = scroller.getBoundingClientRect()
  const visible = messages.filter(el => {
    const r = el.getBoundingClientRect()
    return r.bottom > rect.top && r.top < rect.bottom
  })
  const lastSeq = messages.at(-1)?.dataset.messageSeq ?? null
  const visibleSeqs = visible.map(el => el.dataset.messageSeq ?? null)
  return { total: messages.length, lastSeq, visibleSeqs, atEnd: visibleSeqs.includes(lastSeq) || scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 80 }
})
console.log('无锚点进入详情:', JSON.stringify(latest))

// ── 3. btw 挂件：同样应落在最新（若当前工作区有 btw）──
await frame.evaluate(() => document.querySelector('[data-action="show-canvas"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
await page.waitForTimeout(2000)
const btw = await frame.evaluate(() => {
  const widget = document.querySelector('.btw-widget .btw-widget-open')
  if (widget === null) return null
  widget.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  return true
})
let btwOk = null
if (btw === true) {
  await page.waitForTimeout(2500)
  btwOk = await frame.evaluate(() => {
    const scroller = document.querySelector('.detail-scroll')
    if (scroller === null) return null
    const messages = [...scroller.querySelectorAll('.message')]
    const rect = scroller.getBoundingClientRect()
    const visible = messages.filter(el => {
      const r = el.getBoundingClientRect()
      return r.bottom > rect.top && r.top < rect.bottom
    })
    const lastSeq = messages.at(-1)?.dataset.messageSeq ?? null
    return { visibleSeqs: visible.map(el => el.dataset.messageSeq ?? null), atEnd: visible.map(el => el.dataset.messageSeq ?? null).includes(lastSeq) || scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 80 }
  })
  console.log('btw 挂件进入详情:', JSON.stringify(btwOk))
} else {
  console.log('btw 挂件: 当前工作区没有侧问，跳过（verify-btw 覆盖挂件链路）')
}

const clickOk = clickedCard !== null && stayedHere === true && detailOpen === true
// 真落点断言：锚点存在、在视口顶部附近（±60px）、且没有滑到底部。
// 上一版只断言了「详情打开了」，于是一个 hex seq 匹配数字正则的 bug 一路通过。
const anchorOk = landing !== null && landing.anchorFound === true
  && landing.anchorOffsetFromViewportTop !== null && Math.abs(landing.anchorOffsetFromViewportTop) <= 60
  && (landing.total <= 2 || landing.atBottom === false)
// 落点必须扛得住下一次投影轮询的重渲染
const anchorStable = landingAfterPoll !== null && landingAfterPoll.anchorFound === true
  && landingAfterPoll.offset !== null && Math.abs(landingAfterPoll.offset) <= 60
  && (landing.total <= 2 || landingAfterPoll.atBottom === false)
const latestOk = latest !== null && (latest.total <= 2 || latest.atEnd === true)
const btwPassed = btwOk === null || (btwOk.atEnd === true)
console.log()
console.log(clickOk ? 'PASS 点卡片进详情且不离开画布' : 'FAIL 点卡片行为不对')
console.log(anchorOk ? `PASS 点卡片落在该卡对应那一轮（偏移 ${landing?.anchorOffsetFromViewportTop}px，共 ${landing?.total} 条）` : `FAIL 落点不是被点的那一轮: ${JSON.stringify(landing)}`)
console.log(anchorStable ? `PASS 落点扛得住投影轮询重渲染（偏移 ${landingAfterPoll?.offset}px）` : `FAIL 轮询后落点漂了: ${JSON.stringify(landingAfterPoll)}`)
console.log(latestOk ? 'PASS 无锚点进入详情落在最新消息' : `FAIL 详情默认位置不对（共 ${latest?.total} 条，视区 ${JSON.stringify(latest?.visibleSeqs)}）`)
console.log(btwOk === null ? 'SKIP btw 挂件（当前无侧问）' : btwPassed ? 'PASS btw 挂件进入详情落在最新消息' : 'FAIL btw 挂件进入详情位置不对')
console.log('页面错误:', errors.length ? errors.slice(0, 3) : '无')
await page.screenshot({ path: 'B:/vibe_program/pi-synapse/_nav.png', fullPage: false })
await browser.close()
process.exit(clickOk && anchorOk && anchorStable && latestOk && btwPassed ? 0 : 1)

// 验证：详情视图里不会因为「有 usage 无正文」的助手轮次出现空行
import { chromium } from 'file:///D:/Nodejs/node_global/node_modules/@playwright/mcp/node_modules/playwright-core/index.mjs'
const EXE = 'C:/Users/wjun/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe'
const BASE = process.env.BASE ?? 'http://127.0.0.1:30143'

const browser = await chromium.launch({ executablePath: EXE })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2500)
await page.locator('.pi-synapse-switch button[data-view="map"]').click()
await page.waitForTimeout(4000)
const frame = page.frames().find(f => f.url().includes('/synapse/'))

// 必须显式选一个「有多轮真实消息」的工作区。画布把上次选择记在 localStorage 里，
// 而探测工作区（_probe-cwd）会被清理掉：默认状态下可能选中一个只剩空占位卡的
// 工作区，详情里 0 条消息，于是这条断言变成在断言「没打开」，与要测的东西无关。
const options = await frame.evaluate(() => [...document.querySelectorAll('select option')].map(o => o.textContent ?? ''))
const target = options.find(o => o.trim() === 'pi-synapse') ?? options.find(o => !o.includes('_probe'))
if (target === undefined) { console.log('FAIL 下拉里没有可用工作区'); await browser.close(); process.exit(1) }
await frame.locator('select').selectOption({ label: target })
await page.waitForTimeout(4000)

// 找一张内容较多的卡片，打开其会话详情
const opened = await frame.evaluate(() => {
  const cards = [...document.querySelectorAll('.thread-card[data-thread]')]
  const card = cards[Math.min(3, cards.length - 1)]
  if (card === undefined) return false
  const title = card.querySelector('.thread-title')
  if (title === null) return false
  title.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  return true
})
await page.waitForTimeout(2000)
await frame.evaluate(() => {
  const tab = document.querySelector('[data-action="show-thread"]')
  if (tab !== null) tab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
})
await page.waitForTimeout(2500)

const audit = await frame.evaluate(() => {
  const messages = [...document.querySelectorAll('.message')]
  const empty = messages.filter(m => {
    const body = m.querySelector('.message-body')
    return body !== null && String(body.textContent ?? '').trim() === ''
  })
  const labels = {}
  for (const m of messages) {
    const role = m.querySelector('.message-role')?.textContent?.trim() ?? '?'
    labels[role] = (labels[role] ?? 0) + 1
  }
  return { total: messages.length, empty: empty.length, labels }
})
console.log(JSON.stringify(audit, null, 2))
const ok = audit.total > 0 && audit.empty === 0
console.log(ok ? 'PASS 详情视图无空消息行' : 'FAIL 存在空消息行')
await browser.close()
process.exit(ok ? 0 : 1)

// M2 验证：分支折叠（折叠/展开后续对话子树）
import { chromium } from 'file:///D:/Nodejs/node_global/node_modules/@playwright/mcp/node_modules/playwright-core/index.mjs'
const EXE = 'C:/Users/wjun/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe'
const BASE = process.env.BASE ?? 'http://127.0.0.1:30143'

const browser = await chromium.launch({ executablePath: EXE })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const errors = []
page.on('pageerror', e => errors.push(e.message))
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2500)
await page.locator('.pi-synapse-switch button[data-view="map"]').click()
await page.waitForTimeout(6000)

const frame = page.frames().find(f => f.url().includes('/synapse/'))
await frame.locator('select').selectOption({ label: 'cc_program' })
await page.waitForTimeout(6000)

const count = () => frame.evaluate(() => ({
  cards: document.querySelectorAll('.thread-card').length,
  foldButtons: document.querySelectorAll('.graph-fold-button').length,
  collapsed: document.querySelectorAll('.graph-fold-button.collapsed').length,
  connectors: document.querySelectorAll('.canvas-content path, svg path[stroke]').length,
}))

const before = await count()
console.log('折叠前:', JSON.stringify(before))

// 画布用 transform 缩放，元素可能在视口外且永不可点；直接派发点击事件，
// 走 app 自己的事件委托逻辑（等价于用户点击）。必须锁定同一个 data-card，
// 因为重渲染后 .first() 会指向另一张卡。
const clickFold = cardId => frame.evaluate(id => {
  const b = [...document.querySelectorAll('.graph-fold-button')].find(x => x.dataset.card === id)
  if (!b) return false
  b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  return true
}, cardId)

const target = await frame.evaluate(() => document.querySelector('.graph-fold-button')?.dataset.card ?? null)
if (target === null) { console.log('❌ 没有可折叠的卡片（该工作区无后续分支）') }
else {
  console.log('目标卡片:', target)
  console.log('折叠:', await clickFold(target))
  await page.waitForTimeout(3000)
  const after = await count()
  console.log('折叠后:', JSON.stringify(after))
  console.log(`卡片数 ${before.cards} → ${after.cards}  折叠标记 ${before.collapsed} → ${after.collapsed}`)
  console.log(after.cards < before.cards && after.collapsed > before.collapsed ? '✅ 折叠生效' : '❌ 折叠未生效')

  console.log('展开:', await clickFold(target))
  await page.waitForTimeout(3000)
  const restored = await count()
  console.log('展开后:', JSON.stringify(restored))
  console.log(restored.cards === before.cards && restored.collapsed === before.collapsed ? '✅ 展开还原' : '❌ 展开未还原')
}

// 折叠状态是否持久化到 localStorage
const stored = await frame.evaluate(() => localStorage.getItem('pi-synapse:collapsed-cards:v1'))
console.log('localStorage 折叠记录:', stored)
console.log('错误:', errors.length ? errors.slice(0, 3) : '无')
await browser.close()

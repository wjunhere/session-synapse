// 卡片头部的布局完整性。
//
// 三件事一起量，因为它们是同一个「flex 上下文」的产物，一旦丢失（例如删 CSS
// 时误删共享选择器 `.thread-card-head` 那行），三处会同时坏，而界面看起来只是
// 「标题怪怪的」：
//   1. 标题被裁剪在卡片内（长标题出省略号，而不是撑到 1126px 冲出卡片）
//   2. 标题给右上角的上下文圆环让出位置
//   3. 标题前的分类圆点有实际宽度（不是 0）
import { launchBrowser } from './browser.mjs'

const BASE = process.env.BASE ?? 'http://127.0.0.1:30143'
const MIN_RING_GAP = 4

const browser = await launchBrowser()
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const errors = []
page.on('pageerror', e => errors.push('pageerror: ' + e.message))

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2500)
await page.locator('.pi-synapse-switch button[data-view="map"]').click()
await page.waitForTimeout(5000)
const frame = page.frames().find(f => f.url().includes('/synapse/'))
if (frame === undefined) {
  console.log('FAIL 画布 iframe 未加载')
  await browser.close()
  process.exit(1)
}
// 画布只挂载视口附近的卡片；先把当前会话定位到视野中央
await frame.evaluate(() => document.querySelector('[data-action="focus-active"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
await page.waitForTimeout(1500)

const rows = await frame.evaluate(() => [...document.querySelectorAll('.thread-card[data-thread]')].map(card => {
  const head = card.querySelector('.thread-card-head')
  const title = card.querySelector('.thread-title')
  if (head === null || title === null) return null
  const ring = card.querySelector('.context-ring')
  const dot = head.querySelector('.topic-dot')
  const cardRect = card.getBoundingClientRect()
  const titleRect = title.getBoundingClientRect()
  const ringRect = ring?.getBoundingClientRect()
  return {
    id: card.dataset.cardId,
    headDisplay: getComputedStyle(head).display,
    titleWidth: Math.round(titleRect.width),
    dotWidth: Math.round(dot?.getBoundingClientRect().width ?? 0),
    sticksOut: Math.round(titleRect.right - cardRect.right) > 0,
    ellipsized: title.scrollWidth > title.clientWidth + 1,
    ringGap: ringRect === undefined ? null : Math.round(ringRect.left - titleRect.right),
    textLength: title.textContent.length,
  }
}).filter(row => row !== null))

console.log(`量了 ${rows.length} 张卡片`)
for (const row of rows) console.log(' ', JSON.stringify(row))

const outOfCard = rows.filter(row => row.sticksOut)
const notFlex = rows.filter(row => row.headDisplay !== 'flex')
const dotMissing = rows.filter(row => row.textLength > 2 && row.dotWidth === 0)
const ringTooClose = rows.filter(row => row.ringGap !== null && row.ringGap < MIN_RING_GAP)
// 长标题必须真的出省略号，否则「没溢出」可能只是因为标题都很短
const longTitles = rows.filter(row => row.textLength > 30)
const ellipsisWorks = longTitles.length === 0 || longTitles.some(row => row.ellipsized)

const ok = rows.length > 0 && outOfCard.length === 0 && notFlex.length === 0 && dotMissing.length === 0 && ringTooClose.length === 0 && ellipsisWorks
console.log()
console.log(rows.length > 0 ? `PASS 量到 ${rows.length} 张卡片` : 'FAIL 没有卡片可量')
console.log(outOfCard.length === 0 ? 'PASS 标题全部裁剪在卡片内' : `FAIL 标题溢出卡片: ${JSON.stringify(outOfCard)}`)
console.log(notFlex.length === 0 ? 'PASS 卡片头是 flex 上下文' : `FAIL 卡片头丢了 flex: ${JSON.stringify(notFlex)}`)
console.log(dotMissing.length === 0 ? 'PASS 分类圆点有宽度' : `FAIL 分类圆点宽度为 0: ${JSON.stringify(dotMissing)}`)
console.log(ringTooClose.length === 0 ? `PASS 标题与圆环间距 ≥ ${MIN_RING_GAP}px` : `FAIL 标题压到圆环: ${JSON.stringify(ringTooClose)}`)
console.log(ellipsisWorks ? 'PASS 长标题出省略号' : 'FAIL 长标题没有省略号（可能整个宽度约束都失效了）')
console.log('页面错误:', errors.length ? errors.slice(0, 3) : '无')
await browser.close()
process.exit(ok ? 0 : 1)

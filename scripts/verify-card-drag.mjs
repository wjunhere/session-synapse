// 卡片顶部那个「抓手」的交互回归。
//
// 两件事一起验：
//   1. **抓手永远居中。** 曾经它的居中靠 `transform: translateX(-50%)`，而全局的
//      `button:active { transform: scale(.98) }` 会把 transform **整个换掉** —— 按下
//      的瞬间抓手向右跳 13px（半个身位）并缩小。现在居中用 `translate`，按下的反馈
//      由卡片抬起承担。这条必须断言「按下时也居中」，只验静止态会漏掉。
//   2. **拖动有可读的状态。** 按下 → 卡片 `is-dragging`（抬起、边框变实、连杆加深）、
//      光标 `grabbing`；松开 → 状态消失、位置记住；方向键也能移动（WCAG 2.2.6/2.2.7：
//      拖拽不能是唯一手段）。
//
// 只有卡片**完整落在视口内**才能做鼠标操作：卡片是虚拟化的，视口外的卡仍在 DOM 里但
// 坐标在屏幕外，拿它按鼠标谁也点不到（这条坑让第一版探针全程 offset=0 假绿）。
import { launchBrowser } from './browser.mjs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const BASE = process.env.BASE ?? 'http://127.0.0.1:30143'

const browser = await launchBrowser()
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
const errors = []
page.on('pageerror', e => errors.push('pageerror: ' + e.message))

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2500)
await page.locator('.pi-synapse-switch button[data-view="map"]').click()
await page.waitForTimeout(4000)
const frame = page.frames().find(f => f.url().includes('/synapse/'))

// 有卡的工作区。列表异步取，刚起服务那几秒可能是空下拉。
let options = []
for (let i = 0; i < 12; i++) {
  options = await frame.evaluate(() => [...document.querySelectorAll('select option')].map(o => o.textContent ?? ''))
  if (options.length > 0) break
  await page.waitForTimeout(3000)
}
// 优先本仓库的工作区（会话多、有分支和工具，断言更实）。仓库目录改过名，而老会话的
// cwd 仍是旧目录名，所以两个名字都认；都没有就退回任意非探测工作区。
const target = options.find(o => ['session-synapse', 'pi-synapse'].includes(o.trim())) ?? options.find(o => !o.includes('_probe'))
if (target === undefined) { console.log('FAIL 下拉里没有可用工作区'); await browser.close(); process.exit(1) }
await frame.locator('select').selectOption({ label: target })
await page.waitForTimeout(4000)

// 挑一张完整可见、离视口中心最近、且有连线的卡（连线那条断言需要它）。
await frame.evaluate(() => {
  window.pickCard = () => {
    const viewport = document.querySelector('.canvas-viewport').getBoundingClientRect()
    const centre = { x: viewport.left + viewport.width / 2, y: viewport.top + viewport.height / 2 }
    const linked = new Set()
    for (const path of document.querySelectorAll('.connectors path[data-from]')) {
      linked.add(path.getAttribute('data-from'))
      linked.add(path.getAttribute('data-to'))
    }
    const usable = []
    for (const card of document.querySelectorAll('.thread-card[data-card-id]')) {
      const c = card.getBoundingClientRect()
      const h = card.querySelector('.node-handle')?.getBoundingClientRect()
      if (h === undefined || h.width === 0) continue
      if (c.left < viewport.left + 8 || c.right > viewport.right - 8 || c.top < viewport.top + 8 || c.bottom > viewport.bottom - 8) continue
      usable.push({
        card,
        linked: linked.has(card.dataset.cardId),
        distance: Math.hypot(c.left + c.width / 2 - centre.x, c.top + c.height / 2 - centre.y),
      })
    }
    // 有连线的优先（Ordered by distance within each group）
    usable.sort((a, b) => (a.linked === b.linked ? a.distance - b.distance : a.linked ? -1 : 1))
    return usable[0]?.card ?? null
  }
})

const sample = () => frame.evaluate(() => {
  const card = window.pickCard()
  if (card === null) return null
  const handle = card.querySelector('.node-handle')
  const c = card.getBoundingClientRect()
  const h = handle.getBoundingClientRect()
  const handleStyle = getComputedStyle(handle)
  return {
    cardId: card.dataset.cardId,
    left: Math.round(c.left), top: Math.round(c.top),
    offset: +(h.left + h.width / 2 - (c.left + c.width / 2)).toFixed(1),
    handleWidth: +h.width.toFixed(1),
    transform: handleStyle.transform,
    cursor: handleStyle.cursor,
    dragging: card.classList.contains('is-dragging'),
    borderColor: getComputedStyle(card).borderColor,
    shadow: getComputedStyle(card).boxShadow,
    draggingConnectors: document.querySelectorAll('.connectors path.dragging-connector').length,
    stored: JSON.parse(localStorage.getItem('pi-synapse:card-positions:v3') ?? '[]').length,
  }
})

const pick = await frame.evaluate(() => {
  const card = window.pickCard()
  const h = card.querySelector('.node-handle').getBoundingClientRect()
  const c = card.getBoundingClientRect()
  return { cardId: card.dataset.cardId, x: h.left + h.width / 2, y: h.top + h.height / 2, cardLeft: c.left, cardTop: c.top, linked: true }
})
const iframeBox = await (await frame.frameElement()).boundingBox()
const at = (dx = 0, dy = 0) => ({ x: iframeBox.x + pick.x + dx, y: iframeBox.y + pick.y + dy })

// ── 静止态：手柄居中（所有挂载的卡，不只挑中的这张） ──────────────────────────
await page.mouse.move(iframeBox.x + 20, iframeBox.y + 20)
await page.waitForTimeout(300)
const offsets = await frame.evaluate(() => [...document.querySelectorAll('.thread-card[data-card-id]')].map(card => {
  const h = card.querySelector('.node-handle')?.getBoundingClientRect()
  if (h === undefined) return null
  const c = card.getBoundingClientRect()
  return +(h.left + h.width / 2 - (c.left + c.width / 2)).toFixed(1)
}).filter(value => value !== null))
const worst = offsets.reduce((max, value) => Math.max(max, Math.abs(value)), 0)
check('静止时每张卡的手柄都在卡片水平中心', offsets.length > 0 && worst <= 1, `共 ${offsets.length} 张，最大偏移 ${worst}px`)

const rest = await sample()
await page.mouse.move(at().x, at().y)
await page.waitForTimeout(300)
const hover = await sample()

// ── 按下：仍然居中、不缩放、卡片抬起 ────────────────────────────────────────
await page.mouse.down()
await page.waitForTimeout(300)
const pressed = await sample()
// 回归点：偏 13px 就是 translateX(-50%) 被 scale(.98) 顶掉了
check('按下时手柄仍居中（曾偏 13px）', Math.abs(pressed.offset) <= 1, `offset=${pressed.offset}px`)
check('按下时手柄不被按扁', pressed.transform === 'none' && pressed.handleWidth === rest.handleWidth, `transform=${pressed.transform} width ${rest.handleWidth}→${pressed.handleWidth}`)
check('按下时卡片进入 is-dragging', pressed.dragging === true)
check('按下时手柄光标变 grabbing', pressed.cursor === 'grabbing', `cursor=${pressed.cursor}`)
check('拖动中卡片抬起（阴影强于静止态）', pressed.shadow !== rest.shadow && pressed.borderColor !== rest.borderColor, `${rest.shadow.slice(0, 30)} → ${pressed.shadow.slice(0, 30)}`)

// ── 拖动：卡片跟随指针 ───────────────────────────────────────────────────
await page.mouse.move(at(120, 70).x, at(120, 70).y, { steps: 12 })
await page.waitForTimeout(300)
const moved = await sample()
const zoom = await frame.evaluate(() => window.__synapse.state.zoom)
check('卡片跟随指针移动', Math.abs((moved.left - pick.cardLeft) - 120 / zoom) <= 2 && Math.abs((moved.top - pick.cardTop) - 70 / zoom) <= 2,
  `dx=${moved.left - pick.cardLeft} dy=${moved.top - pick.cardTop} zoom=${zoom}`)
check('拖动中关联连线加深', moved.draggingConnectors > 0, `${moved.draggingConnectors} 条`)
check('拖动中手柄依然居中', Math.abs(moved.offset) <= 1, `offset=${moved.offset}px`)

// ── 松开：状态消失、位置记住 ─────────────────────────────────────────────
await page.mouse.up()
await page.waitForTimeout(600)
const dropped = await sample()
check('松开后 is-dragging 消失', dropped.dragging === false && dropped.cursor === 'grab')
check('松开后连线恢复', dropped.draggingConnectors === 0)
check('松开后位置被记住（localStorage）', dropped.stored > 0, `${dropped.stored} 条`)
const storedPosition = await frame.evaluate(cardId => {
  const card = document.querySelector(`.thread-card[data-card-id="${cardId}"]`)
  const entries = JSON.parse(localStorage.getItem('pi-synapse:card-positions:v3') ?? '[]')
  const entry = entries.find(item => item[0] === cardId)
  return {
    stored: entry === undefined ? null : entry[1],
    // 卡片现在的位置（画布坐标），落点应当是它
    inline: card === null ? null : { x: Number.parseFloat(card.style.left), y: Number.parseFloat(card.style.top) },
  }
}, pick.cardId)
check('记住的就是落点', storedPosition.stored !== null && storedPosition.inline !== null
  && storedPosition.stored.x === Math.round(storedPosition.inline.x) && storedPosition.stored.y === Math.round(storedPosition.inline.y),
  JSON.stringify(storedPosition))

// ── 方向键也能移动（拖拽不是唯一手段） ───────────────────────────────────────
await frame.evaluate(cardId => document.querySelector(`.node-handle[data-drag-card="${cardId}"]`).focus(), pick.cardId)
const beforeKeys = await sample()
for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight')
await page.keyboard.press('Shift+ArrowDown')
await page.waitForTimeout(400)
const afterKeys = await sample()
check('方向键移动卡片（8px/步，Shift 1px）', afterKeys.left - beforeKeys.left === 24 && afterKeys.top - beforeKeys.top === 1,
  `dx=${afterKeys.left - beforeKeys.left} dy=${afterKeys.top - beforeKeys.top}`)

const ok = results.every(item => item.ok)
console.log()
console.log(`合计 ${results.length} 项，通过 ${results.filter(item => item.ok).length}，失败 ${results.filter(item => !item.ok).length}`)
console.log('页面错误:', errors.length ? errors.slice(0, 3) : '无')
const shot = join(tmpdir(), 'synapse-verify-card-drag.png')
await page.screenshot({ path: shot, fullPage: false })
console.log('截图:', shot)
await browser.close()
process.exit(ok ? 0 : 1)

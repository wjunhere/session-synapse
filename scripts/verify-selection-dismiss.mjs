// 画布里的「选中一段文字 → 追问」状态必须能取消。
//
// 流程：在一个有正文的工作区里选中卡片正文的一段文字 → 断言「追问」按钮出现
// （前置条件）→ 依次在空白画布（左键 / 右键）、侧栏空白处点一下，每次都必须
// 既收起按钮**又**清掉浏览器的高亮选区 → 再断言两件不能被砸掉的事：右键正文
// 仍然保留选区（那是「右键复制」的路径）、点「追问」仍然把所选文字带进草稿。
//
// 为什么要测「选区本身」而不只测按钮：黄色高亮是浏览器画的，按钮只是它的影子。
// 只藏按钮而留着高亮，用户看到的仍然是「选了字、取消不掉」——这正是本套件要
// 防的退化（空白处点击时画布的拖拽手势会 preventDefault，而那个默认行为恰好
// 就是浏览器用来取消选区的）。
import { chromium } from 'file:///D:/Nodejs/node_global/node_modules/@playwright/mcp/node_modules/playwright-core/index.mjs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const EXE = process.env.CHROME_PATH ?? 'C:/Users/wjun/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe'
const BASE = process.env.BASE ?? 'http://127.0.0.1:30143'

const browser = await chromium.launch({ executablePath: EXE })
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
const errors = []
page.on('pageerror', e => errors.push('pageerror: ' + e.message))

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2500)
await page.locator('.pi-synapse-switch button[data-view="map"]').click()
await page.waitForTimeout(4000)
const frame = page.frames().find(f => f.url().includes('/synapse/'))

// 选一个有真实正文的工作区。画布把上次选择记在 localStorage 里，探测工作区又会被
// 清理掉，不显式选一个就可能落在一张空占位卡上（选不出字，测的就不是这件事）。
// 工作区列表是渲染时异步取的，刚起服务那几秒可能还是空的下拉 —— 轮询等它出现，别
// 把「还没加载」当成「没有可用工作区」。
let options = []
for (let i = 0; i < 12; i++) {
  options = await frame.evaluate(() => [...document.querySelectorAll('select option')].map(o => o.textContent ?? ''))
  if (options.length > 0) break
  await page.waitForTimeout(3000)
}
const target = options.find(o => o.trim() === 'pi-synapse') ?? options.find(o => !o.includes('_probe'))
console.log('工作区选项:', options.length, JSON.stringify(target))
if (target === undefined) { console.log('FAIL 下拉里没有可用工作区'); await browser.close(); process.exit(1) }
await frame.locator('select').selectOption({ label: target })
await page.waitForTimeout(4000)

// 选取「视口中央附近的、正文里有文字的卡片」并把前几个非空字符选中。必须挑中央
// 附近的卡：画布只挂载视口附近的卡，而 playwright 拒绝点击视口外的元素（"element
// is outside of the viewport"），靠后的步骤会因此假失败。
const selectText = () => frame.evaluate(() => {
  const viewport = document.querySelector('.canvas-viewport')?.getBoundingClientRect()
  if (viewport === undefined) return null
  const center = { x: viewport.left + viewport.width / 2, y: viewport.top + viewport.height / 2 }
  const candidates = []
  for (const card of document.querySelectorAll('.thread-card[data-thread]:not(.draft-card)')) {
    const answer = card.querySelector('.thread-answer')
    if (answer === null) continue
    const cardBox = card.getBoundingClientRect()
    const walker = document.createTreeWalker(answer, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = String(node.nodeValue ?? '')
      const start = text.search(/\S/)
      if (start === -1 || text.trim().length < 8) continue
      const end = Math.min(text.length, start + 6)
      const range = document.createRange()
      range.setStart(node, start)
      range.setEnd(node, end)
      const box = range.getBoundingClientRect()
      const answerBox = answer.getBoundingClientRect()
      const inside = box.width > 0 && box.left > viewport.left + 4 && box.right < viewport.right - 4 && box.top > viewport.top + 4 && box.bottom < viewport.bottom - 4
        // 正文自己可滚，选中的文字必须也在这块可视区内，否则下一步「在选中处右键」
        // 会点到被卷上去的位置。
        && box.top >= answerBox.top && box.bottom <= answerBox.bottom
      candidates.push({
        cardId: card.dataset.cardId ?? '',
        thread: card.dataset.thread ?? '',
        text: text.slice(start, end),
        // 相对 .thread-answer 的点，用于「正好右键在选中的字上」（右键复制那条路）。
        point: { x: box.left + 2 - answerBox.left, y: box.top + box.height / 2 - answerBox.top },
        inside,
        distance: Math.hypot(cardBox.left + cardBox.width / 2 - center.x, cardBox.top + cardBox.height / 2 - center.y),
      })
    }
  }
  const usable = candidates.filter(item => item.inside === true)
  const best = (usable.length > 0 ? usable : candidates).sort((a, b) => a.distance - b.distance)[0]
  if (best === undefined) return null
  const card = document.querySelector(`.thread-card[data-card-id="${best.cardId}"]`)
  const answer = card?.querySelector('.thread-answer')
  if (card === null || answer === undefined) return null
  const walker = document.createTreeWalker(answer, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = String(node.nodeValue ?? '')
    const start = text.search(/\S/)
    if (start === -1 || text.slice(start, start + best.text.length) !== best.text) continue
    const range = document.createRange()
    range.setStart(node, start)
    range.setEnd(node, start + best.text.length)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    break
  }
  return { cardId: best.cardId, thread: best.thread, text: best.text, point: best.point, insideVisible: best.inside }
})

const prepared = await selectText()
console.log('选中文字:', JSON.stringify(prepared))
if (prepared === null) { console.log('FAIL 找不到可选中文字的卡片'); await browser.close(); process.exit(1) }
if (prepared.insideVisible === false) console.log('提示: 选中的卡在视口边缘外，后续点击可能失败')

// 在容器里找一个「不是卡片 / 按钮 / 输入框 / 会话行」的空白点，供真实鼠标点击。
// 坐标相对于容器自身，playwright 的 position 也是相对容器，省掉 iframe 偏移换算。
const emptyPoint = async selector => frame.evaluate(container => {
  const box = document.querySelector(container)?.getBoundingClientRect()
  if (box === undefined) return null
  for (let y = box.bottom - 20; y > box.top + 10; y -= 24) {
    for (let x = box.left + 10; x < box.right - 10; x += 24) {
      const element = document.elementFromPoint(x, y)
      if (element === null) continue
      if (element.closest('.thread-card, button, select, textarea, input, .tree-item, .selection-followup') !== null) continue
      if (element.closest(container) === null) continue
      return { x: x - box.left, y: y - box.top }
    }
  }
  return null
}, selector)

const state = () => frame.evaluate(() => {
  const button = document.querySelector('.selection-followup')
  const selection = window.getSelection()
  const range = selection !== null && selection.rangeCount === 1 ? selection.getRangeAt(0) : null
  const inText = range === null ? false : range.startContainer.parentElement?.closest('.thread-answer, .message-body') !== null
  return {
    collapsed: selection === null || selection.isCollapsed === true,
    inText,
    buttonHidden: button === null ? null : button.hidden,
    buttonPainted: button === null ? false : button.getBoundingClientRect().width > 0,
    draft: document.querySelector('[data-draft] textarea')?.value ?? null,
  }
})

const mapClick = await emptyPoint('.canvas-viewport')
const sidebarClick = await emptyPoint('.sidebar')
console.log('空白点:', JSON.stringify({ mapClick, sidebarClick }))
if (mapClick === null || sidebarClick === null) { console.log('FAIL 找不到空白点击点'); await browser.close(); process.exit(1) }

const reselect = async label => {
  const again = await selectText()
  if (again === null) throw new Error('无法重新选中文字')
  prepared.cardId = again.cardId
  prepared.thread = again.thread
  prepared.text = again.text
  prepared.point = again.point
  // 选区是同步的，浮标却要等一帧（rAF），而且画布滚动时会主动收起它。
  // 这里只给「摆下一幕」等机会：等不到就重放一次选区（真实用户也只是重新拖一下）。
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(200)
    if ((await state()).buttonPainted === true) return
    if (i === 2) console.log(`  注意: ${label} 步骤重新选中后浮标未立即出现，重放一次选区`)
    if (i >= 2) await selectText()
  }
  throw new Error(`${label} 步骤重新选中后浮标一直没出现`)
}

const results = []
const check = (label, ok, detail) => { results.push({ label, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`) }

await page.waitForTimeout(400)
const lit = await state()
check('选中正文后「追问」按钮出现', lit.buttonPainted === true && lit.buttonHidden === false && lit.collapsed === false, JSON.stringify(lit))

// 左键点空白画布：拖拽手势会 preventDefault，所以选区必须由画布自己清掉。
await frame.locator('.canvas-viewport').click({ position: mapClick })
await page.waitForTimeout(400)
const afterLeft = await state()
check('左键点空白画布后选区与按钮都收起', afterLeft.collapsed === true && afterLeft.buttonPainted === false, JSON.stringify(afterLeft))

// 右键点空白画布：浏览器本来就不会取消选区，必须同样收起。
await reselect('空白画布右键')
await frame.locator('.canvas-viewport').click({ button: 'right', position: mapClick })
await page.waitForTimeout(400)
const afterRight = await state()
check('右键点空白画布后选区与按钮都收起', afterRight.collapsed === true && afterRight.buttonPainted === false, JSON.stringify(afterRight))

// 侧栏空白处。
await reselect('侧栏空白')
await frame.locator('.sidebar').click({ position: sidebarClick })
await page.waitForTimeout(400)
const afterSidebar = await state()
check('点侧栏空白处后选区与按钮都收起', afterSidebar.collapsed === true && afterSidebar.buttonPainted === false, JSON.stringify(afterSidebar))

// 右键正文：**在选中的字上**右键必须保留选区（否则「选中→右键→复制」就没法用了）。
await reselect('选中处右键')
await frame.locator(`.thread-card[data-card-id="${prepared.cardId}"] .thread-answer`).click({ button: 'right', position: prepared.point })
await page.waitForTimeout(400)
const afterTextRight = await state()
check('在选中的文字上右键保留选区（右键复制仍可用）', afterTextRight.collapsed === false && afterTextRight.inText === true && afterTextRight.buttonPainted === true, JSON.stringify(afterTextRight))

// 功能本体：点「追问」把所选文字带进草稿。
await reselect('点追问')
await frame.locator('.selection-followup').click()
await page.waitForTimeout(600)
const afterFollowup = await state()
check('点「追问」把所选文字带进草稿', afterFollowup.draft !== null && afterFollowup.draft.includes(prepared.text), JSON.stringify(afterFollowup))

const ok = results.every(item => item.ok)
console.log()
console.log(`合计 ${results.length} 项，通过 ${results.filter(item => item.ok).length}，失败 ${results.filter(item => !item.ok).length}`)
console.log('页面错误:', errors.length ? errors.slice(0, 3) : '无')
const shot = join(tmpdir(), 'synapse-verify-selection-dismiss.png')
await page.screenshot({ path: shot, fullPage: false })
console.log('截图:', shot)
await browser.close()
process.exit(ok ? 0 : 1)

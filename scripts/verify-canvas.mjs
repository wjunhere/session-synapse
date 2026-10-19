// 用真实浏览器验证画布：注入的切换条、iframe 内的画布、卡片渲染。
import { launchBrowser } from './browser.mjs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.BASE ?? 'http://127.0.0.1:30143'
const browser = await launchBrowser()
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const errors = []
page.on('pageerror', e => errors.push('pageerror: ' + e.message))
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()) })

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2500)
console.log('切换条按钮:', await page.locator('.pi-synapse-switch button').count())

await page.locator('.pi-synapse-switch button[data-view="map"]').click()
await page.waitForTimeout(7000)

const frame = page.frameLocator('.pi-synapse-overlay iframe')
console.log('画布 sidebar:', await frame.locator('.sidebar').count())
console.log('侧边栏工作区条目:', await frame.locator('.sidebar [data-workspace], .sidebar li, .sidebar button').count())

const text = (await frame.locator('body').innerText()).replaceAll(/\s+/g, ' ')
console.log('画布文本:', text.slice(0, 400))
console.log('错误:', errors.length ? errors.slice(0, 8) : '无')
// 截图写到系统临时目录：不用为写文件先建目录，也不在仓库里留残渣（这些路径以前写死在 B:/…）
await page.screenshot({ path: join(tmpdir(), 'synapse-verify-canvas.png') })
await browser.close()

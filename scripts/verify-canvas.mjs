// 用真实浏览器验证画布：注入的切换条、iframe 内的画布、卡片渲染。
// playwright-core 来自全局 @playwright/mcp。
import { chromium } from 'file:///D:/Nodejs/node_global/node_modules/@playwright/mcp/node_modules/playwright-core/index.mjs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.BASE ?? 'http://127.0.0.1:30143'
// 用已下载的 chromium 实体，避免 headless_shell 版本不匹配
const EXECUTABLE = process.env.CHROME_PATH ?? 'C:/Users/wjun/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe'
const browser = await chromium.launch({ executablePath: EXECUTABLE })
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

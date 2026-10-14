// 验证圆圈的 warn / danger 阈值配色（真实数据最高只有 61%，测不到这两个档）
import { chromium } from 'file:///D:/Nodejs/node_global/node_modules/@playwright/mcp/node_modules/playwright-core/index.mjs'
const EXE = 'C:/Users/wjun/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe'
const BASE = process.env.BASE ?? 'http://127.0.0.1:30143'

const browser = await chromium.launch({ executablePath: EXE })
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2500)
await page.locator('.pi-synapse-switch button[data-view="map"]').click()
await page.waitForTimeout(4000)
const frame = page.frames().find(f => f.url().includes('/synapse/'))

const colors = await frame.evaluate(() => {
  const make = cls => {
    const el = document.createElement('span')
    el.className = `context-ring ${cls}`
    el.style.position = 'fixed'
    el.style.left = '-9999px'
    el.innerHTML = '<svg viewBox="0 0 24 24"><circle class="context-ring-arc" cx="12" cy="12" r="9"></circle></svg>'
    document.body.append(el)
    const arc = el.querySelector('.context-ring-arc')
    return { ring: getComputedStyle(el).color, arc: getComputedStyle(arc).stroke }
  }
  const base = make('')
  const warn = make('context-ring-warn')
  const danger = make('context-ring-danger')
  document.querySelectorAll('.context-ring').forEach(el => { if (el.style.left === '-9999px') el.remove() })
  return { base, warn, danger }
})
console.log(JSON.stringify(colors, null, 2))

const ok = colors.base.arc !== colors.warn.arc && colors.warn.arc !== colors.danger.arc && colors.base.arc !== colors.danger.arc
console.log(ok ? 'PASS 三档颜色互不相同' : 'FAIL 阈值配色未生效')
console.log('  ok   =', colors.base.arc)
console.log('  warn =', colors.warn.arc)
console.log('  danger =', colors.danger.arc)
await browser.close()
process.exit(ok ? 0 : 1)

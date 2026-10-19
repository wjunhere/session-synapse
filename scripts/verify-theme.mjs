// M2 验证：pi-web 的主题（含手动覆盖）是否正确传给画布
import { launchBrowser } from './browser.mjs'
const BASE = process.env.BASE ?? 'http://127.0.0.1:30143'

const browser = await launchBrowser()

for (const pref of ['light', 'dark']) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: 'light' })
  const page = await ctx.newPage()
  // 模拟用户在 pi-web 里手动选了主题（存在 localStorage 的 pi-theme）
  await page.addInitScript(p => { try { localStorage.setItem('pi-theme', p) } catch {} }, pref)
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)

  const hostTheme = await page.evaluate(() => ({
    dataset: document.documentElement.dataset.theme ?? null,
    darkClass: document.documentElement.classList.contains('dark'),
  }))

  await page.locator('.pi-synapse-switch button[data-view="map"]').click()
  await page.waitForTimeout(5000)
  const frame = page.frames().find(f => f.url().includes('/synapse/'))
  const canvasTheme = await frame.evaluate(() => ({
    dataset: document.documentElement.dataset.theme ?? null,
    bodyBg: getComputedStyle(document.body).backgroundColor,
  }))

  console.log(`偏好=${pref}  pi-web[data-theme]=${hostTheme.dataset} dark类=${hostTheme.darkClass}  →  画布[data-theme]=${canvasTheme.dataset} 底色=${canvasTheme.bodyBg}`)
  await ctx.close()
}

await browser.close()

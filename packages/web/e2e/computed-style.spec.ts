import { expect, test } from './fixtures'
import { installPassiveFeatureMocks } from './helpers/passive-feature-mocks'

/**
 * R9-10 computed-style smoke.
 *
 * The Vitest contract suite runs on a hand-rolled cascade over happy-dom —
 * it cannot see @layer order, evaluate @media, or resolve color-mix().
 * This spec pins those three engine behaviors plus the pages-over-base
 * layer priority against a real browser. Route: /demo/library (local demo
 * data, no Product API shape beyond the session + passive mocks).
 */

const EXPECTED_LAYER_ORDER = ['tokens', 'base', 'components', 'pages', 'patterns', 'utilities', 'print']

test.beforeEach(async ({ page }) => {
  await installPassiveFeatureMocks(page)
  await page.route('**/api/v1/session', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ authenticated: false }),
  }))
})

test('declared cascade-layer order is tokens < base < components < pages < patterns < utilities < print', async ({ page }) => {
  await page.goto('/demo/library')
  const firstSeenOrder = await page.evaluate(() => {
    const seen: string[] = []
    for (const sheet of document.styleSheets) {
      for (const rule of sheet.cssRules) {
        if (rule instanceof CSSLayerStatementRule) seen.push(...rule.nameList)
        else if (rule instanceof CSSLayerBlockRule) seen.push(rule.name)
      }
    }
    return seen.filter((name, i) => seen.indexOf(name) === i)
  })
  expect(firstSeenOrder.slice(0, EXPECTED_LAYER_ORDER.length)).toEqual(EXPECTED_LAYER_ORDER)
})

test('pages layer beats base: .page-head h1 drops the 24ch measure inside .library-main', async ({ page }) => {
  await page.goto('/demo/library')
  const h1 = page.locator('.library-main .page-head h1').first()
  await expect(h1).toBeVisible()
  // @layer base (page-chrome.css) sets max-width: 24ch; the @layer pages
  // override in library.css must win the computed value.
  await expect(h1).toHaveCSS('max-width', 'none')
})

test('@media re-evaluates live: demo sidebar hides ≤719px and returns ≥720px', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 })
  await page.goto('/demo/library')
  const sidebar = page.locator('.library-sidebar')
  await expect(sidebar).toBeVisible()

  await page.setViewportSize({ width: 700, height: 800 })
  await expect(sidebar).toHaveCSS('display', 'none')

  await page.setViewportSize({ width: 900, height: 800 })
  await expect(sidebar).not.toHaveCSS('display', 'none')
})

test('color-mix() resolves through var() chains: .topnav frost is a translucent color', async ({ page }) => {
  await page.goto('/demo/library')
  const bg = await page.locator('.topnav').evaluate((el) => getComputedStyle(el).backgroundColor)
  // Chromium serializes color-mix() results as color(srgb … / α) rather than
  // rgba() — either resolved form proves the mix evaluated; a literal
  // "color-mix(" string would mean the engine handed back the token stream.
  expect(bg).not.toContain('color-mix')
  const alpha = bg.startsWith('rgba(')
    ? Number(bg.match(/,\s*([\d.]+)\)$/u)?.[1])
    : Number(bg.match(/\/\s*([\d.]+)\)$/u)?.[1])
  expect(bg).toMatch(/^(rgba\(|color\(srgb )/u)
  expect(alpha).toBeGreaterThan(0.8)
  expect(alpha).toBeLessThan(1)
})

test('var() typography resolves to absolute units: page-head h1 leading is px', async ({ page }) => {
  await page.goto('/demo/library')
  const h1 = page.locator('.library-main .page-head h1').first()
  const leading = await h1.evaluate((el) => getComputedStyle(el).lineHeight)
  expect(leading).toMatch(/^[\d.]+px$/u)
})

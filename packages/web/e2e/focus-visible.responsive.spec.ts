import type { Page, Route } from '@playwright/test'
import { expect, test } from './fixtures'

/* R15-17: keyboard focus must be visible on checkboxes, radios and chips
   (not a ~1.2:1 halo). */

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

async function openLogin(page: Page) {
  await page.route('**/api/v1/session', (route) => json(route, { authenticated: false }))
  await page.route('**/api/v1/auth/registration-state', (route) => json(route, { open: false, reason: 'closed' }))
  await page.goto('/login')
  await expect(page.locator('.auth-card')).toBeVisible()
}

async function tabTo(page: Page, id: string) {
  await page.evaluate((target) => {
    const start = document.createElement('button')
    start.id = 'fv-start'
    start.textContent = 'start'
    document.getElementById(target)!.before(start)
    start.focus()
  }, id)
  await page.keyboard.press('Tab')
  await expect(page.locator(`#${id}`)).toBeFocused()
}

test('checkboxes, radios and chips keep a solid focus outline', async ({ page }) => {
  await openLogin(page)
  await page.evaluate(() => {
    const host = document.createElement('div')
    host.innerHTML = `
      <label><input type="checkbox" id="fv-checkbox"> Check</label>
      <label><input type="radio" id="fv-radio" name="fv"> Radio</label>
      <button type="button" class="chip" id="fv-chip">Tag</button>`
    document.querySelector('main')!.prepend(host)
  })
  for (const id of ['fv-checkbox', 'fv-radio', 'fv-chip']) {
    await tabTo(page, id)
    const outline = await page.locator(`#${id}`).evaluate((element) => {
      const style = getComputedStyle(element)
      return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) }
    })
    expect(outline.style, `${id} outline`).toBe('solid')
    expect(outline.width, `${id} outline width`).toBeGreaterThanOrEqual(1)
  }
})

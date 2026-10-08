import type { Page, Route } from '@playwright/test'
import { expect, test } from './fixtures'

/* R15-16: in Windows High Contrast (forced colors), primary and danger
   buttons, toasts and "Forgot password?" must stay legible, and a checked
   radio must show its dot. */

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

type Pair = { color: string; background: string; backplate: string | null }

async function pair(page: Page, selector: string): Promise<Pair> {
  return page.locator(selector).first().evaluate((element) => {
    let node: Element | null = element
    let background = 'rgba(0, 0, 0, 0)'
    while (node && (background === 'rgba(0, 0, 0, 0)' || background === 'transparent')) {
      background = getComputedStyle(node).backgroundColor
      node = node.parentElement
    }
    // Unless an element opts out, forced colors draw a Canvas backplate
    // behind its text, so the text must also differ from Canvas.
    const probe = document.createElement('span')
    probe.style.backgroundColor = 'Canvas'
    document.body.append(probe)
    const canvas = getComputedStyle(probe).backgroundColor
    probe.remove()
    const style = getComputedStyle(element)
    const backplate = style.getPropertyValue('forced-color-adjust') === 'none' ? null : canvas
    return { color: style.color, background, backplate }
  })
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/v1/session', (route) => json(route, { authenticated: false }))
  await page.emulateMedia({ forcedColors: 'active', colorScheme: 'light' })
  await page.goto('/login')
  await expect(page.locator('.auth-card')).toBeVisible()
  // Components this page does not render on its own, built from the same
  // shared classes the app uses.
  await page.evaluate(() => {
    const host = document.createElement('div')
    host.id = 'forced-colors-fixtures'
    host.innerHTML = `
      <button type="button" class="btn btn-danger" id="fc-danger">Delete</button>
      <div class="toast" id="fc-toast" role="status">Signed out</div>
      <label><input type="radio" name="fc" id="fc-radio-on" checked> On</label>
      <label><input type="radio" name="fc" id="fc-radio-off"> Off</label>`
    document.body.append(host)
  })
})

test('primary and danger labels, toasts and the recovery link are legible', async ({ page }, testInfo) => {
  const checks: Array<[string, string]> = [
    ['primary button', '.auth-card .btn-primary'],
    ['danger button', '#fc-danger'],
    ['toast', '#fc-toast'],
    ['forgot password link', 'text=Forgot password?'],
  ]
  for (const [name, selector] of checks) {
    const { color, background, backplate } = await pair(page, selector)
    expect(color, `${name}: text colour must differ from its background`).not.toBe(background)
    if (backplate) expect(color, `${name}: text colour must differ from the Canvas backplate`).not.toBe(backplate)
  }
  await page.screenshot({ path: testInfo.outputPath('forced-colors-login.png'), fullPage: true })
})

test('a checked radio shows its dot and an unchecked one does not', async ({ page }) => {
  const dot = (id: string) => page.locator(id).evaluate((input) => {
    const before = getComputedStyle(input, '::before')
    return { transform: before.transform, background: before.backgroundColor, fill: getComputedStyle(input).backgroundColor }
  })
  const on = await dot('#fc-radio-on')
  const off = await dot('#fc-radio-off')
  expect(on.transform).not.toBe(off.transform)
  expect(on.background, 'the dot must contrast with the checked fill').not.toBe(on.fill)
})

import type { Page, Route } from '@playwright/test'
import { expect, test } from './fixtures'

/* R15-17: keyboard focus must be visible on checkboxes, radios, comment
   chips and the Explore selects (not a ~1.2:1 halo). R15-48: the Explore
   select fills its pill, so the pill is the tap target. */

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

async function openExplore(page: Page) {
  await page.route('**/api/v1/session', (route) => json(route, { authenticated: false }))
  await page.route('**/api/v1/explore/collections*', (route) => json(route, { items: [], nextCursor: null }))
  await page.route('**/api/v1/public-reports*', (route) => json(route, { items: [], nextCursor: null }))
  await page.goto('/explore')
  await expect(page.getByTestId('explore-sort')).toBeVisible()
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

test('checkboxes, radios and comment chips keep a solid focus outline', async ({ page }) => {
  await openExplore(page)
  await page.evaluate(() => {
    const host = document.createElement('div')
    host.innerHTML = `
      <label><input type="checkbox" id="fv-checkbox"> Check</label>
      <label><input type="radio" id="fv-radio" name="fv"> Radio</label>
      <button type="button" class="community-comment-action" id="fv-chip">Reply</button>`
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

test('the Explore Sort select shows an ink border on keyboard focus and fills its pill', async ({ page }, testInfo) => {
  await openExplore(page)
  const pill = page.getByTestId('explore-sort')
  const select = pill.locator('select')
  const borderBefore = await pill.evaluate((element) => getComputedStyle(element).borderTopColor)
  await select.evaluate((element) => {
    const start = document.createElement('button')
    start.id = 'fv-start'
    start.textContent = 'start'
    element.closest('[data-testid="explore-sort"]')!.before(start)
    start.focus()
  })
  await page.keyboard.press('Tab')
  await expect(select).toBeFocused()
  const ink = await page.evaluate(() => {
    const probe = document.createElement('span')
    probe.style.color = 'var(--ink)'
    document.body.append(probe)
    const inkColor = getComputedStyle(probe).color
    probe.remove()
    return inkColor
  })
  expect(ink).not.toBe(borderBefore)
  // border-color transitions, so wait for it to settle.
  await expect.poll(() => pill.evaluate((element) => getComputedStyle(element).borderTopColor)).toBe(ink)

  const [pillBox, selectBox] = await Promise.all([pill.boundingBox(), select.boundingBox()])
  expect(selectBox!.height).toBeGreaterThanOrEqual(pillBox!.height - 2)
  if (testInfo.project.name === 'mobile-chromium') expect(selectBox!.height).toBeGreaterThanOrEqual(43.5)
  await pill.screenshot({ path: testInfo.outputPath('explore-sort-pill.png') })
})

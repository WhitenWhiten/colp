import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { installPassiveFeatureMocks } from './helpers/passive-feature-mocks'

/* R15-30: the sticky hero's dither field and typewriter stop once the page
   content has scrolled over the hero, and run again when it is uncovered. */

async function fieldSignature(page: Page) {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('canvas.dither-field')
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return null
    // A checksum of the whole bitmap: any redraw of the moving field changes it.
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    let sum = 0
    for (let i = 0; i < data.length; i += 4) sum = (sum * 31 + data[i]! + data[i + 1]! * 7 + data[i + 2]! * 13) % 1_000_000_007
    return sum
  })
}

async function changesWithin(page: Page, ms: number) {
  const before = await fieldSignature(page)
  await page.waitForTimeout(ms)
  return (await fieldSignature(page)) !== before
}

// The suite runs with reduced motion (one static frame); this spec needs the loop.
test.use({ contextOptions: { reducedMotion: 'no-preference' } })

test('the landing field stops drawing while content covers the hero', async ({ page }) => {
  await installPassiveFeatureMocks(page)
  await page.route('**/api/v1/session', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ authenticated: false }),
  }))
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.goto('/')
  await expect(page.locator('canvas.dither-field')).toBeVisible()
  expect(await changesWithin(page, 400)).toBe(true)

  await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }))
  await page.waitForTimeout(200)
  expect(await changesWithin(page, 400)).toBe(false)

  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
  await page.waitForTimeout(200)
  expect(await changesWithin(page, 400)).toBe(true)
})

test('"Pause animation" stops the field and the choice survives a reload (R15-38)', async ({ page }) => {
  await installPassiveFeatureMocks(page)
  await page.route('**/api/v1/session', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ authenticated: false }),
  }))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await expect(page.locator('canvas.dither-field')).toBeVisible()
  const toggle = page.getByRole('button', { name: 'Pause animation' })
  await expect(toggle).toBeInViewport()
  await toggle.click()
  await expect(page.getByRole('button', { name: 'Play animation' })).toBeVisible()
  await page.waitForTimeout(100)
  expect(await changesWithin(page, 400)).toBe(false)

  await page.reload()
  await expect(page.getByRole('button', { name: 'Play animation' })).toBeVisible()
  await page.waitForTimeout(200)
  expect(await changesWithin(page, 400)).toBe(false)
  await page.getByRole('button', { name: 'Play animation' }).click()
  expect(await changesWithin(page, 400)).toBe(true)
})

test('the hero heading reads as one sentence and the brand has a name (R15-39)', async ({ page }) => {
  await installPassiveFeatureMocks(page)
  await page.route('**/api/v1/session', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ authenticated: false }),
  }))
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1, name: 'Your bookmarks already contain a collection.', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Know-N home' })).toBeVisible()
  await expect(page.getByRole('img', { name: 'Know-N' }).first()).toBeAttached()
})

import { expect, test } from './fixtures'
import { installProductApiMocks, MOCK_COLLECTION_ID, MOCK_ROOT_ID } from './helpers/product-api-mock'

// Motion ON: the page entrance animation is what used to trap fixed layers.
// The suite default (reduced motion) never plays it, so it hid this bug.
test.use({ contextOptions: { reducedMotion: 'no-preference' } })

// Long enough that the desk scrolls well past one viewport.
const nodes = Array.from({ length: 40 }, (_, i) => ({
  id: `n-b-${i}`,
  kind: 'bookmark' as const,
  title: `Bookmark ${i}`,
  url: `https://ex${i}.example.com`,
  etag: `"b-${i}"`,
  parentId: MOCK_ROOT_ID,
}))

test('in-page fixed layers pin to the viewport after scrolling, not to <main>', async ({ page }) => {
  const mock = await installProductApiMocks(page, { nodes })
  mock.expectBootstrap().expectDeskMount()
  await page.goto(`/library/${MOCK_COLLECTION_ID}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('library-workspace')).toBeVisible()
  await expect.poll(() => mock.pendingExpectationCount()).toBe(0)
  // Let the <main> entrance animation finish — the old `both` fill kept
  // filling transform afterwards and made <main> the containing block.
  await page.locator('main').evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)))

  const trigger = page.getByRole('button', { name: 'Actions for Bookmark 20' })
  await trigger.scrollIntoViewIfNeeded()
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(200)
  await trigger.click()
  await page.getByRole('menuitem', { name: 'Edit details' }).click()

  const drawer = page.getByTestId('node-drawer')
  await expect(drawer).toBeVisible()
  const viewport = page.viewportSize()!
  const box = (await drawer.boundingBox())!
  // The drawer is rendered inside <main> but must span the viewport.
  expect(Math.round(box.y)).toBe(0)
  expect(Math.round(box.height)).toBe(viewport.height)
})

test('modal veils are a plain scrim, never a blur over the page text', async ({ page }) => {
  const mock = await installProductApiMocks(page, { nodes })
  mock.expectBootstrap().expectDeskMount()
  await page.goto(`/library/${MOCK_COLLECTION_ID}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('library-workspace')).toBeVisible()
  await expect.poll(() => mock.pendingExpectationCount()).toBe(0)

  await page.getByRole('button', { name: 'Actions for Bookmark 3', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(page.locator('.modal-overlay')).toHaveCSS('backdrop-filter', 'none')
})

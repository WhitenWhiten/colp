import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import {
  installProductApiMocks,
  MOCK_COLLECTION_ID,
  MOCK_ROOT_ID,
  type ProductApiMock,
} from './helpers/product-api-mock'

// A tree with two root folders (one holding a child folder + bookmark) and a
// couple of loose bookmarks, so every desk surface is exercised.
const nodes = [
  { id: 'n-folder-1', kind: 'folder' as const, title: 'Folder One', etag: '"f-1"', parentId: MOCK_ROOT_ID },
  { id: 'n-folder-2', kind: 'folder' as const, title: 'Folder Two', etag: '"f-2"', parentId: MOCK_ROOT_ID },
  { id: 'n-folder-1a', kind: 'folder' as const, title: 'Nested Inside One', etag: '"f-1a"', parentId: 'n-folder-1' },
  { id: 'n-bookmark-1', kind: 'bookmark' as const, title: 'Example bookmark', url: 'https://example.com', etag: '"n-1"', parentId: MOCK_ROOT_ID },
  { id: 'n-bookmark-2', kind: 'bookmark' as const, title: 'Inside folder one', url: 'https://inside.example.com', etag: '"n-2"', parentId: 'n-folder-1' },
  { id: 'n-bookmark-3', kind: 'bookmark' as const, title: 'Another loose', url: 'https://loose.example.com', etag: '"n-3"', parentId: MOCK_ROOT_ID },
]

test.use({ contextOptions: { reducedMotion: 'no-preference' } })

async function openDesk(page: Page, mock: ProductApiMock) {
  mock.expectBootstrap().expectDeskMount()
  await page.goto('/library', { waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('library-workspace')).toBeVisible()
  await expect(page.getByText('Example bookmark').first()).toBeVisible()
  await expect.poll(() => mock.pendingExpectationCount()).toBe(0)
}

async function openRowMenuEdit(rowSelector: { locator: string; hasText: string }, page: Page) {
  await page.locator(rowSelector.locator, { hasText: rowSelector.hasText })
    .locator('button[aria-label^="Actions for"]').click()
  await page.getByRole('menuitem', { name: 'Edit details' }).click()
  await expect(page.getByTestId('node-drawer')).toBeVisible()
}

test('folder rows share the desk list shell and keep their actions inside the row', async ({ page }) => {
  const mock = await installProductApiMocks(page, { nodes })
  await openDesk(page, mock)

  const folderLayer = page.locator('.library-folder-layer')
  const bookmarkList = page.locator('.library-bookmark-list')
  const folderRow = page.locator('.library-folder-row', { hasText: 'Folder One' })
  await expect(folderRow).toBeVisible()

  // The folder layer carries the same list-shell chrome as the bookmark
  // list: one bordered frame, same left/right edges.
  const layerBox = await folderLayer.boundingBox()
  const listBox = await bookmarkList.boundingBox()
  expect(layerBox).not.toBeNull()
  expect(listBox).not.toBeNull()
  expect(Math.abs(layerBox!.x - listBox!.x)).toBeLessThan(2)
  expect(Math.abs(layerBox!.x + layerBox!.width - (listBox!.x + listBox!.width))).toBeLessThan(2)

  // The ⋯ button lives inside the row's bounds — one unified row, not a
  // control floating beside a detached card.
  await folderRow.hover()
  const rowBox = await folderRow.boundingBox()
  const actionsBox = await folderRow.locator('button[aria-label^="Actions for"]').boundingBox()
  expect(rowBox).not.toBeNull()
  expect(actionsBox).not.toBeNull()
  expect(actionsBox!.x).toBeGreaterThanOrEqual(rowBox!.x - 1)
  expect(actionsBox!.x + actionsBox!.width).toBeLessThanOrEqual(rowBox!.x + rowBox!.width + 1)
  expect(actionsBox!.y).toBeGreaterThanOrEqual(rowBox!.y - 1)
  expect(actionsBox!.y + actionsBox!.height).toBeLessThanOrEqual(rowBox!.y + rowBox!.height + 1)
})

test('opening the node drawer never shifts the page chrome', async ({ page }) => {
  const mock = await installProductApiMocks(page, { nodes })
  await openDesk(page, mock)

  // Sample fixed/sticky chrome geometry while the drawer animates in — the
  // regression scrolled the page to reveal the drawer while it still sat
  // offscreen at translateX(100%), so the whole page jumped -416px.
  await page.evaluate(() => {
    const w = window as unknown as {
      __geom: Array<Record<string, number>>
      __base: Record<string, number>
    }
    w.__geom = []
    const q = (sel: string) => document.querySelector(sel)?.getBoundingClientRect().x ?? 0
    w.__base = { main: q('main'), topnav: q('.topnav'), desk: q('.library-desk') }
    const start = performance.now()
    const sample = () => {
      w.__geom.push({
        t: performance.now() - start,
        scrollX: window.scrollX,
        main: q('main') - w.__base.main,
        topnav: q('.topnav') - w.__base.topnav,
        desk: q('.library-desk') - w.__base.desk,
      })
      if (performance.now() - start < 900) requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })

  await page.locator('.library-bookmark-row', { hasText: 'Example bookmark' })
    .locator('button[aria-label^="Actions for"]').click()
  await page.getByRole('menuitem', { name: 'Edit details' }).click()
  await expect(page.getByTestId('node-drawer')).toBeVisible()
  await page.waitForTimeout(1000)

  const geom = await page.evaluate(() => (window as unknown as { __geom: Array<Record<string, number>> }).__geom)
  expect(geom.length).toBeGreaterThan(5)
  for (const frame of geom) {
    expect(frame.scrollX, `scrollX at ${frame.t}ms`).toBe(0)
    expect(Math.abs(frame.main), `main Δx at ${frame.t}ms`).toBeLessThan(4)
    expect(Math.abs(frame.topnav), `topnav Δx at ${frame.t}ms`).toBeLessThan(4)
    expect(Math.abs(frame.desk), `desk Δx at ${frame.t}ms`).toBeLessThan(4)
  }
})

test('closing an untouched folder drawer does not prompt about unsaved changes', async ({ page }) => {
  const mock = await installProductApiMocks(page, { nodes })
  await openDesk(page, mock)

  const dialogs: string[] = []
  page.on('dialog', (dialog) => { dialogs.push(dialog.message()); void dialog.dismiss() })

  // Session 1: open the bookmark's drawer, close it untouched — leaves a
  // prior drawer session in the seed ref.
  await openRowMenuEdit({ locator: '.library-bookmark-row', hasText: 'Example bookmark' }, page)
  await page.getByTestId('node-drawer-veil').click({ position: { x: 20, y: 20 }, force: true })
  await expect(page.getByTestId('node-drawer')).toHaveCount(0)

  // Session 2: a different subject (the folder) must seed from its own
  // node, not compare the stale fields against it and report dirty.
  await openRowMenuEdit({ locator: '.library-folder-row', hasText: 'Folder One' }, page)
  await page.getByTestId('node-drawer-veil').click({ position: { x: 20, y: 20 }, force: true })
  await page.waitForTimeout(300)

  expect(dialogs).toEqual([])
  expect(await page.getByTestId('node-drawer').count()).toBe(0)
})

test('move picker excludes the moved folder and its whole subtree', async ({ page }) => {
  const mock = await installProductApiMocks(page, { nodes })
  await openDesk(page, mock)

  await page.locator('.library-folder-row', { hasText: 'Folder One' })
    .locator('button[aria-label^="Actions for"]').click()
  await page.getByRole('menuitem', { name: 'Move to…' }).click()

  const options = await page.getByTestId('destination-option').allTextContents()
  expect(options.join('\n')).not.toContain('Folder One')
  expect(options.join('\n')).not.toContain('Nested Inside One')
  expect(options.join('\n')).toContain('Folder Two')
})

test('Edit collection opens settings as a sheet over the desk', async ({ page }) => {
  const mock = await installProductApiMocks(page, { nodes })
  mock.expectBootstrap().expectDeskMount()
  await page.goto(`/library/${MOCK_COLLECTION_ID}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('library-workspace')).toBeVisible()
  await expect.poll(() => mock.pendingExpectationCount()).toBe(0)

  mock.expectEditorMount()
  await page.getByRole('button', { name: 'More collection actions' }).click()
  await page.getByRole('menuitem', { name: 'Edit collection' }).click()
  await expect(page.getByTestId('collection-settings')).toBeVisible()
  await expect(page.getByTestId('library-workspace')).toBeVisible()
  await expect(page.locator('#ce-title')).toBeVisible()
})

test('collection settings sheet still opens on phone widths', async ({ page }) => {
  const mock = await installProductApiMocks(page, { nodes })
  await page.setViewportSize({ width: 390, height: 844 })
  mock.expectBootstrap().expectDeskMount().expectEditorMount()
  await page.goto(`/library/${MOCK_COLLECTION_ID}?collection=edit`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('collection-settings')).toBeVisible()
  await expect.poll(() => mock.pendingExpectationCount()).toBe(0)
  await expect(page.locator('#ce-title')).toBeVisible()
})

test('the folder layer reorders with single clicks, no drag (R15-42)', async ({ page }) => {
  // The reorder wiggle (±0.35°) keeps Playwright's stability check from
  // settling; this case is about the click path, so run it without motion.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const mock = await installProductApiMocks(page, { nodes })
  await openDesk(page, mock)
  await page.getByTestId('library-layer-reorder').click()
  const list = page.locator('[role="list"].library-layer-reorder-list')
  const order = () => list.locator('[data-reorder-id]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-reorder-id')))
  const before = await order()
  const last = before[before.length - 1]!
  const moveToTop = list.locator(`[data-reorder-id="${last}"] button[aria-label$=" to top"]`)
  await expect(moveToTop).toBeVisible()
  await moveToTop.click()
  expect(await order()).toEqual([last, ...before.slice(0, -1)])
})

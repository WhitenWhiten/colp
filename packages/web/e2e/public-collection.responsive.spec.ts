import type { Page, Route } from '@playwright/test'
import { expect, test } from './fixtures'
import { installPassiveFeatureMocks } from './helpers/passive-feature-mocks'

/**
 * Public collection layout across the Playwright lanes (desktop 1280,
 * mobile 390, tablet 768, tablet landscape 1024 — playwright.config.ts), so
 * each assertion branches on the lane's viewport.
 *
 *   ≥900  a collection with folders splits the board track: the Contents
 *         sidebar beside the main column (toolbar → folder head → layer).
 *   <900  one column; the same tree opens as a sheet from the toolbar's
 *         Contents button.
 *   touch 44px (2.75rem) rows and triggers under (pointer: coarse).
 */

const slug = 'layout-atlas'
const TOUCH_FLOOR_PX = 44

function json(route: Route, body: unknown) {
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
}

function folder(id: string, parentId: string, title: string, position: string, description: string | null = null) {
  return { id, parentId, kind: 'folder', title, description, url: null, position }
}

function bookmark(id: string, parentId: string, title: string, position: string) {
  return {
    id, parentId, kind: 'bookmark', title, description: `${title}, annotated.`,
    url: `https://${id}.example.com/`, position,
  }
}

test.beforeEach(async ({ page }) => {
  await installPassiveFeatureMocks(page)
  await page.route('**/api/v1/session', (route) => json(route, { authenticated: false }))
  await page.route(`**/api/v1/collections/${slug}*`, (route) => json(route, {
    collection: {
      id: 'col-atlas', slug, title: 'Layout atlas', summary: 'Grids, flow and everything between them.',
      kind: 'bookmarks', rootNodeId: 'root-atlas', updatedAt: '2026-09-20T00:00:00.000Z', access: 'public',
    },
    nodes: [
      { id: 'root-atlas', parentId: null, kind: 'root', title: 'Contents', description: null, url: null, position: null },
      folder('folder-grid', 'root-atlas', 'Grid systems', 'a', 'Tracks, areas and subgrid.'),
      folder('folder-subgrid', 'folder-grid', 'Subgrid', 'a'),
      folder('folder-flow', 'root-atlas', 'Flow layout with a folder title long enough to wrap', 'b'),
      bookmark('grid-one', 'folder-grid', 'Grid by example', 'b'),
      bookmark('subgrid-one', 'folder-subgrid', 'Subgrid primer', 'a'),
      bookmark('flow-one', 'folder-flow', 'Normal flow', 'a'),
      bookmark('loose-one', 'root-atlas', 'Layout glossary', 'c'),
    ],
    page: { cursor: null, hasMore: false, sequence: 1 },
  }))
})

function viewportWidth(page: Page): number {
  const size = page.viewportSize()
  if (!size) throw new Error('responsive specs need a fixed viewport')
  return size.width
}

async function assertNoHorizontalOverflow(page: Page) {
  const report = await page.evaluate(() => {
    const viewport = document.documentElement.clientWidth
    // The phone rails row scrolls sideways on purpose; its contents may
    // run past the edge, the scroller itself may not.
    const insideScroller = (el: HTMLElement) => {
      for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
        const overflowX = getComputedStyle(node).overflowX
        if (overflowX === 'auto' || overflowX === 'scroll') return true
      }
      return false
    }
    const offenders = [...document.querySelectorAll<HTMLElement>('main, main *')]
      .filter((el) => el.offsetParent !== null || el.tagName === 'MAIN')
      .filter((el) => !insideScroller(el))
      .map((el) => ({ el, rect: el.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width > 0 && rect.right > viewport + 1)
      .slice(0, 8)
      .map(({ el, rect }) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')} right=${Math.round(rect.right)}`)
    return { viewport, documentScrollWidth: document.documentElement.scrollWidth, offenders }
  })
  expect(report.documentScrollWidth, 'document must not scroll horizontally').toBeLessThanOrEqual(report.viewport)
  expect(report.offenders, 'no rendered box may extend past the viewport').toEqual([])
}

test.describe('public collection layout follows the 900px cut', () => {
  test('Contents is a sidebar from 900px and a sheet below it', async ({ page }) => {
    await page.goto(`/c/${slug}`)
    await expect(page.getByRole('heading', { level: 1, name: 'Layout atlas' })).toBeVisible()
    const width = viewportWidth(page)
    const toolbar = page.getByTestId('collection-toolbar')
    const trigger = toolbar.getByRole('button', { name: 'Contents', exact: true })
    const sidebar = page.getByRole('navigation', { name: 'Collection folders' })

    if (width >= 900) {
      await expect(sidebar).toBeVisible()
      await expect(trigger).toBeHidden()
      // One row: the sidebar ends before the main column's toolbar starts.
      const side = await sidebar.boundingBox()
      const main = await toolbar.boundingBox()
      expect(side, 'sidebar must render').not.toBeNull()
      expect(main, 'toolbar must render').not.toBeNull()
      expect(side!.x + side!.width).toBeLessThanOrEqual(main!.x)
      await sidebar.getByRole('button', { name: 'Grid systems', exact: true }).click()
    } else {
      await expect(sidebar).toBeHidden()
      await trigger.click()
      const sheet = page.getByRole('dialog', { name: 'Contents' })
      await expect(sheet).toBeVisible()
      await sheet.getByRole('button', { name: 'Grid systems', exact: true }).click()
      await expect(sheet).toBeHidden()
    }

    await expect(page).toHaveURL(/folder=folder-grid/u)
    // The folder head names the layer the visitor now stands in.
    await expect(page.getByRole('heading', { level: 2, name: 'Grid systems', exact: true })).toBeVisible()
    await expect(page.locator('[data-collection-layer-head]')).toContainText('2 bookmarks')
  })

  for (const search of ['', '?folder=folder-subgrid', '?view=list']) {
    test(`renders without horizontal overflow${search ? ` at ${search}` : ''}`, async ({ page }) => {
      await page.goto(`/c/${slug}${search}`)
      await expect(page.getByTestId('public-collection-page')).toBeVisible()
      await assertNoHorizontalOverflow(page)
    })
  }
})

test.describe('coarse pointers get the 44px floor', () => {
  test('Contents rows and the sheet trigger meet the touch target', async ({ page }) => {
    await page.goto(`/c/${slug}?folder=folder-grid`)
    await expect(page.getByTestId('public-collection-page')).toBeVisible()
    const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches)
    test.skip(!coarse, 'fine-pointer lane')

    let tree = page.getByRole('navigation', { name: 'Collection folders' })
    if (viewportWidth(page) < 900) {
      const trigger = page.getByTestId('collection-toolbar').getByRole('button', { name: 'Contents', exact: true })
      const box = await trigger.boundingBox()
      expect(box, 'Contents trigger must render').not.toBeNull()
      expect(box!.height, 'Contents trigger height').toBeGreaterThanOrEqual(TOUCH_FLOOR_PX - 0.5)
      await trigger.click()
      tree = page.getByRole('dialog', { name: 'Contents' }).getByRole('navigation', { name: 'Collection folders' })
    }

    const controls = tree.getByRole('button')
    const count = await controls.count()
    expect(count).toBeGreaterThan(0)
    for (let i = 0; i < count; i += 1) {
      const box = await controls.nth(i).boundingBox()
      expect(box, `Contents control #${i} must render`).not.toBeNull()
      expect(box!.height, `Contents control #${i} height`).toBeGreaterThanOrEqual(TOUCH_FLOOR_PX - 0.5)
    }
  })
})

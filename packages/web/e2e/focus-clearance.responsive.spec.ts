import type { Page, Route } from '@playwright/test'
import { expect, test } from './fixtures'
import { installPassiveFeatureMocks } from './helpers/passive-feature-mocks'

/* R15-18: keyboard focus must not land under the sticky header or the fixed
   phone tab bar (2.4.11), and on a short viewport (zoomed laptop, phone in
   landscape) the chrome must not fill the screen (1.4.10). */

const slug = 'focus-clearance'

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

async function openLongCollection(page: Page) {
  await installPassiveFeatureMocks(page)
  await page.route('**/api/v1/session', (route) => json(route, { authenticated: false }))
  await page.route(`**/api/v1/collections/${slug}*`, (route) => json(route, {
    collection: {
      id: 'col-focus', slug, title: 'Focus clearance', summary: 'A long list of links.',
      kind: 'bookmarks', rootNodeId: 'root', updatedAt: '2026-09-20T00:00:00.000Z', access: 'public',
    },
    nodes: [
      { id: 'root', parentId: null, kind: 'root', title: 'Contents', description: null, url: null, position: null },
      ...Array.from({ length: 40 }, (_, i) => ({
        id: `bm-${i}`, parentId: 'root', kind: 'bookmark', title: `Reference ${i}`,
        description: 'A line of description.', url: `https://example.com/${i}`, position: `b${String(i).padStart(2, '0')}`,
      })),
    ],
    page: { cursor: null, hasMore: false, sequence: 1 },
  }))
  await page.goto(`/c/${slug}`)
  await expect(page.getByText('Reference 39')).toBeAttached()
}

/** Is the focused element's centre actually the element (not chrome over it)? */
async function focusedIsUncovered(page: Page) {
  return page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null
    if (!active || active === document.body) return { ok: true, what: 'body' }
    const box = active.getBoundingClientRect()
    const x = Math.min(Math.max(box.left + box.width / 2, 0), window.innerWidth - 1)
    const y = box.top + box.height / 2
    if (y < 0 || y > window.innerHeight) return { ok: false, what: `${active.textContent?.trim()} off-screen at ${y}` }
    const hit = document.elementFromPoint(x, y)
    const ok = hit !== null && (hit === active || active.contains(hit) || hit.contains(active))
    const describe = (node: Element | null) => node
      ? `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}.${String(node.getAttribute('class') ?? '').split(' ')[0]}[${node.getAttribute('aria-label') ?? node.textContent?.trim().slice(0, 20) ?? ''}]`
      : 'nothing'
    return { ok, what: `${describe(active)} at y=${Math.round(y)}/${window.innerHeight} covered by ${describe(hit)} in ${describe(hit?.parentElement ?? null)}` }
  })
}

test('Tab and Shift+Tab keep the focused control clear of sticky chrome', async ({ page }) => {
  await openLongCollection(page)
  const failures: string[] = []
  await page.getByText('Reference 0').first().focus()
  for (let i = 0; i < 30; i += 1) {
    await page.keyboard.press('Tab')
    const result = await focusedIsUncovered(page)
    if (!result.ok) failures.push(`Tab ${i}: ${result.what}`)
  }
  for (let i = 0; i < 30; i += 1) {
    await page.keyboard.press('Shift+Tab')
    const result = await focusedIsUncovered(page)
    if (!result.ok) failures.push(`Shift+Tab ${i}: ${result.what}`)
  }
  expect(failures).toEqual([])
})

test('a short viewport unsticks the header and the tab bar', async ({ page }) => {
  await page.setViewportSize({ width: 683, height: 305 })
  await openLongCollection(page)
  expect(await page.locator('.topnav').evaluate((element) => getComputedStyle(element).position)).toBe('relative')
  const bottomNav = page.locator('.bottom-nav')
  if (await bottomNav.count()) {
    expect(await bottomNav.evaluate((element) => getComputedStyle(element).position)).toBe('static')
  }
  await page.mouse.wheel(0, 600)
  await expect.poll(() => page.evaluate(() => {
    const hit = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)
    return hit?.closest('.topnav, .bottom-nav') === null
  })).toBe(true)
})

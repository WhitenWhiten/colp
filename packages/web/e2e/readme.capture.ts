import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { installReadmeApi, NOW, PLAN_ID, RESEARCH_ID, SHARE_SLUG } from './helpers/readme-fixtures'

/* README screenshots of the web app: five settled 1280×800 viewports of the
   real pages against one fictional account and a fixed clock. Not part of
   the e2e suite (playwright.captures.config.ts is the only config that
   matches *.capture.ts). From packages/web:

     README_CAPTURE_OUT=/abs/out/dir node ../extension/scripts/with-xvfb.mjs \
       npx playwright test -c playwright.captures.config.ts
*/

const OUT = process.env.README_CAPTURE_OUT
if (!OUT) throw new Error('Set README_CAPTURE_OUT to the folder the README screenshots are written to.')
const outDir = path.resolve(OUT)

let unexpected: string[] = []

test.beforeEach(async ({ page, context }, testInfo) => {
  await page.clock.setFixedTime(new Date(NOW))
  unexpected = await installReadmeApi(context, { signedIn: !testInfo.title.startsWith('web-shared') })
})

test.afterEach(() => {
  expect(unexpected, 'the capture issued requests the README fixtures do not answer').toEqual([])
})

/** No request in flight, nothing loading, no toast, fonts in, nothing focused. */
async function settle(page: Page) {
  await page.waitForLoadState('networkidle')
  await expect(page.locator('.loading-state, .skeleton-block, [aria-busy="true"]')).toHaveCount(0)
  await expect(page.locator('.toast')).toHaveCount(0)
  // The toast live regions stay mounted (empty) for the page's lifetime.
  await expect(page.getByRole('alert').filter({ hasText: /\S/u })).toHaveCount(0)
  await page.evaluate(async () => {
    await document.fonts.ready
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })
  await page.waitForLoadState('networkidle')
}

/** A shot of the settled viewport, refused if the page asked for anything the fixtures do not answer. */
async function capture(page: Page, name: string) {
  await settle(page)
  expect(unexpected).toEqual([])
  await page.screenshot({ path: path.join(outDir, name), animations: 'disabled', caret: 'hide' })
}

test('web-library: the Research folder of the library', async ({ page }) => {
  await page.goto(`/library?folder=${RESEARCH_ID}`)
  const main = page.getByTestId('library-main')
  await expect(main.getByRole('heading', { name: 'Research' })).toBeVisible()
  await expect(main.getByText('Attention Is All You Need', { exact: true })).toBeVisible()
  await expect(main.getByTestId('bookmark-note')).toContainText('critique-and-revise')
  await expect(page.getByTestId('library-nav').getByRole('link', { name: /Programming/ })).toBeVisible()
  await capture(page, 'web-library.en.png')
})

test('web-approval: an agent plan waiting for the owner', async ({ page }) => {
  await page.goto(`/approvals/${PLAN_ID}`)
  const card = page.locator(`[data-plan-id="${PLAN_ID}"]`)
  await expect(card.getByText('Pending approval')).toBeVisible()
  await expect(card.getByText('Toolformer: Language Models Can Teach Themselves to Use Tools')).toBeVisible()
  const approve = card.getByRole('button', { name: 'Approve', exact: true })
  await expect(approve).toBeVisible()
  await expect(card.getByRole('button', { name: 'Deny', exact: true })).toBeVisible()
  // The whole card, decision row included, must fit the 800px viewport.
  await expect(approve).toBeInViewport({ ratio: 1 })
  await capture(page, 'web-approval.en.png')
})

test('web-automations: account rules and their recent runs', async ({ page }) => {
  await page.goto('/automations')
  const sentences = page.getByTestId('automation-sentence')
  await expect(sentences).toHaveCount(4)
  await expect(sentences.first()).toHaveText('When a bookmark saved to your library is from arxiv.org, move it to Research.')
  await expect(page.getByTestId('automations-activity').locator('[data-run-id]')).toHaveCount(6)
  await capture(page, 'web-automations.en.png')
})

test('web-activity: the agent activity inbox', async ({ page }) => {
  const read = page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith('/api/v1/me/activity/read'))
  await page.goto('/activity')
  await expect(page.locator('[data-activity-id]')).toHaveCount(5)
  await read
  await expect(page.getByRole('link', { name: 'Claude (research assistant) added 3 bookmarks to Research' })).toBeVisible()
  await capture(page, 'web-activity.en.png')
})

test('web-shared: the shared Research folder as a visitor', async ({ page }) => {
  await page.goto(`/c/${SHARE_SLUG}`)
  await expect(page.getByRole('heading', { name: 'Research', level: 1 })).toBeVisible()
  await expect(page.getByText('Shared folder', { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Building effective agents', exact: true })).toBeVisible()
  await capture(page, 'web-shared.en.png')
})

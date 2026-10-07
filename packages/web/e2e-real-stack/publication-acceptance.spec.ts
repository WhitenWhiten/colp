import { expect, test, type Page } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { signInShared } from './auth-bootstrap'
import { createDeskBookmark, expectCollectionDeskAfterCreate, openCollectionSettings, selectCollectionVisibility } from './collection-bootstrap'

const controlUrl = process.env.KNOWN_REAL_STACK_CONTROL_URL
const controlToken = process.env.KNOWN_REAL_STACK_CONTROL_TOKEN

if (!controlUrl || !controlToken) {
  throw new Error('Phase 2 browser evidence requires the fail-closed real-stack harness')
}

async function control(path: string, body: unknown): Promise<void> {
  const response = await fetch(`${controlUrl}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${controlToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(`real-stack control ${path} failed (${response.status}): ${await response.text()}`)
  }
}

async function createBookmark(page: Page, title: string, url: string): Promise<void> {
  await createDeskBookmark(page, title, url)
}

test('publishes through the real Product API and remains anonymously readable after restart', async ({ page, browser }) => {
  const slug = 'phase2-acceptance-publication'
  const title = 'Phase 2 acceptance publication'
  const bookmarkTitle = 'Acceptance bookmark'
  const bookmarkUrl = 'https://example.test/phase2-acceptance'

  await signInShared(page)

  await page.getByLabel('Title').fill(title)
  await page.getByLabel('Summary (optional)').fill('Machine-reproducible publication browser evidence')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  const collectionId = await expectCollectionDeskAfterCreate(page)
  await createBookmark(page, bookmarkTitle, bookmarkUrl)
  await openCollectionSettings(page, collectionId)
  await selectCollectionVisibility(page, 'Public')
  await page.getByLabel('Public address').fill(slug)
  await page.getByRole('button', { name: 'Save collection', exact: true }).click()
  await expect(page.getByRole('link', { name: new RegExp(`/c/${slug}$`, 'u') })).toBeVisible()
  await expect(page.getByTestId('publication-canonical').getByRole('link')).toHaveAttribute('href', `/c/${slug}`)
  await expect(page.getByLabel('Public address')).toHaveValue(slug)
  await expect(page.getByLabel('Public address')).toBeDisabled()

  await page.goto(`/c/${slug}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('public-collection-page')).toBeVisible()
  await expect(page.getByText('Member view', { exact: true })).toBeVisible()
  const memberProjection = await page.evaluate(async (publicationSlug) => {
    const response = await fetch(`/api/v1/collections/${publicationSlug}`)
    await response.arrayBuffer()
    return {
      status: response.status,
      cacheControl: response.headers.get('cache-control'),
      vary: response.headers.get('vary'),
    }
  }, slug)
  expect(memberProjection.status).toBe(200)
  expect(memberProjection.cacheControl).toBe('private, no-store')
  expect(memberProjection.vary?.toLowerCase().split(',').map((field) => field.trim())).toContain('cookie')

  await control('/api-and-worker/restart-and-await', { aggregateId: collectionId })

  await page.getByRole('button', { name: /Phase 1 Real Stack/u }).first().click()
  await page.getByRole('button', { name: 'Log out', exact: true }).click()
  await expect(page.getByRole('link', { name: 'Log in', exact: true }).first()).toBeVisible()

  const anonymousContext = await browser.newContext()
  const projection = await (async () => {
    try {
      const anonymous = await anonymousContext.newPage()
      await anonymous.goto(new URL(`/c/${slug}`, page.url()).href, { waitUntil: 'domcontentloaded' })
      const result = await anonymous.evaluate(async (publicationSlug) => {
        const response = await fetch(`/api/v1/collections/${publicationSlug}`)
        return {
          status: response.status,
          cacheControl: response.headers.get('cache-control'),
          vary: response.headers.get('vary'),
          body: await response.json() as {
            collection?: { title?: string }
            nodes?: Array<{ title?: string; url?: string }>
          },
        }
      }, slug)
      expect(result.status).toBe(200)
      expect(result.cacheControl).toBe('public, max-age=60, stale-while-revalidate=300')
      expect(result.vary?.toLowerCase().split(',').map((field) => field.trim())).toContain('cookie')
      expect(result.body.collection?.title).toBe(title)
      expect(result.body.nodes).toContainEqual(expect.objectContaining({
        title: bookmarkTitle,
        url: bookmarkUrl,
      }))
      await expect(anonymous.getByTestId('public-collection-page')).toBeVisible()
      await expect(anonymous.getByRole('heading', { name: title, level: 1 })).toBeVisible()
      await expect(anonymous.locator('a[data-collection-resource-link="true"]')).toHaveAttribute('href', bookmarkUrl)
      await expect(anonymous.getByText('Member view', { exact: true })).toHaveCount(0)
      return result
    } finally {
      await anonymousContext.close()
    }
  })()

  const evidencePath = process.env.KNOWN_PHASE2_BROWSER_EVIDENCE_OUTPUT
  const evidenceChallenge = process.env.KNOWN_PHASE2_BROWSER_EVIDENCE_CHALLENGE
  if (evidencePath || evidenceChallenge) {
    if (!evidencePath || !evidenceChallenge) {
      throw new Error('Phase 2 browser evidence requires both output and challenge')
    }
    await writeFile(evidencePath, JSON.stringify({
      challenge: evidenceChallenge,
      engine: 'playwright-chromium',
      collectionId,
      publicUrl: new URL(`/c/${slug}`, page.url()).href,
      productWritePublished: true,
      anonymousStatus: projection.status,
      memberStatus: memberProjection.status,
    }), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  }
})

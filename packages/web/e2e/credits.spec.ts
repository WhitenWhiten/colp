import type { Page, Route } from '@playwright/test'
import { expect, test } from './fixtures'
import { installPassiveFeatureMocks } from './helpers/passive-feature-mocks'

const json = (route: Route, body: unknown, status = 200) => route.fulfill({
  status,
  contentType: 'application/json',
  headers: { 'Cache-Control': 'private, no-store', 'X-Request-Id': 'credits-e2e' },
  body: JSON.stringify(body),
})

const balance = { available: 99, reserved: 0, nextExpiryAt: null, expiringPoints: 0 }
const spend = {
  entryId: '10000000-0000-4000-8000-000000000003', sequence: '3', kind: 'spend',
  postedAt: '2026-09-19T00:59:59.000Z', effectiveAt: '2026-09-19T00:59:59.000Z',
  pointsDelta: -1, availableDelta: 0, reservedDelta: -1, expiredPoints: 0,
  balanceAfter: { available: 99, reserved: 0 }, operationType: 'bookmark.classify', source: 'extension',
  reasonCode: 'classification_completed', grantId: null,
  chargeId: '20000000-0000-4000-8000-000000000001', relatedEntryId: null, expiresAt: null, task: null,
}
const grant = { ...spend, entryId: '10000000-0000-4000-8000-000000000004', sequence: '4', kind: 'grant',
  pointsDelta: 10, availableDelta: 10, reasonCode: 'manual_grant', operationType: 'credit.grant', source: 'operator', chargeId: null,
  balanceAfter: { available: 109, reserved: 0 } }

function ledgerPage(items: readonly unknown[], nextCursor: string | null) {
  return { contractVersion: '1.0.0', accountId: 'owner', snapshot: {
    asOf: '2026-09-19T01:00:00.000Z', ledgerSequence: '4', balance,
  }, items, nextCursor }
}

async function setup(pageInstance: Page, late: { route?: Route }) {
  await installPassiveFeatureMocks(pageInstance)
  await pageInstance.addInitScript(() => { window.__KNOWN_FLAGS__ = { classification: true } })
  await pageInstance.route('**/api/v1/session', route => json(route, {
    authenticated: true, csrfToken: 'credits-csrf', idleExpiresAt: '2099-01-01T00:00:00Z', absoluteExpiresAt: '2099-01-01T00:00:00Z',
  }))
  await pageInstance.route('**/api/v1/me', route => json(route, {
    account: { id: 'owner', email: null }, profile: { id: 'owner', handle: 'owner', displayName: 'Owner', avatarUrl: null },
  }))
  await pageInstance.route('**/api/v1/me/credits/ledger?*', async route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('cursor') === 'cursor-1') {
      late.route = route
      await new Promise<void>(() => {})
      return
    }
    if (url.searchParams.get('kind') === 'grant') return json(route, ledgerPage([grant], null))
    return json(route, ledgerPage([spend], 'cursor-1'))
  })
}

test('renders the private ledger and discards a late cursor response after the filter authority changes', async ({ page }, testInfo) => {
  const late: { route?: Route } = {}
  await setup(page, late)
  await page.goto('/credits')
  await expect(page.getByTestId('credits-page')).toContainText('Spent')
  await page.screenshot({ path: testInfo.outputPath('credits-ledger.png'), fullPage: true })

  await page.getByRole('button', { name: 'Load more' }).click()
  await expect.poll(() => late.route !== undefined).toBe(true)
  await page.getByRole('combobox', { name: 'Ledger type' }).selectOption({ label: 'Granted' })
  await expect(page.getByTestId('credits-page')).toContainText('Manual grant')
  await expect(page.getByTestId('credits-page')).not.toContainText('Classification completed')

  await late.route!.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(ledgerPage([spend], null)),
  })
  await expect(page.getByTestId('credits-page')).not.toContainText('classification completed')
})

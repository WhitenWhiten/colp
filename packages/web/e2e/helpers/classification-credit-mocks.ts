import type { Page } from '@playwright/test'

/** Hosted classification scenarios exercise the current, explicit credit consent flow. */
export async function installClassificationCreditMocks(page: Page) {
  await page.route('**/api/v1/collections/*/classification-settings', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ executionMode: 'server_managed', autoTagMode: 'suggest', maxAutoTags: 3 }),
  }))
  await page.route('**/api/v1/me/credits?*', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ contractVersion: '1.0.0', accountId: 'owner', asOf: '2026-09-19T01:00:00.000Z', ledgerSequence: '1',
      managedClassificationBillingMode: 'managed',
      balance: { available: 100, reserved: 0, nextExpiryAt: null, expiringPoints: 0 },
      prices: [{ operationType: 'bookmark.classify', priceVersion: 'bookmark-classify.v1', unit: 'bookmark', unitPoints: 1 }] }),
  }))
}

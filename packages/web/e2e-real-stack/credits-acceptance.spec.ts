import { expect, test } from '@playwright/test'
import type { CreditLedgerPage } from '../src/api'

const controlUrl = process.env.KNOWN_REAL_STACK_CONTROL_URL
const controlToken = process.env.KNOWN_REAL_STACK_CONTROL_TOKEN
const webOrigin = process.env.KNOWN_REAL_STACK_WEB_BASE_URL
if (!controlUrl || !controlToken || !webOrigin) throw new Error('CR05 requires the real PostgreSQL/API browser stack')

async function control<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(controlUrl + path, { method: 'POST', headers: {
    authorization: `Bearer ${controlToken}`, 'content-type': 'application/json',
  }, body: body === undefined ? undefined : JSON.stringify(body) })
  if (!response.ok) throw new Error(`Credit fixture failed: ${response.status}`)
  return response.json() as Promise<T>
}

test('CR05 real credit ledger preserves pagination, opens detail, filters and fences a late account response', async ({ page, context }, testInfo) => {
  const identities = await control<{ actor: { cookieValue: string; profileId: string }; target: { cookieValue: string; profileId: string } }>('/follow/fixture')
  const cookieOrigin = new URL(webOrigin!); cookieOrigin.protocol = 'https:'
  const useAccount = (value: string) => context.addCookies([{
    name: '__Host-known_session', value, url: cookieOrigin.origin, httpOnly: true, secure: true, sameSite: 'Lax',
  }])
  await useAccount(identities.actor.cookieValue)
  const seeded = await control<{ entries: { id: string; kind: string; sequence: string; charge_id: string | null }[] }>('/credits/fixture', { accountId: identities.actor.profileId, action: 'seed' })
  const pages: CreditLedgerPage[] = []
  page.on('response', response => {
    if (new URL(response.url()).pathname === '/api/v1/me/credits/ledger' && response.status() === 200) {
      void response.json().then((body: CreditLedgerPage) => pages.push(body))
    }
  })
  await page.goto('/credits')
  const rows = page.locator('.credits-table .data-table-body [role="row"]')
  const available = page.locator('.credits-balance-item').filter({ hasText: 'Available' }).locator('strong')
  await expect(rows).toHaveCount(20)
  await expect.poll(() => pages.length).toBeGreaterThan(0)
  expect(pages[0]!.accountId).toBe(identities.actor.profileId)
  await expect(available).toHaveText('31')
  await control('/credits/fixture', { accountId: identities.actor.profileId, action: 'append' })
  await page.getByRole('button', { name: 'Load more' }).click()
  await expect(rows).toHaveCount(seeded.entries.length)
  await expect(available).toHaveText('31')
  expect(pages.at(-1)!.snapshot).toEqual(pages[0]!.snapshot)
  const beforeDetail = pages.length
  await rows.filter({ hasText: 'Spent' }).locator('button').click()
  await expect(page.getByLabel('Ledger entry details')).toContainText('Classification completed')
  await expect(rows).toHaveCount(seeded.entries.length)
  expect(pages.length).toBe(beforeDetail)
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(available).toHaveText('34')
  for (const [label, expected] of [['Spent', 'Classification completed'], ['Refunded', 'Manual refund'], ['Expired', 'Credits expired']] as const) {
    await page.getByRole('combobox', { name: 'Ledger type' }).selectOption({ label })
    await expect(rows).toHaveCount(1)
    await expect(rows).toContainText(expected)
  }
  await page.locator('.credits-more-filters > summary').click()
  await page.getByRole('button', { name: 'Clear filters' }).click()
  const spend = seeded.entries.find(entry => entry.kind === 'spend')!
  await page.getByLabel('Charge ID', { exact: true }).fill(spend.charge_id!)
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click()
  await expect(rows).toHaveCount(3)
  await page.goto(`/credits?entryId=${spend.id}`)
  await expect(page.getByLabel('Ledger entry details')).toContainText(spend.id)
  await expect(page.getByLabel('Ledger entry details').getByRole('link', { name: 'Open collection' })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('credits-real-postgres.png'), fullPage: true })
  await page.getByRole('button', { name: 'Close', exact: true }).click()

  let release!: () => void, seen!: () => void, delivered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const captured = new Promise<void>(resolve => { seen = resolve })
  const finished = new Promise<void>(resolve => { delivered = resolve })
  let hold = true
  await page.route('**/api/v1/me/credits/ledger?*', async route => {
    if (!hold) return route.continue()
    hold = false
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    expect((await response.json() as CreditLedgerPage).accountId).toBe(identities.actor.profileId)
    seen()
    await gate
    try { await route.fulfill({ response }) } finally { delivered() }
  })
  try {
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await captured
    await useAccount(identities.target.cookieValue)
    // Invoke the real session bootstrap after swapping real signed cookies.
    await page.evaluate(async () => {
      const modulePath = '/src/api/productClient.ts'
      const { productClient } = await import(/* @vite-ignore */ modulePath)
      await productClient.bootstrapSession({ maxRetries: 0 })
    })
    await expect(page.getByText('No credit activity yet', { exact: true })).toBeVisible()
    await expect(available).toHaveText('0')
    release(); await finished
    await expect(rows).toHaveCount(0)
    await expect(available).toHaveText('0')
    await expect(page.getByLabel('Ledger entry details')).toHaveCount(0)
  } finally { release(); await page.unroute('**/api/v1/me/credits/ledger?*') }
})

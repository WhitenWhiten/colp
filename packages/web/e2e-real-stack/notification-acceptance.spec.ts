import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'

const controlUrl = process.env.KNOWN_REAL_STACK_CONTROL_URL
const controlToken = process.env.KNOWN_REAL_STACK_CONTROL_TOKEN
const webBaseUrl = process.env.KNOWN_REAL_STACK_WEB_BASE_URL
if (!controlUrl || !controlToken || !webBaseUrl) throw new Error('P5-22 real-stack infrastructure is required')
type Principal = { cookieValue: string; profileId: string; handle: string }
type Fixture = { actor: Principal; target: Principal; collectionId: string }
type ChainEvidence = { eventFactDigest: string; recipientFactDigest: string; sourceFactDigest: string; outboxFactDigest: string; workerFactDigest: string; authorityFactDigest: string; chainDigest: string }
type NotificationItem = { notificationId: string; notificationType: string; actorProfileId: string | null; subject: { type: string; id: string }; state: string; stateRevision: string; readAt: string | null; occurredAt: string }
const digest = (...facts: unknown[]) => createHash('sha256').update(JSON.stringify(facts)).digest('hex')
async function control<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${controlUrl}${path}`, { method: 'POST', headers: { authorization: `Bearer ${controlToken}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
  if (!response.ok) throw new Error(`${path} failed ${response.status}: ${await response.text()}`)
  return response.status === 204 ? undefined as T : response.json() as Promise<T>
}
async function principalContext(browser: Browser, principal: Principal): Promise<BrowserContext> {
  const context = await browser.newContext(); const origin = new URL(webBaseUrl!); origin.protocol = 'https:'
  await context.addCookies([{ name: '__Host-known_session', value: principal.cookieValue, url: origin.origin, httpOnly: true, secure: true, sameSite: 'Lax' }])
  return context
}
async function enableNotifications(page: Page, notifications: boolean) { await page.addInitScript((value) => { (window as Window & { __KNOWN_FLAGS__?: { notifications?: boolean; follow?: boolean } }).__KNOWN_FLAGS__ = { notifications: value, follow: true } }, notifications) }
/** The activity filter is a "Show:" SelectMenu pill; its Unread option carries the server count. */
function unreadFilter(page: Page, count: number) { return page.getByTestId('notification-filter').locator('option', { hasText: new RegExp(`^${count > 0 ? `Unread · ${count}` : 'Unread'}$`) }) }
async function saveCollectionTitle(page: Page, collectionId: string, title: string) {
  const input = page.locator('#ce-title'); await input.fill(title)
  const response = page.waitForResponse((value) => value.request().method() === 'PATCH' && new URL(value.url()).pathname === `/api/v1/collections/${collectionId}`)
  await input.press('Enter'); expect((await response).status()).toBe(200)
}

test('P5-22 real Follow event crosses Outbox and registered Worker into authoritative Notification UI', async ({ browser }) => {
  const fixture = await control<Fixture>('/notification/fixture'); const recipient = await principalContext(browser, fixture.target); const actor = await principalContext(browser, fixture.actor)
  try {
    const inbox = await recipient.newPage(); const source = await actor.newPage(); await enableNotifications(inbox, true)
    await inbox.goto('/notifications'); const before = await control<{ unreadCount: number }>('/notification/authority', { recipientProfileId: fixture.target.profileId })
    await source.goto(`/u/${fixture.target.handle}`); await source.getByRole('button', { name: 'Follow', exact: true }).click()
    const projected = await control<{ unreadCount: number; completedWorkerEvents: number; chainEvidence: ChainEvidence }>('/notification/await', { recipientProfileId: fixture.target.profileId, minimumUnread: before.unreadCount + 1 })
    expect(projected.completedWorkerEvents).toBeGreaterThan(0)
    for (const value of Object.values(projected.chainEvidence)) expect(value).toMatch(/^[0-9a-f]{64}$/)
    const inboxResponse = inbox.waitForResponse((response) => response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/api/v1/notifications')
    await inbox.bringToFront(); await inbox.getByRole('button', { name: 'Refresh', exact: true }).click()
    const response = await inboxResponse; expect(response.status()).toBe(200)
    expect(response.headers()['cache-control']).toBe('private, no-store')
    const responseBody = await response.json() as { items: NotificationItem[] }
    const observed = responseBody.items.find((item) => item.notificationType === 'follow_activity'
      && item.actorProfileId === fixture.actor.profileId)
    expect(observed).toBeDefined()
    const authorityFact = {
      notificationId: observed!.notificationId,
      notificationType: observed!.notificationType,
      actorProfileId: observed!.actorProfileId,
      subject: observed!.subject,
      state: observed!.state,
      stateRevision: observed!.stateRevision,
      readAt: observed!.readAt,
      occurredAt: observed!.occurredAt,
    }
    const applicationFactDigest = digest(authorityFact)
    expect(applicationFactDigest).toBe(projected.chainEvidence.authorityFactDigest)
    const httpFactDigest = digest(response.status(), response.headers()['cache-control'], applicationFactDigest)
    const clientFactDigest = digest(authorityFact)
    await expect(unreadFilter(inbox, before.unreadCount + 1)).toHaveCount(1)
    const item = inbox.locator('[data-notification-item]').first(); await expect(item).toBeVisible()
    await expect(item).toContainText('Follows')
    await expect(item).toContainText('followed your work')
    await expect(item).not.toContainText(fixture.actor.profileId)
    const browserFactDigest = digest(observed!.notificationId, 'Follows', fixture.actor.profileId)
    const chain = { ...projected.chainEvidence, applicationFactDigest, httpFactDigest,
      clientFactDigest, browserFactDigest }
    chain.chainDigest = digest(chain.eventFactDigest, chain.recipientFactDigest,
      chain.sourceFactDigest, chain.outboxFactDigest, chain.workerFactDigest,
      chain.authorityFactDigest, chain.applicationFactDigest, chain.httpFactDigest,
      chain.clientFactDigest, chain.browserFactDigest)
    console.log(`[P5-23-NOTIFICATION-CHAIN] ${JSON.stringify(chain)}`)
    const mark = item.getByRole('button', { name: /^Mark read/ }); await mark.focus(); await expect(mark).toBeFocused(); await mark.press('Enter')
    await expect(unreadFilter(inbox, before.unreadCount)).toHaveCount(1)
    expect((await control<{ unreadCount: number }>('/notification/authority', { recipientProfileId: fixture.target.profileId })).unreadCount).toBe(before.unreadCount)
    await inbox.goto('/library?settings=notifications')
    const preference = inbox.getByRole('switch', { name: 'In-app notifications' }); await preference.click(); await expect(preference).toHaveAttribute('aria-checked', 'false')
    const disabledPreference = await control<{ preferenceEnabled: boolean; preferenceRevision: string }>('/notification/authority', { recipientProfileId: fixture.target.profileId })
    expect(disabledPreference.preferenceEnabled).toBe(false)
    await inbox.getByTestId('in-app-preference').getByRole('button', { name: 'Use default' }).click(); await expect(preference).toHaveAttribute('aria-checked', 'true')
    const defaultPreference = await control<{ preferenceEnabled: boolean; preferenceRevision: string }>('/notification/authority', { recipientProfileId: fixture.target.profileId })
    expect(defaultPreference.preferenceEnabled).toBe(true)
    expect(BigInt(defaultPreference.preferenceRevision)).toBeGreaterThan(BigInt(disabledPreference.preferenceRevision))
  } finally { await recipient.close(); await actor.close() }
})

test('P5-22 pagination, multi-tab refresh, rollout, narrow viewport, and outage recovery fail closed', async ({ browser }) => {
  const fixture = await control<Fixture>('/notification/fixture'); const context = await principalContext(browser, fixture.actor); const writer = await principalContext(browser, fixture.target)
  try {
    const page = await context.newPage(); await enableNotifications(page, false); const calls: string[] = []; page.on('request', (request) => { if (new URL(request.url()).pathname.startsWith('/api/v1/notification')) calls.push(request.url()) })
    await page.goto('/notifications'); await expect(page.getByTestId('notifications-flag-off')).toBeVisible(); expect(calls).toEqual([])
    await enableNotifications(page, true); await page.goto(`/u/${fixture.target.handle}`); await page.getByRole('button', { name: 'Follow', exact: true }).click()
    const editor = await writer.newPage(); await editor.goto(`/library/${fixture.collectionId}/edit`)
    for (let index = 0; index < 21; index += 1) {
      await saveCollectionTitle(editor, fixture.collectionId, `P5-22 notification page ${index}`)
      await control('/notification/await', { recipientProfileId: fixture.actor.profileId, minimumUnread: index + 1 })
    }
    await page.goto('/notifications'); await expect(page.locator('[data-notification-item]')).toHaveCount(20); await page.getByRole('button', { name: 'Load more' }).click(); await expect(page.locator('[data-notification-item]')).toHaveCount(21)
    const second = await context.newPage(); await enableNotifications(second, true); await second.goto('/notifications'); await second.locator('[data-notification-item]').first().getByRole('button', { name: /^Mark read/ }).click()
    await expect(unreadFilter(second, 20)).toHaveCount(1)
    await page.bringToFront(); await expect(unreadFilter(page, 20)).toHaveCount(1)
    expect((await control<{ unreadCount: number }>('/notification/authority', { recipientProfileId: fixture.actor.profileId })).unreadCount).toBe(20)
    await page.setViewportSize({ width: 320, height: 720 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const narrowMark = page.locator('[data-notification-read]').first(); await narrowMark.focus(); await expect(narrowMark).toBeFocused()
    await control('/api/stop'); await page.reload(); await expect(page.getByRole('alert').filter({ hasText: "Couldn't load notifications" })).toContainText("Couldn't load notifications")
    await control('/api/start'); await page.getByRole('alert').filter({ hasText: "Couldn't load notifications" }).getByRole('button', { name: 'Try again', exact: true }).click(); await expect(page.getByRole('alert').filter({ hasText: "Couldn't load notifications" })).toHaveCount(0)
  } finally { await context.close(); await writer.close(); await control('/api/start').catch(() => undefined) }
})

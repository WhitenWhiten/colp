import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'

/**
 * P5-30 real-stack email preference acceptance.
 *
 * The real API + worker run with KNOWN_FEATURE_EMAIL=true against the controlled
 * DirectMail fixture (real P5-28 adapter; NODE_EXTRA_CA_CERTS trusts the fixture
 * cert). Every assertion below observes the real preference authority and real
 * delivery rows; toggling a local checkbox is never sufficient.
 *
 * Provider-unavailable semantics: the backend honestly reports the email channel
 * unavailable when the capability is not configured (emailAvailable=false). The
 * fixture stop simulates the provider outage that dead-letters real deliveries
 * with last_error_category=provider_unavailable; the API/worker restart without
 * the email feature is what makes that unavailability observable in the UI
 * (no deployment probe exists in P5-30 scope).
 */
const controlUrl = process.env.KNOWN_REAL_STACK_CONTROL_URL
const controlToken = process.env.KNOWN_REAL_STACK_CONTROL_TOKEN
const webBaseUrl = process.env.KNOWN_REAL_STACK_WEB_BASE_URL
if (!controlUrl || !controlToken || !webBaseUrl) throw new Error('P5-30 real-stack infrastructure is required')
type Principal = { cookieValue: string; profileId: string; handle: string }
type Fixture = { actor: Principal; target: Principal; collectionId: string }
type Authority = {
  unreadCount: number
  preferenceEnabled: boolean | null
  emailPreferenceEnabled: boolean | null
  emailPreferenceRevision: string | null
  emailSuppressionSource: string | null
}
type DeliveryState = { count: number; latest: { deliveryId: string; notificationId: string; state: string; lastErrorCategory: string | null; tag: string } | null }
type DeliveryEvidence = { state: string; deliveryId: string; notificationId: string; attemptCount: number; lastErrorCategory: string | null; tag: string; emailEnabled: boolean | null }
type FixtureState = { origin: string; sentTagCounts: Record<string, number> }

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
async function enableNotifications(page: Page, notifications: boolean, email = true) {
  await page.addInitScript(({ notifications, email }) => {
    (window as Window & { __KNOWN_FLAGS__?: { notifications?: boolean; follow?: boolean; email?: boolean } }).__KNOWN_FLAGS__ = { notifications, follow: true, email }
  }, { notifications, email })
}
async function saveCollectionTitle(page: Page, collectionId: string, title: string) {
  const input = page.locator('#ce-title'); await input.fill(title)
  const response = page.waitForResponse((value) => value.request().method() === 'PATCH' && new URL(value.url()).pathname === `/api/v1/collections/${collectionId}`)
  await input.press('Enter'); expect((await response).status()).toBe(200)
}
function emailSwitch(page: Page) { return page.getByRole('switch', { name: 'Email notifications' }) }
function inAppSwitch(page: Page) { return page.getByRole('switch', { name: 'In-app notifications' }) }
async function openInAppSettings(page: Page) {
  await page.goto('/library?settings=notifications')
  await expect(inAppSwitch(page)).toBeVisible()
}
const totalSends = (state: FixtureState) => Object.values(state.sentTagCounts).reduce((sum, count) => sum + count, 0)

test('P5-30 real email preference authority drives delivery suppression, unsubscribe, and provider recovery', async ({ browser }) => {
  const fixture = await control<Fixture>('/notification/fixture', { emailRecipient: 'p530-recipient@example.invalid' })
  const recipient = await principalContext(browser, fixture.actor)
  const editor = await principalContext(browser, fixture.target)
  try {
    const page = await recipient.newPage(); await enableNotifications(page, true, true)
    await page.goto('/notifications')
    await expect(page.getByTestId('notification-center')).toBeVisible()

    // The email channel is independently usable and shows the verified sender.
    const email = emailSwitch(page)
    await expect(email).toBeVisible()
    await expect(email).toHaveAttribute('aria-checked', 'false')
    await expect(page.getByTestId('email-preference')).toContainText('known-no-reply@example.invalid')

    // Enable email: the browser mutation must flip the real preference authority.
    await email.click(); await expect(email).toHaveAttribute('aria-checked', 'true')
    const enabled = await control<Authority>('/notification/authority', { recipientProfileId: fixture.actor.profileId })
    expect(enabled.emailPreferenceEnabled).toBe(true)
    expect(enabled.preferenceEnabled).toBe(true)

    // Positive control: a real social event is delivered through the real worker.
    await page.goto(`/u/${fixture.target.handle}`)
    const followed = page.waitForResponse((response) => response.request().method() === 'PUT'
      && new URL(response.url()).pathname.endsWith('/follow'))
    await page.getByRole('button', { name: 'Follow', exact: true }).click()
    expect((await followed).status()).toBe(200)
    const editorPage = await editor.newPage(); await editorPage.goto(`/library/${fixture.collectionId}/edit`)
    await saveCollectionTitle(editorPage, fixture.collectionId, 'P5-30 email sent once')
    await control('/notification/await', { recipientProfileId: fixture.actor.profileId, minimumUnread: 1 })
    const delivered = await control<DeliveryEvidence>('/email-delivery/await', { recipientProfileId: fixture.actor.profileId })
    expect(delivered.state).toBe('delivered')
    expect(delivered.emailEnabled).toBe(true)
    const fixtureAfterSend = await control<FixtureState>('/email-fixture/state')
    expect(fixtureAfterSend.sentTagCounts[delivered.tag]).toBe(1)

    // (a) Toggle email OFF in the real browser -> authority flips -> a new real
    // social event still creates the in-app Notification but NO email delivery.
    await page.goto('/notifications'); const emailOff = emailSwitch(page)
    await emailOff.click(); await expect(emailOff).toHaveAttribute('aria-checked', 'false')
    const disabled = await control<Authority>('/notification/authority', { recipientProfileId: fixture.actor.profileId })
    expect(disabled.emailPreferenceEnabled).toBe(false)
    expect(disabled.preferenceEnabled).toBe(true)
    const suppressedNotificationId = delivered.notificationId
    await saveCollectionTitle(editorPage, fixture.collectionId, 'P5-30 email suppressed title')
    await control('/notification/await', { recipientProfileId: fixture.actor.profileId, minimumUnread: 2 })
    const afterOff = await control<DeliveryState>('/email-delivery/state', { recipientProfileId: fixture.actor.profileId })
    expect(afterOff.count).toBe(1)
    expect(afterOff.latest?.notificationId).toBe(suppressedNotificationId)
    const fixtureAfterSuppress = await control<FixtureState>('/email-fixture/state')
    // N8: delta scoping - with email disabled the fanout creates NO new email
    // delivery intent (count stays 1) and the fixture must see NO new sends
    // (total stays at the positive control's total). Comparing deltas against
    // the positive-control checkpoint makes this robust to extra positive
    // controls or fixture restarts, instead of assuming exactly one send.
    expect(fixtureAfterSuppress.sentTagCounts[delivered.tag]).toBe(1)
    expect(totalSends(fixtureAfterSuppress)).toBe(totalSends(fixtureAfterSend))

    // (b) Refresh: the UI stays consistent with the authority.
    await page.reload(); await expect(emailSwitch(page)).toHaveAttribute('aria-checked', 'false')
    expect((await control<Authority>('/notification/authority', { recipientProfileId: fixture.actor.profileId })).preferenceEnabled).toBe(true)

    // Multi-tab: a second tab observes the email toggle state via the existing
    // BroadcastChannel refresh mechanism after the first tab mutates it.
    const second = await recipient.newPage(); await enableNotifications(second, true, true)
    await second.goto('/notifications'); await expect(emailSwitch(second)).toHaveAttribute('aria-checked', 'false')
    await emailSwitch(page).click(); await expect(emailSwitch(page)).toHaveAttribute('aria-checked', 'true')
    await second.bringToFront(); await expect(emailSwitch(second)).toHaveAttribute('aria-checked', 'true')
    expect((await control<Authority>('/notification/authority', { recipientProfileId: fixture.actor.profileId })).emailPreferenceEnabled).toBe(true)

    // (d) Provider unavailable: stop the fixture, then the API/worker restart
    // without the email capability so the backend honestly reports unavailable;
    // in-app Notification remains usable; recovery restores the control. The
    // real worker classifies the unreachable endpoint as retryable
    // provider_unavailable per attempt and dead-letters with retry_exhausted at
    // the bounded max attempts; no send ever reaches the fixture.
    await control('/email-fixture/stop')
    await saveCollectionTitle(editorPage, fixture.collectionId, 'P5-30 provider down title')
    // Wait for the in-app Notification first: the fanout worker creates the email
    // delivery intent in the same authority transaction, so once the notification
    // is visible the new delivery row exists and the await below cannot observe a
    // stale previous delivery.
    await control('/notification/await', { recipientProfileId: fixture.actor.profileId, minimumUnread: 3 })
    const dead = await control<DeliveryEvidence>('/email-delivery/await', { recipientProfileId: fixture.actor.profileId })
    expect(dead.state).toBe('dead_letter')
    expect(dead.lastErrorCategory).toBe('retry_exhausted')
    expect(dead.attemptCount).toBe(3)
    const fixtureDownState = await control<FixtureState>('/email-fixture/state')
    // N8: per-tag scoping - the provider-down event must produce ZERO sends for
    // its own dead-lettered tag, while the positive control's tag keeps exactly
    // one. Robust to fixture restarts and extra positive controls.
    expect(fixtureDownState.sentTagCounts[dead.tag]).toBeUndefined()
    expect(fixtureDownState.sentTagCounts[delivered.tag]).toBe(1)
    await control('/api-and-worker/restart-without-email')
    await page.reload(); await expect(page.getByTestId('notification-center')).toBeVisible()
    await expect(page.getByTestId('email-preference')).toContainText('Email notifications are unavailable')
    await expect(emailSwitch(page)).toHaveCount(0)
    await openInAppSettings(page)
    await inAppSwitch(page).click(); await expect(inAppSwitch(page)).toHaveAttribute('aria-checked', 'false')
    await inAppSwitch(page).click(); await expect(inAppSwitch(page)).toHaveAttribute('aria-checked', 'true')
    await page.goto('/notifications')
    await control('/email-fixture/start')
    await control('/api-and-worker/restart-with-email')
    await page.reload(); await expect(emailSwitch(page)).toBeVisible()
    await expect(emailSwitch(page)).toHaveAttribute('aria-checked', 'true')

    // (c) Unsubscribe state: seed a verified suppression fact through the
    // production reconcileCallback path; the UI shows the read-only unsubscribed
    // state, stays consistent on refresh, and subsequent real events never send.
    await control('/email/suppress', { recipientEmail: 'p530-recipient@example.invalid', source: 'unsubscribe' })
    const suppressed = await control<Authority>('/notification/authority', { recipientProfileId: fixture.actor.profileId })
    expect(suppressed.emailSuppressionSource).toBe('unsubscribe')
    await page.reload(); const unsubscribed = page.getByTestId('email-preference')
    await expect(unsubscribed).toContainText('unsubscribed')
    await expect(emailSwitch(page)).toHaveCount(0)
    await saveCollectionTitle(editorPage, fixture.collectionId, 'P5-30 unsubscribed title')
    await control('/notification/await', { recipientProfileId: fixture.actor.profileId, minimumUnread: 4 })
    // The delivery row is created and the worker recheck suppresses it BEFORE
    // any send: state=suppressed, zero new fixture sends.
    const suppressedDelivery = await control<DeliveryEvidence>('/email-delivery/await', { recipientProfileId: fixture.actor.profileId })
    expect(suppressedDelivery.state).toBe('suppressed')
    // The fixture was restarted for provider recovery, so its counter restarts at
    // zero; the unsubscribed event must produce ZERO provider sends on it.
    const fixtureAfterUnsubscribed = await control<FixtureState>('/email-fixture/state')
    expect(totalSends(fixtureAfterUnsubscribed)).toBe(0)
    await page.reload(); await expect(page.getByTestId('email-preference')).toContainText('unsubscribed')
    await openInAppSettings(page)
    await expect(inAppSwitch(page)).toBeVisible()
  } finally {
    await control('/email/off').catch(() => undefined)
    await control('/email-fixture/start').catch(() => undefined)
    await control('/api-and-worker/restart-with-email').catch(() => undefined)
    await recipient.close().catch(() => undefined)
    await editor.close().catch(() => undefined)
  }
})

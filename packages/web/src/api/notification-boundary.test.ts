import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createProductNotificationClient,
  type NotificationInboxPage,
  type NotificationPreference,
} from '@known/product-v1-client'

describe('P5-22 generated Notification boundary', () => {
  it('uses the P5-21 generated client and contract types without a copied protocol', () => {
    expect(typeof createProductNotificationClient).toBe('function')
    const page: NotificationInboxPage = { items: [], nextCursor: null, unreadCount: 7 }
    const preference: NotificationPreference = {
      channel: 'in_app', enabled: true, revision: '3', updatedAt: '2026-07-29T00:00:00.000Z',
      email: { enabled: false, revision: '0', updatedAt: '2026-07-29T00:00:00.000Z',
        verifiedSender: 'no-reply@example.test', emailSuppressed: false, emailAvailable: true },
    }
    expect(page.unreadCount).toBe(7)
    expect(preference.channel).toBe('in_app')
    expect(preference.email?.emailAvailable).toBe(true)
  })

  it('keeps notification production code free of demo data and copied fetch routes', () => {
    const page = readFileSync(resolve('src/pages/Notifications.tsx'), 'utf8')
    const hook = readFileSync(resolve('src/lib/useNotificationCenter.ts'), 'utf8')
    const client = [
      readFileSync(resolve('src/api/productClient.ts'), 'utf8'),
      readFileSync(resolve('src/api/product-client-generated.ts'), 'utf8'),
    ].join('\n')
    // R15-27: the bell's count comes from the one shared unread feed.
    const topNav = readFileSync(resolve('src/components/UnreadBadgeFeed.tsx'), 'utf8')
    expect(page).not.toMatch(/notificationsSeed|legacyNotifications|Creator|Billing/u)
    expect(hook).not.toMatch(/legacy-demo|mock-data|notificationsSeed/u)
    expect(client).toContain('createProductNotificationClient')
    expect(client).not.toMatch(/fetch\([^\n]*api\/v1\/notifications/u)
    expect(topNav).toContain('notifications.unreadCount')
    expect(topNav).not.toMatch(/notifications\.items\.length/u)
  })
})

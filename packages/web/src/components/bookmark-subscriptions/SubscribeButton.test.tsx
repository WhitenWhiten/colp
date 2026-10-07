// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, mountTree, waitForDom } from '../../test/render'
import { clearSession, applySessionView } from '../../api/sessionStore'
import type { SessionView } from '../../api/types'
import { ToastProvider } from '../AppToast'
import { SubscribeButton } from './SubscribeButton'
const bridge = vi.hoisted(() => ({ open: vi.fn(), store: null as string | null }))
vi.mock('../../lib/bookmarkSubscriptionBridge', () => ({ openBookmarkSubscription: bridge.open, subscriptionDeployment: () => ({ extensionId: null, storeUrl: bridge.store }) }))
const button = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(item => item.textContent === label)
const click = async (label: string) => { const node = button(label); expect(node).toBeTruthy(); await act(async () => { node!.click() }) }
const mount = () => mountTree(<div className="page-head"><div className="page-head-actions"><SubscribeButton sourceType="collection" sourceId="col-1" /></div></div>, { route: '/c/reading?view=list', wrapper: ToastProvider })
beforeEach(() => { bridge.open.mockReset(); bridge.store = null })
afterEach(cleanup)

it('keeps the masthead row to buttons and moves setup guidance into a dialog when the extension is unavailable', async () => {
  bridge.open.mockResolvedValue('unavailable')
  mount()
  await click('Subscribe to bookmarks')
  const control = document.querySelector('[data-testid="subscribe-control"]')!
  expect(control.textContent).toBe('Subscribe to bookmarks')
  expect(control.querySelector('[role="status"], a')).toBeNull()
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
  expect(dialog).toBeTruthy()
  expect(dialog.closest('.page-head')).toBeNull()
  expect(dialog.querySelectorAll('ol li')).toHaveLength(3)
  expect(dialog.querySelector('a[href="/extension?return=%2Fc%2Freading%3Fview%3Dlist"]')?.textContent).toBe('Extension setup')
  expect(dialog.querySelector('[role="alert"]')).toBeNull()
})

it('retries from the dialog, reports a second miss, and closes with a toast once the extension accepts', async () => {
  bridge.store = 'https://chromewebstore.google.com/detail/know-n'
  bridge.open.mockResolvedValue('unavailable')
  mount()
  await click('Subscribe to bookmarks')
  expect(document.querySelector('[role="dialog"] a[target="_blank"]')?.getAttribute('href')).toBe(bridge.store)
  await click('Continue in extension')
  expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain("still didn't respond")
  bridge.open.mockResolvedValue('accepted')
  await click('Continue in extension')
  const requestIds = bridge.open.mock.calls.map(call => call[1])
  expect(requestIds).toEqual([requestIds[0], requestIds[0], requestIds[0]])
  await waitForDom(() => document.querySelector('[role="dialog"]') === null)
  expect(document.body.textContent).toContain("Continue setup in the extension. Bookmarks aren't on yet.")
  expect(document.querySelector('[data-testid="subscribe-control"]')?.textContent).toBe('Subscribe to bookmarks')
})

it('signed in, the chevron opens a menu of worded actions rather than jumping straight to a dialog', async () => {
  applySessionView({ authenticated: true, csrfToken: 'csrf', idleExpiresAt: '2099-01-01T00:00:00Z', absoluteExpiresAt: '2099-01-01T00:00:00Z' } as SessionView)
  try {
    mount()
    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="Bookmark subscription options"]')!
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger.querySelector('svg')).toBeTruthy()
    await act(async () => { trigger.click() })
    const items = Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]')).map(item => item.textContent)
    expect(items).toEqual(['Extension setup', 'Unsubscribe on all browsers…'])
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  } finally { clearSession() }
})

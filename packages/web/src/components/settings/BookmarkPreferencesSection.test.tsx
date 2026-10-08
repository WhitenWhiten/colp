// @vitest-environment happy-dom
import { act } from 'react'
import { mountTree, cleanup, waitForDom } from '../../test/render'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ProductApiError } from '../../api/errors'
import { BookmarkPreferencesSection } from './BookmarkPreferencesSection'

const mocks = vi.hoisted(() => ({ accountId: 'a', read: vi.fn(), update: vi.fn() }))
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ user: { accountId: mocks.accountId } }) }))
vi.mock('../../api', async importOriginal => ({ ...await importOriginal<object>(),
  productClient: { getBookmarkPreferences: mocks.read, updateBookmarkPreferences: mocks.update } }))
const remote = { preferences: { bookmarkInsertPosition: 'bottom', foldersFirst: true, captureMode: 'manual',
  resultPanelAutoDismissMs: 3000, learnFromCorrections: true, resumeClassificationWhenOnline: true,
  revision: '1', updatedAt: '2026-09-20T00:00:00Z' }, etag: '"1"' }

beforeEach(() => { localStorage.clear(); mocks.accountId = 'a'; mocks.read.mockReset().mockResolvedValue(remote); mocks.update.mockReset() })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('persists an offline choice before showing success and replays the same intent on reconnect', async () => {
  mocks.update.mockRejectedValue(new Error('offline'))
  mountTree(<BookmarkPreferencesSection />)
  await waitForDom(() => Boolean(document.querySelector('input[type="checkbox"]')))
  const input = [...document.querySelectorAll<HTMLInputElement>('input')].find(node => node.parentElement?.textContent?.includes('Use my classification corrections'))!
  await act(async () => input.click())
  await waitForDom(() => Boolean(document.body.textContent?.includes('It will sync when you reconnect')))
  const [patch, etag, options] = mocks.update.mock.calls[0]!
  expect(patch).toEqual({ learnFromCorrections: false }); expect(etag).toBe('"1"')
  mocks.update.mockResolvedValue({ ...remote, preferences: { ...remote.preferences, learnFromCorrections: false } })
  await act(async () => window.dispatchEvent(new Event('online')))
  await waitForDom(() => Boolean(document.body.textContent?.includes('Saved to your account.')))
  expect(mocks.update.mock.calls[1]?.[2].intentId).toBe(options.intentId)
})

it('does not claim persistence or issue a mutation if browser storage fails', async () => {
  mountTree(<BookmarkPreferencesSection />)
  await waitForDom(() => Boolean(document.querySelector('input[type="checkbox"]')))
  const input = [...document.querySelectorAll<HTMLInputElement>('input')].find(node => node.parentElement?.textContent?.includes('Use my classification corrections'))!
  vi.stubGlobal('localStorage', { getItem: localStorage.getItem.bind(localStorage), setItem() { throw new Error('quota') } })
  await act(async () => input.click())
  await waitForDom(() => Boolean(document.body.textContent?.includes('Not saved. Browser storage is unavailable')))
  const alert = document.querySelector('[role="alert"]')
  expect(alert?.textContent).toContain('Not saved. Browser storage is unavailable')
  expect(alert?.classList.contains('field-error')).toBe(true)
  expect(mocks.update).not.toHaveBeenCalled()
})

it('hides previous account state immediately and discards its late response', async () => {
  let resolve!: (value: typeof remote) => void
  mocks.read.mockImplementation(() => mocks.accountId === 'a' ? new Promise(done => { resolve = done }) : Promise.resolve(remote))
  const view = mountTree(<BookmarkPreferencesSection />)
  mocks.accountId = 'b'; view.rerender(<BookmarkPreferencesSection />)
  await waitForDom(() => document.querySelector('select') !== null)
  await act(async () => resolve({ ...remote, preferences: { ...remote.preferences, captureMode: 'automatic' } }))
  expect(document.querySelector('select')?.value).toBe('manual')
})

it('renders a conflict with human-readable values, not raw booleans', async () => {
  mocks.update.mockRejectedValueOnce(new ProductApiError({ status: 412, code: 'conflict', message: 'conflict' }))
  mocks.read.mockResolvedValueOnce(remote).mockResolvedValueOnce({ ...remote, preferences: { ...remote.preferences, foldersFirst: true }, etag: '"2"' })
  mountTree(<BookmarkPreferencesSection />)
  await waitForDom(() => Boolean(document.querySelector('input[type="checkbox"]')))
  const input = [...document.querySelectorAll<HTMLInputElement>('input')].find(node => node.parentElement?.textContent?.includes('Folders first'))!
  await act(async () => input.click())
  await waitForDom(() => Boolean(document.querySelector('table')))
  const row = [...document.querySelectorAll('tr')].find(node => node.textContent?.includes('Folders first'))!
  expect(row.textContent).toContain('Off')
  expect(row.textContent).toContain('On')
  expect(row.textContent).not.toMatch(/true|false/)
})

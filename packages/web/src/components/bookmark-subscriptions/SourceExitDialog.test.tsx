// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, mountTree, waitForDom } from '../../test/render'
import { SourceExitDialog } from './SourceExitDialog'
import { ProductApiError } from '../../api/errors'
const api = vi.hoisted(() => ({ preview: vi.fn(), confirm: vi.fn(), find: vi.fn() }))
vi.mock('../../api', async original => ({ ...await original<typeof import('../../api')>(), productClient: { previewBookmarkSubscriptionExit: api.preview, confirmBookmarkSubscriptionExit: api.confirm, findBookmarkSubscription: api.find } }))
const source = { sourceType: 'digest_series' as const, sourceId: 'private-series' }
const preview = { previewId: '11111111-1111-4111-8111-111111111111', expiresAt: '2099-01-01T00:00:00Z', targets: [{ mappingId: 'mapping-1', profileLabel: 'Work browser', effectiveAction: 'remove', policyOrigin: 'mapping' }] }
const click = (label: string) => { const node = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(item => item.textContent === label); expect(node).toBeTruthy(); act(() => node!.click()) }
beforeEach(() => { api.preview.mockReset().mockResolvedValue(preview); api.confirm.mockReset().mockResolvedValue(undefined); api.find.mockReset().mockResolvedValue({ subscriptionId: 'sub-1' }) })
afterEach(cleanup)
it('shows each frozen action and only commits after explicit confirmation', async () => {
  const committed = vi.fn(async () => undefined); mountTree(<SourceExitDialog source={source} unfollow onClose={vi.fn()} onCommitted={committed} />)
  await waitForDom(() => document.body.textContent?.includes('Work browser') === true)
  expect(document.body.textContent).toContain('Remove synced bookmarks'); expect(document.body.textContent).toContain("Set by this browser's own setting"); expect(api.confirm).not.toHaveBeenCalled()
  click('Confirm unfollow'); await waitForDom(() => document.body.textContent?.includes('You no longer follow this digest') === true)
  expect(api.confirm).toHaveBeenCalledWith(source,preview.previewId,true,expect.objectContaining({ intentId: expect.stringContaining('subscription-exit:'), signal: expect.any(AbortSignal) })); expect(committed).toHaveBeenCalledOnce()
})
it('retains its exact command after unknown result and requires a new review after 412', async () => {
  api.confirm.mockRejectedValueOnce(new Error('timeout')).mockRejectedValueOnce(new ProductApiError({status:412,code:'precondition_failed',message:'Changed',recovery:'refresh_and_retry',sameRequestRetrySafe:false}))
  mountTree(<SourceExitDialog source={source} unfollow onClose={vi.fn()} />); await waitForDom(() => document.body.textContent?.includes('Work browser') === true)
  const initialPreviews = api.preview.mock.calls.length; click('Confirm unfollow'); await waitForDom(() => document.body.textContent?.includes('Retry same action') === true); click('Retry same action'); await waitForDom(() => document.body.textContent?.includes('Refresh preview') === true)
  expect(api.confirm.mock.calls[0]![3].intentId).toBe(api.confirm.mock.calls[1]![3].intentId); expect(api.preview).toHaveBeenCalledTimes(initialPreviews)
  click('Refresh preview'); await waitForDom(() => api.preview.mock.calls.length === initialPreviews + 1); expect(api.confirm).toHaveBeenCalledTimes(2)
})
it('looks up account configuration separately before source-wide unsubscribe', async () => {
  mountTree(<SourceExitDialog source={source} unfollow={false} onClose={vi.fn()} />); await waitForDom(() => document.body.textContent?.includes('Work browser') === true)
  expect(api.preview).toHaveBeenCalledWith(source,'sub-1',expect.any(Object)); click('Confirm unsubscribe'); await waitForDom(() => api.confirm.mock.calls.length === 1); expect(api.confirm.mock.calls[0]![2]).toBe(false)
})

// @vitest-environment happy-dom

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, mountTree, waitForDom } from '../../test/render'
import { FaviconSection } from './FaviconSection'

const mocks = vi.hoisted(() => ({
  getMyFaviconPolicy: vi.fn(),
  updateMyFaviconPolicy: vi.fn(),
  getMyFaviconJob: vi.fn(),
  retryMyFaviconJob: vi.fn(),
  mutationIntentKey: (scope: string, id: string) => `${scope}:${id}`,
  newCommandId: () => 'command-fav',
  isProductApiError: (error: unknown) =>
    typeof error === 'object' && error !== null && 'recoveryHint' in error,
}))

vi.mock('../../api', () => ({
  productClient: {
    getMyFaviconPolicy: mocks.getMyFaviconPolicy,
    updateMyFaviconPolicy: mocks.updateMyFaviconPolicy,
    getMyFaviconJob: mocks.getMyFaviconJob,
    retryMyFaviconJob: mocks.retryMyFaviconJob,
    mutationIntentKey: mocks.mutationIntentKey,
    newCommandId: mocks.newCommandId,
  },
  isProductApiError: mocks.isProductApiError,
}))

function policy(overrides: Record<string, unknown> = {}) {
  return {
    ...{
      revision: '1',
      newDefault: 'capture',
      providerTemplate: 'https://favicone.com/{hostname}',
      fillMissing: false,
      forceAllOnline: false,
      updatedAt: '2026-09-14T00:00:00.000Z',
      etag: '"favicon-policy:1"',
    },
    ...overrides,
  }
}

async function flushAsync(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
}

describe('Settings FaviconSection', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    mocks.getMyFaviconPolicy.mockReset()
    mocks.updateMyFaviconPolicy.mockReset()
    mocks.getMyFaviconJob.mockReset()
    mocks.retryMyFaviconJob.mockReset()
  })

  afterEach(() => cleanup())

  it('loads the policy first, then PATCHes the new default with the server ETag and refreshes', async () => {
    /* Stateful endpoint, not a one-shot queue: StrictMode mounts the section
       twice, so both mount reads must see the SAME policy and only the PATCH
       may change what the next read returns. */
    let current = policy()
    mocks.getMyFaviconPolicy.mockImplementation(async () => current)
    mocks.updateMyFaviconPolicy.mockImplementation(async (patch: Record<string, unknown>) => {
      current = policy({ revision: '2', etag: '"favicon-policy:2"', ...patch })
      return { policy: { revision: '2', ...patch }, jobId: null }
    })

    mountTree(<FaviconSection />)
    await act(async () => { await Promise.resolve() })
    const capture = document.querySelector<HTMLInputElement>('input[value="capture"]')!
    const none = document.querySelector<HTMLInputElement>('input[value="none"]')!
    expect(capture.checked).toBe(true)
    expect(none.checked).toBe(false)

    await act(async () => {
      none.click()
    })
    expect(mocks.updateMyFaviconPolicy).toHaveBeenCalledWith(
      { newDefault: 'none' },
      '"favicon-policy:1"',
      expect.objectContaining({ intentId: 'favicon-policy:me:command-fav' }),
    )
    // After the successful PATCH the section re-reads the policy: none is now checked.
    const noneAfter = document.querySelector<HTMLInputElement>('input[value="none"]')!
    expect(noneAfter.checked).toBe(true)
    const captureAfter = document.querySelector<HTMLInputElement>('input[value="capture"]')!
    expect(captureAfter.checked).toBe(false)
  })

  it('a response from the superseded mount pass cannot overwrite the live policy', async () => {
    /* The controller is what normally prevents a stale apply, but this section
       also supports callers that pass NO signal, and the mount effect's cleanup
       aborts the pass it started. Without a post-await abort check the FIRST
       mount pass — the one StrictMode tears down — could resolve after the live
       pass and paint its policy over it. */
    let releaseFirst!: (value: ReturnType<typeof policy>) => void
    let releaseSecond!: (value: ReturnType<typeof policy>) => void
    mocks.getMyFaviconPolicy
      .mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = resolve }))
      .mockImplementationOnce(() => new Promise((resolve) => { releaseSecond = resolve }))

    mountTree(<FaviconSection />)
    await waitForDom(() => mocks.getMyFaviconPolicy.mock.calls.length >= 2)

    await act(async () => { releaseSecond(policy({ providerTemplate: 'https://live.example/{hostname}' })) })
    await waitForDom(() => document.querySelector<HTMLInputElement>(
      '[data-testid="favicon-provider-template"]')?.value.includes('live.example') === true)

    await act(async () => { releaseFirst(policy({ providerTemplate: 'https://stale.example/{hostname}' })) })
    expect(document.querySelector<HTMLInputElement>('[data-testid="favicon-provider-template"]')?.value)
      .toContain('live.example')
  })

  it('feature flag off (404) renders the read-only note and no controls', async () => {
    mocks.getMyFaviconPolicy.mockRejectedValue({
      status: 404, code: 'resource_not_found', recoveryHint: 'Not found',
    })

    mountTree(<FaviconSection />)
    await act(async () => { await Promise.resolve() })

    expect(document.querySelector('[data-testid="favicon-policy-unavailable"]')).not.toBeNull()
    expect(document.querySelector('input[type="radio"]')).toBeNull()
  })

  it('FO-03: online default, provider template, fill and force all PATCH their fields', async () => {
    /* Stateful endpoint: each PATCH revises the policy (bumping the ETag the
       NEXT PATCH must send) and every re-read after a save sees that revision. */
    let current = policy()
    mocks.getMyFaviconPolicy.mockImplementation(async () => current)
    mocks.updateMyFaviconPolicy.mockImplementation(async (patch: Record<string, unknown>) => {
      current = policy({ revision: '2', etag: '"favicon-policy:2"', ...patch })
      return { policy: { revision: '2', ...patch }, jobId: null }
    })

    mountTree(<FaviconSection />)
    await act(async () => { await Promise.resolve() })

    const online = document.querySelector<HTMLInputElement>('input[value="online"]')!
    expect(online).not.toBeNull()
    await act(async () => { online.click() })
    await flushAsync()
    expect(mocks.updateMyFaviconPolicy).toHaveBeenLastCalledWith(
      { newDefault: 'online' }, '"favicon-policy:1"', expect.anything())

    const fill = document.querySelector<HTMLInputElement>('[data-testid="favicon-fill-missing"]')!
    await act(async () => { fill.click() })
    await flushAsync()
    expect(mocks.updateMyFaviconPolicy).toHaveBeenLastCalledWith(
      { fillMissing: true }, '"favicon-policy:2"', expect.anything())

    const force = document.querySelector<HTMLInputElement>('[data-testid="favicon-force-online"]')!
    await act(async () => { force.click() })
    await flushAsync()
    expect(mocks.updateMyFaviconPolicy).toHaveBeenLastCalledWith(
      { forceAllOnline: true }, '"favicon-policy:2"', expect.anything())

    const template = document.querySelector<HTMLInputElement>('[data-testid="favicon-provider-template"]')!
    expect(template.value).toBe('https://favicone.com/{hostname}')
    // Set through the native value setter so React's value tracker sees it, and
    // inside act() so the draft/dirty updates it triggers are flushed here.
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    act(() => {
      nativeSetter.call(template, 'https://icons.example.com/{hostname}')
      template.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flushAsync()
    const saveProvider = document.querySelector<HTMLButtonElement>('[data-testid="favicon-provider-save"]')!
    expect(saveProvider.disabled).toBe(false)
    await act(async () => { saveProvider.click() })
    await flushAsync()
    expect(mocks.updateMyFaviconPolicy).toHaveBeenLastCalledWith(
      { providerTemplate: 'https://icons.example.com/{hostname}' }, '"favicon-policy:2"', expect.anything())
  })

  it('FO-03: a policy change returning a jobId polls the batch job and offers a failed-items retry', async () => {
    vi.useFakeTimers()
    /* Stateful endpoint: the fill-missing PATCH starts batch job 100 and the
       section re-reads the policy at its new revision afterwards. */
    let current = policy()
    mocks.getMyFaviconPolicy.mockImplementation(async () => current)
    mocks.updateMyFaviconPolicy.mockImplementation(async (patch: Record<string, unknown>) => {
      current = policy({ revision: '2', etag: '"favicon-policy:2"', ...patch })
      return { policy: { revision: '2' }, jobId: '123e4567-e89b-42d3-a456-426614174100' }
    })
    // Both reads of a job id answer the same way: StrictMode mounts the subtree
    // twice, so a `mockResolvedValueOnce` queue would hand the two mounts
    // different jobs.
    const partial = { status: 'partial' as const, succeeded: 9, total: 10, failed: 1, skipped: 0,
      errors: [{ nodeId: 'n9', reason: 'fetch_failed' }] }
    const succeeded = { status: 'succeeded' as const, succeeded: 1, total: 1, failed: 0, skipped: 0 }
    mocks.getMyFaviconJob.mockImplementation(async (jobId: string) =>
      jobId === '123e4567-e89b-42d3-a456-426614174100' ? partial : succeeded)
    mocks.retryMyFaviconJob.mockResolvedValue({ jobId: '123e4567-e89b-42d3-a456-426614174101' })

    mountTree(<FaviconSection />)
    await act(async () => { await Promise.resolve() })
    const fill = document.querySelector<HTMLInputElement>('[data-testid="favicon-fill-missing"]')!
    await act(async () => { fill.click() })
    // The job progress appears and reads the durable job.
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(mocks.getMyFaviconJob).toHaveBeenCalledWith(
      '123e4567-e89b-42d3-a456-426614174100', expect.objectContaining({ maxRetries: 0 }))
    const retry = document.querySelector<HTMLButtonElement>('[data-testid="favicon-job-retry"]')!
    expect(retry).not.toBeNull()
    expect(retry.textContent).toContain('Retry 1 failed')

    await act(async () => { retry.click() })
    await act(async () => { await Promise.resolve() })
    expect(mocks.retryMyFaviconJob).toHaveBeenCalledWith(
      '123e4567-e89b-42d3-a456-426614174100',
      expect.objectContaining({ intentId: `retry-favicon-job:123e4567-e89b-42d3-a456-426614174100:command-fav` }),
    )
    // The retry job id is tracked now.
    expect(mocks.getMyFaviconJob).toHaveBeenLastCalledWith(
      '123e4567-e89b-42d3-a456-426614174101', expect.objectContaining({ maxRetries: 0 }))
    vi.useRealTimers()
  })

  it('stale ETag (412) refreshes the policy instead of failing the section', async () => {
    /* Stateful endpoint: the PATCH loses a race to another writer, so it rejects
       with 412 and the policy the NEXT read sees is the other writer's revision. */
    let current = policy()
    mocks.getMyFaviconPolicy.mockImplementation(async () => current)
    mocks.updateMyFaviconPolicy.mockImplementation(async () => {
      current = policy({ revision: '2', newDefault: 'capture', etag: '"favicon-policy:2"' })
      throw {
        status: 412, code: 'precondition_failed', isPreconditionFailed: true,
        recoveryHint: 'Changed elsewhere — refreshed.',
      }
    })

    mountTree(<FaviconSection />)
    await act(async () => { await Promise.resolve() })
    const loadsAfterMount = mocks.getMyFaviconPolicy.mock.calls.length
    const none = document.querySelector<HTMLInputElement>('input[value="none"]')!
    await act(async () => { none.click() })

    // The 412 handler re-fetched the policy exactly once (no refetch loop) and
    // the section keeps working. The mount count itself is React's, not the
    // request contract's: StrictMode renders the mount effect twice by design.
    expect(mocks.getMyFaviconPolicy).toHaveBeenCalledTimes(loadsAfterMount + 1)
    expect(document.querySelector('[role="alert"]')).toBeNull()
    const capture = document.querySelector<HTMLInputElement>('input[value="capture"]')!
    expect(capture.checked).toBe(true)
  })

  it('a failed save renders the notice as a danger-styled alert, not quiet meta text', async () => {
    mocks.getMyFaviconPolicy.mockImplementation(async () => policy())
    mocks.updateMyFaviconPolicy.mockRejectedValue({
      status: 400, code: 'invalid_request',
      recoveryHint: 'If-Match must be a single strong entity-tag.',
    })

    mountTree(<FaviconSection />)
    await act(async () => { await Promise.resolve() })
    const none = document.querySelector<HTMLInputElement>('input[value="none"]')!
    await act(async () => { none.click() })
    await flushAsync()

    const notice = document.querySelector('[data-testid="favicon-policy-notice"]')!
    expect(notice.getAttribute('role')).toBe('alert')
    expect(notice.classList.contains('field-error')).toBe(true)
    expect(notice.textContent).toBe('If-Match must be a single strong entity-tag.')
  })
})
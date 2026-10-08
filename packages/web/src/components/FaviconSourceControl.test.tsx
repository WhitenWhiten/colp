// @vitest-environment happy-dom

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, mountTree } from '../test/render'
import { FaviconSourceControl } from './FaviconSourceControl'

const mocks = vi.hoisted(() => ({
  getBookmarkFaviconSource: vi.fn(),
  setBookmarkFaviconSource: vi.fn(),
  refreshBookmarkFavicon: vi.fn(),
  getMyFaviconJob: vi.fn(),
  mutationIntentKey: (scope: string, id: string) => `${scope}:${id}`,
  newCommandId: () => 'command-src',
  isProductApiError: (error: unknown) =>
    typeof error === 'object' && error !== null && 'recoveryHint' in error,
}))

vi.mock('../api', () => ({
  productClient: {
    getBookmarkFaviconSource: mocks.getBookmarkFaviconSource,
    setBookmarkFaviconSource: mocks.setBookmarkFaviconSource,
    refreshBookmarkFavicon: mocks.refreshBookmarkFavicon,
    getMyFaviconJob: mocks.getMyFaviconJob,
    mutationIntentKey: mocks.mutationIntentKey,
    newCommandId: mocks.newCommandId,
  },
  isProductApiError: mocks.isProductApiError,
}))

function source(overrides: Record<string, unknown> = {}) {
  return {
    ...{
      collectionId: 'col-1',
      nodeId: 'node-1',
      revision: '1',
      policyRevision: '1',
      sourceMode: 'inherit',
      effectiveMode: 'capture',
      iconUrl: null,
      iconVersion: null,
      directUrl: null,
      status: 'missing',
      restorable: false,
      updatedAt: '2026-09-14T00:00:00.000Z',
      etag: '"favicon-source:res-1:1"',
    },
    ...overrides,
  }
}

describe('FaviconSourceControl (bookmark inspector)', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    mocks.getBookmarkFaviconSource.mockReset()
    mocks.setBookmarkFaviconSource.mockReset()
    mocks.refreshBookmarkFavicon.mockReset()
    mocks.getMyFaviconJob.mockReset()
    vi.useRealTimers()
  })

  afterEach(() => cleanup())

  it('refreshKey changing while refresh POST is pending must not freeze controls', async () => {
    vi.useFakeTimers()
    mocks.getBookmarkFaviconSource.mockResolvedValue(source({ sourceMode: 'online', effectiveMode: 'online' }))
    let release!: (value: unknown) => void
    mocks.refreshBookmarkFavicon.mockImplementation(() => new Promise(resolve => { release = resolve }))
    mocks.getMyFaviconJob.mockResolvedValue({status: 'succeeded'})
    const tree = mountTree(<FaviconSourceControl collectionId="col-1" nodeId="node-1" disabled={false} refreshKey={1} />)
    await act(async () => { await Promise.resolve() })
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="favicon-source-refresh"]')!.click() })
    tree.rerender(<FaviconSourceControl collectionId="col-1" nodeId="node-1" disabled={false} refreshKey={2} />)
    await act(async () => { await Promise.resolve(); release({ jobId: 'job-1' }); await vi.advanceTimersByTimeAsync(10000) })
    expect(document.querySelector<HTMLFieldSetElement>('fieldset')!.disabled).toBe(false)
    vi.useRealTimers()
  })

  it.each(['waiting', 'in-flight'] as const)('releases controls when refreshKey replaces a %s poll', async (phase) => {
    vi.useFakeTimers()
    mocks.getBookmarkFaviconSource.mockResolvedValue(source({ sourceMode: 'online', effectiveMode: 'online' }))
    mocks.refreshBookmarkFavicon.mockResolvedValue({ jobId: 'job-old' })
    let release!: (value: unknown) => void
    mocks.getMyFaviconJob.mockImplementation(() => new Promise(resolve => { release = resolve }))
    const tree = mountTree(<FaviconSourceControl collectionId="col-1" nodeId="node-1" disabled={false} refreshKey={1} />)
    await act(async () => { await Promise.resolve() })
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="favicon-source-refresh"]')!.click() })
    if (phase === 'in-flight') await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    tree.rerender(<FaviconSourceControl collectionId="col-1" nodeId="node-1" disabled={false} refreshKey={2} />)
    await act(async () => {
      await Promise.resolve()
      if (phase === 'in-flight') release({ status: 'running' })
      await vi.advanceTimersByTimeAsync(10000)
    })
    expect(document.querySelector<HTMLFieldSetElement>('fieldset')!.disabled).toBe(false)
    expect(mocks.getMyFaviconJob).toHaveBeenCalledTimes(phase === 'in-flight' ? 1 : 0)
    vi.useRealTimers()
  })

  it('ignores a failed old POST while a new node refresh owns the controls', async () => {
    vi.useFakeTimers()
    mocks.getBookmarkFaviconSource.mockResolvedValue(source({ sourceMode: 'online', effectiveMode: 'online' }))
    let rejectOld!: (error: unknown) => void
    mocks.refreshBookmarkFavicon.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject }))
      .mockResolvedValue({ jobId: 'job-new' })
    mocks.getMyFaviconJob.mockResolvedValue({ status: 'succeeded' })
    const tree = mountTree(<FaviconSourceControl collectionId="col-1" nodeId="node-1" disabled={false} />)
    await act(async () => { await Promise.resolve() })
    const clickRefresh = () => document.querySelector<HTMLButtonElement>('[data-testid="favicon-source-refresh"]')!.click()
    await act(async () => { clickRefresh() })
    tree.rerender(<FaviconSourceControl collectionId="col-1" nodeId="node-2" disabled={false} />)
    await act(async () => { await Promise.resolve() })
    await act(async () => { clickRefresh(); rejectOld(new Error('old failure')) })
    expect(document.querySelector<HTMLFieldSetElement>('fieldset')!.disabled).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(mocks.getMyFaviconJob).toHaveBeenCalledWith('job-new', expect.anything())
    expect(document.querySelector<HTMLFieldSetElement>('fieldset')!.disabled).toBe(false)
    expect(document.body.textContent).not.toContain('could not be started')
    vi.useRealTimers()
  })

  it('GETs the source ETag and PUTs inherit/none with If-Match, then refreshes', async () => {
    /* Stateful endpoint instead of a one-shot queue: StrictMode mounts the
       control twice, so both mount reads must see the SAME source, and only the
       PUT may change what the next read returns. */
    let current = source()
    mocks.getBookmarkFaviconSource.mockImplementation(async () => current)
    mocks.setBookmarkFaviconSource.mockImplementation(
      async (_collectionId: string, _nodeId: string, patch: { sourceMode: string }) => {
        current = source({
          revision: '2', sourceMode: patch.sourceMode, effectiveMode: patch.sourceMode,
          etag: '"favicon-source:res-1:2"',
        })
        return current
      },
    )

    mountTree(<FaviconSourceControl collectionId="col-1" nodeId="node-1" disabled={false} />)
    await act(async () => { await Promise.resolve() })

    const inherit = document.querySelector<HTMLInputElement>('input[value="inherit"]')!
    const none = document.querySelector<HTMLInputElement>('input[value="none"]')!
    expect(inherit.checked).toBe(true)
    expect(none.checked).toBe(false)

    await act(async () => { none.click() })
    expect(mocks.setBookmarkFaviconSource).toHaveBeenCalledWith(
      'col-1',
      'node-1',
      { sourceMode: 'none' },
      '"favicon-source:res-1:1"',
      expect.objectContaining({ intentId: 'set-favicon-source:col-1:node-1:command-src' }),
    )
    // Refreshed source view: none is now checked and inherit unchecked.
    const noneAfter = document.querySelector<HTMLInputElement>('input[value="none"]')!
    expect(noneAfter.checked).toBe(true)
    const inheritAfter = document.querySelector<HTMLInputElement>('input[value="inherit"]')!
    expect(inheritAfter.checked).toBe(false)
  })

  it('uploaded source is shown as locked and never offered as a PUT option', async () => {
    mocks.getBookmarkFaviconSource.mockResolvedValue(source({
      revision: '2', sourceMode: 'uploaded', effectiveMode: 'uploaded', status: 'ready',
    }))
    mountTree(<FaviconSourceControl collectionId="col-1" nodeId="node-1" disabled={false} />)
    await act(async () => { await Promise.resolve() })

    expect(document.querySelector('[data-testid="favicon-source-uploaded"]')).not.toBeNull()
    expect(document.querySelector('input[value="uploaded"]')).toBeNull()
    // inherit stays checked-ish: the effective mode is uploaded but neither
    // inherit nor none radio is selected; switching to none removes the upload.
    const none = document.querySelector<HTMLInputElement>('input[value="none"]')!
    expect(none.checked).toBe(false)
  })

  it('feature flag off (404) renders the managed-automatically note', async () => {
    mocks.getBookmarkFaviconSource.mockRejectedValue({
      status: 404, code: 'resource_not_found', recoveryHint: 'Not found',
    })
    mountTree(<FaviconSourceControl collectionId="col-1" nodeId="node-1" disabled={false} />)
    await act(async () => { await Promise.resolve() })

    expect(document.querySelector('[data-testid="favicon-source-unavailable"]')).not.toBeNull()
    expect(document.querySelector('input[type="radio"]')).toBeNull()
  })

  it('stale ETag (412) refreshes the source before the next choice', async () => {
    /* Stateful endpoint: the PUT loses the If-Match race, so it rejects with 412
       and the source the NEXT read sees is the other writer's revision. */
    let current = source()
    mocks.getBookmarkFaviconSource.mockImplementation(async () => current)
    mocks.setBookmarkFaviconSource.mockImplementation(async () => {
      current = source({ revision: '2', sourceMode: 'inherit', etag: '"favicon-source:res-1:2"' })
      throw {
        status: 412, code: 'precondition_failed', isPreconditionFailed: true,
        recoveryHint: 'Changed elsewhere — refreshed.',
      }
    })

    mountTree(<FaviconSourceControl collectionId="col-1" nodeId="node-1" disabled={false} />)
    await act(async () => { await Promise.resolve() })
    const loadsAfterMount = mocks.getBookmarkFaviconSource.mock.calls.length
    const none = document.querySelector<HTMLInputElement>('input[value="none"]')!
    await act(async () => { none.click() })

    // The 412 handler re-read the source exactly once (no refetch loop). The
    // mount count is React's (StrictMode mounts the effect twice by design), so
    // the guarantee is asserted relative to it.
    expect(mocks.getBookmarkFaviconSource).toHaveBeenCalledTimes(loadsAfterMount + 1)
    expect(document.querySelector('[role="alert"]')).not.toBeNull()
  })

  it('FO-02: choosing online PUTs sourceMode=online and the private directUrl preview renders', async () => {
    /* Stateful endpoint: choosing online revises the source, so the re-read
       after the PUT (on either StrictMode mount) sees the online mode. */
    let current = source()
    mocks.getBookmarkFaviconSource.mockImplementation(async () => current)
    mocks.setBookmarkFaviconSource.mockImplementation(
      async (_collectionId: string, _nodeId: string, patch: { sourceMode: string }) => {
        current = source({
          revision: '2', sourceMode: patch.sourceMode, effectiveMode: patch.sourceMode,
          directUrl: 'https://favicone.com/example.org', etag: '"favicon-source:res-1:2"',
        })
        return current
      },
    )

    mountTree(<FaviconSourceControl collectionId="col-1" nodeId="node-1" disabled={false} />)
    await act(async () => { await Promise.resolve() })
    const online = document.querySelector<HTMLInputElement>('input[value="online"]')!
    expect(online).not.toBeNull()
    await act(async () => { online.click() })

    expect(mocks.setBookmarkFaviconSource).toHaveBeenCalledWith(
      'col-1', 'node-1', { sourceMode: 'online' }, '"favicon-source:res-1:1"',
      expect.objectContaining({ intentId: 'set-favicon-source:col-1:node-1:command-src' }),
    )
    const preview = document.querySelector<HTMLImageElement>('[data-testid="favicon-source-preview"]')
    expect(preview?.getAttribute('src')).toBe('https://favicone.com/example.org')
  })

  it('FO-02: shared online renders the pinned object URL, never the directUrl', async () => {
    mocks.getBookmarkFaviconSource.mockResolvedValue(source({
      revision: '2', sourceMode: 'online', effectiveMode: 'online',
      iconUrl: 'https://app.example.test/api/v1/favicon/123e4567-e89b-42d3-a456-426614174000',
      iconVersion: '123e4567-e89b-42d3-a456-426614174000',
      directUrl: null, status: 'ready',
    }))
    mountTree(<FaviconSourceControl collectionId="col-1" nodeId="node-1" disabled={false} />)
    await act(async () => { await Promise.resolve() })
    const preview = document.querySelector<HTMLImageElement>('[data-testid="favicon-source-preview"]')
    expect(preview?.getAttribute('src')).toBe(
      'https://app.example.test/api/v1/favicon/123e4567-e89b-42d3-a456-426614174000',
    )
  })

  it('FO-03: refresh POSTs favicon-refresh and polls the DURABLE job via getMyFaviconJob until terminal', async () => {
    vi.useFakeTimers()
    /* Stateful endpoint: the source starts 'missing' and turns into the pinned
       object only once the refresh job reaches its terminal status. */
    let current = source({
      revision: '2', sourceMode: 'online', effectiveMode: 'online',
      directUrl: 'https://favicone.com/example.org', status: 'missing',
      etag: '"favicon-source:res-1:2"',
    })
    mocks.getBookmarkFaviconSource.mockImplementation(async () => current)
    let polls = 0
    mocks.getMyFaviconJob.mockImplementation(async () => {
      polls += 1
      // First poll after 2s: still running → poll again after 5s.
      if (polls === 1) {
        return { status: 'running' as const, succeeded: 0, total: 1, failed: 0, skipped: 0 }
      }
      // Second poll after 5s: terminal succeeded → the view reloads the source.
      current = source({
        revision: '3', sourceMode: 'online', effectiveMode: 'online', status: 'ready',
        iconUrl: 'https://app.example.test/api/v1/favicon/123e4567-e89b-42d3-a456-426614174000',
        iconVersion: '123e4567-e89b-42d3-a456-426614174000',
        etag: '"favicon-source:res-1:3"',
      })
      return { status: 'succeeded' as const, succeeded: 1, total: 1, failed: 0, skipped: 0 }
    })
    mocks.refreshBookmarkFavicon.mockResolvedValue({
      jobId: '123e4567-e89b-42d3-a456-426614174001',
    })

    mountTree(<FaviconSourceControl collectionId="col-1" nodeId="node-1" disabled={false} />)
    await act(async () => { await Promise.resolve() })
    const loadsAfterMount = mocks.getBookmarkFaviconSource.mock.calls.length
    const refresh = document.querySelector<HTMLButtonElement>('[data-testid="favicon-source-refresh"]')!
    expect(refresh).not.toBeNull()

    await act(async () => { refresh.click() })
    expect(mocks.refreshBookmarkFavicon).toHaveBeenCalledWith(
      'col-1', 'node-1', '"favicon-source:res-1:2"',
      expect.objectContaining({ intentId: 'refresh-favicon-source:col-1:node-1:command-src' }),
    )
    // First poll fires 2s later; still running → scheduled again.
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    expect(mocks.getMyFaviconJob).toHaveBeenCalledTimes(1)
    expect(mocks.getMyFaviconJob).toHaveBeenCalledWith(
      '123e4567-e89b-42d3-a456-426614174001', expect.objectContaining({ maxRetries: 0 }),
    )
    // Second poll 5s later arrives at terminal succeeded, reloads the view.
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(mocks.getMyFaviconJob).toHaveBeenCalledTimes(2)
    // Exactly one view reload after the terminal poll (no reload loop).
    expect(mocks.getBookmarkFaviconSource).toHaveBeenCalledTimes(loadsAfterMount + 1)
    const preview = document.querySelector<HTMLImageElement>('[data-testid="favicon-source-preview"]')
    expect(preview?.getAttribute('src')).toBe(
      'https://app.example.test/api/v1/favicon/123e4567-e89b-42d3-a456-426614174000',
    )
    // No further polls after the terminal status.
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(mocks.getMyFaviconJob).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('closing the inspector stops the refresh poll', async () => {
    vi.useFakeTimers()
    /* The poll loop is not covered by the fetch abort: cleanup clears the wait
       that is pending AT THAT MOMENT, and a poll already in flight resolves into
       `continue`, which installs a fresh timer and keeps polling a view that is
       gone. The loop's condition is the generation, so the cleanup has to bump it
       (and drop `refreshing`) — otherwise closing the inspector mid-refresh polls
       the server until the job reaches a terminal status. */
    const current = source({ revision: '2', sourceMode: 'online', effectiveMode: 'online',
      status: 'missing', etag: '"favicon-source:res-1:2"' })
    mocks.getBookmarkFaviconSource.mockImplementation(async () => current)
    let releasePoll!: (value: unknown) => void
    mocks.getMyFaviconJob.mockImplementation(() => new Promise((resolve) => { releasePoll = resolve }))
    mocks.refreshBookmarkFavicon.mockResolvedValue({
      jobId: '123e4567-e89b-42d3-a456-426614174001',
    })

    mountTree(<FaviconSourceControl collectionId="col-1" nodeId="node-1" disabled={false} />)
    await act(async () => { await Promise.resolve() })
    const refresh = document.querySelector<HTMLButtonElement>('[data-testid="favicon-source-refresh"]')!
    await act(async () => { refresh.click() })
    // The first poll fires 2s later and stays in flight while the view closes.
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    expect(mocks.getMyFaviconJob).toHaveBeenCalledTimes(1)

    cleanup()
    await act(async () => {
      releasePoll({ status: 'running' as const, succeeded: 0, total: 1, failed: 0, skipped: 0 })
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(mocks.getMyFaviconJob).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('FO-03: a failed refresh job stops polling and shows the last-icon notice', async () => {
    vi.useFakeTimers()
    /* Stateful endpoint: the refresh job fails, so the re-read after the failed
       poll reports `status: 'failed'` while still serving the last pinned icon. */
    let current = source({
      revision: '2', sourceMode: 'online', effectiveMode: 'online',
      iconUrl: 'https://app.example.test/api/v1/favicon/123e4567-e89b-42d3-a456-426614174000',
      status: 'ready', etag: '"favicon-source:res-1:2"',
    })
    mocks.getBookmarkFaviconSource.mockImplementation(async () => current)
    mocks.getMyFaviconJob.mockImplementation(async () => {
      current = source({
        revision: '2', sourceMode: 'online', effectiveMode: 'online',
        iconUrl: 'https://app.example.test/api/v1/favicon/123e4567-e89b-42d3-a456-426614174000',
        status: 'failed', etag: '"favicon-source:res-1:2"',
      })
      return {
        status: 'failed' as const, succeeded: 0, total: 1, failed: 1, skipped: 0,
        errors: [{ nodeId: 'node-1', reason: 'fetch_failed' }],
      }
    })
    mocks.refreshBookmarkFavicon.mockResolvedValue({
      jobId: '123e4567-e89b-42d3-a456-426614174002',
    })

    mountTree(<FaviconSourceControl collectionId="col-1" nodeId="node-1" disabled={false} />)
    await act(async () => { await Promise.resolve() })
    const refresh = document.querySelector<HTMLButtonElement>('[data-testid="favicon-source-refresh"]')!
    await act(async () => { refresh.click() })
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })

    expect(mocks.getMyFaviconJob).toHaveBeenCalledTimes(1)
    const notice = document.querySelector('[role="alert"]')
    expect(notice?.textContent).toContain('showing the last icon')
    expect(document.querySelector('[data-testid="favicon-source-preview"]')?.getAttribute('src')).toBe(
      'https://app.example.test/api/v1/favicon/123e4567-e89b-42d3-a456-426614174000',
    )
    vi.useRealTimers()
  })

  it('FO-02: non-online sources never show a refresh button', async () => {
    mocks.getBookmarkFaviconSource.mockResolvedValue(source({
      revision: '2', sourceMode: 'inherit', effectiveMode: 'capture', status: 'missing',
    }))
    mountTree(<FaviconSourceControl collectionId="col-1" nodeId="node-1" disabled={false} />)
    await act(async () => { await Promise.resolve() })
    // The control really rendered its (non-online) source: the absence below is
    // an absence of the refresh affordance, not of the whole control.
    expect(document.querySelector('input[value="inherit"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="favicon-source-refresh"]')).toBeNull()
  })

  it('F2: a bumped refreshKey refetches the source and shows the uploaded state', async () => {
    /* Stateful endpoint: the first inspector render reads the inherited source;
       the test then simulates the sibling drop card's upload by revising the
       source before bumping the refresh key. */
    let current = source()
    mocks.getBookmarkFaviconSource.mockImplementation(async () => current)

    mountTree(<FaviconSourceControl collectionId="col-1" nodeId="node-1" disabled={false} refreshKey={1} />)
    await act(async () => { await Promise.resolve() })
    const loadsAfterMount = mocks.getBookmarkFaviconSource.mock.calls.length
    expect(document.querySelector<HTMLInputElement>('input[value="inherit"]')?.checked).toBe(true)

    current = source({
      revision: '2', sourceMode: 'uploaded', effectiveMode: 'uploaded', status: 'ready',
      iconUrl: 'https://app.example.test/api/v1/favicon/123e4567-e89b-42d3-a456-426614174000',
      iconVersion: '123e4567-e89b-42d3-a456-426614174000',
      etag: '"favicon-source:res-1:2"',
    })
    // The same inspector performed an upload — re-render with a bumped key.
    mountTree(<FaviconSourceControl collectionId="col-1" nodeId="node-1" disabled={false} refreshKey={2} />)
    await act(async () => { await Promise.resolve() })

    // A bumped refresh key refetches exactly once (no refetch loop); the mount
    // count is React's, StrictMode renders it twice by design.
    expect(mocks.getBookmarkFaviconSource).toHaveBeenCalledTimes(loadsAfterMount + 1)
    expect(document.querySelector('[data-testid="favicon-source-uploaded"]')).not.toBeNull()
    // The stale radios are gone: inherit is no longer checked, the uploaded
    // state is locked (no uploaded radio exists to act on).
    expect(document.querySelector<HTMLInputElement>('input[value="inherit"]')?.checked).toBe(false)
    expect(document.querySelector('input[value="uploaded"]')).toBeNull()
  })

  it('F7: a failing preview image falls back to the placeholder and sends no referrer', async () => {
    mocks.getBookmarkFaviconSource.mockResolvedValue(source({
      revision: '2', sourceMode: 'online', effectiveMode: 'online',
      directUrl: 'https://favicone.com/example.org', etag: '"favicon-source:res-1:2"',
    }))
    mountTree(<FaviconSourceControl collectionId="col-1" nodeId="node-1" disabled={false} />)
    await act(async () => { await Promise.resolve() })

    const preview = document.querySelector<HTMLImageElement>('[data-testid="favicon-source-preview"]')!
    expect(preview).not.toBeNull()
    expect(preview.getAttribute('referrerpolicy')).toBe('no-referrer')

    await act(async () => { preview.dispatchEvent(new Event('error')) })
    expect(document.querySelector('[data-testid="favicon-source-preview"]')).toBeNull()
    const fallback = document.querySelector('[data-testid="favicon-source-preview-fallback"]')
    expect(fallback).not.toBeNull()
    expect(fallback?.textContent).toContain('Icon preview unavailable')
  })
})
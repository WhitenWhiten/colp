// @vitest-environment happy-dom
import { act, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, mountTree } from '../../test/render'
import { FaviconJobProgress } from './FaviconJobProgress'

const mocks = vi.hoisted(() => ({ activity: vi.fn(), get: vi.fn(), retry: vi.fn() }))
vi.mock('../../api', () => ({
  productClient: {
    getMyFaviconJobActivity: mocks.activity,
    getMyFaviconJob: mocks.get,
    retryMyFaviconJob: mocks.retry,
    mutationIntentKey: (scope: string, id: string) => `${scope}:${id}`,
    newCommandId: () => 'command-fav',
  },
  isProductApiError: (error: unknown) => !!error && typeof error === 'object' && 'status' in error,
}))

function job(overrides = {}) {
  return { id: 'job-existing', operation: 'fill_missing', status: 'running', policyRevision: '3',
    total: 100, succeeded: 7, failed: 2, skipped: 1, errors: [],
    createdAt: '2026-10-17T11:00:00.000Z', updatedAt: '2026-10-17T11:00:05.000Z', ...overrides }
}
function Harness() {
  const [startedJobId, setJobId] = useState<string | null>(null)
  return <FaviconJobProgress startedJobId={startedJobId} onJobStarted={setJobId} />
}
async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
}
function bar() { return document.querySelector<HTMLProgressElement>('progress') }

describe('Settings favicon task strip', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.activity.mockReset().mockResolvedValue({ activeJobs: 0, job: null })
    mocks.get.mockReset()
    mocks.retry.mockReset()
  })
  afterEach(() => { cleanup(); vi.useRealTimers() })

  it('discovers an existing task on open and restores it after the panel is reopened', async () => {
    mocks.activity.mockResolvedValue({ activeJobs: 1, job: job() })
    mountTree(<Harness />)
    await flush()
    expect(bar()?.max).toBe(100)
    expect(bar()?.value).toBe(10)
    expect(document.body.textContent).toContain('10/100 processed')
    expect(document.body.textContent).toContain('7 updated · 2 failed · 1 skipped')
    expect(document.body.textContent).toContain('10%')
    cleanup()
    mountTree(<Harness />)
    await flush()
    expect(bar()?.value).toBe(10)
  })

  it('keeps discovering work started elsewhere while Settings stays open', async () => {
    mountTree(<Harness />)
    await flush()
    expect(bar()).toBeNull()
    mocks.activity.mockResolvedValue({ activeJobs: 1, job: job() })
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(bar()?.value).toBe(10)
  })

  it('shows individual refreshes without inventing a percentage for the queue', async () => {
    mocks.activity.mockResolvedValue({ activeJobs: 4, job: job({ operation: 'refresh_one', total: 1, succeeded: 0, failed: 0, skipped: 0 }) })
    mountTree(<Harness />)
    await flush()
    expect(bar()?.hasAttribute('value')).toBe(false)
    expect(document.body.textContent).toContain('4 tasks remaining')
    expect(document.body.textContent).not.toContain('%')
  })

  it('preserves the last count after a transient error and automatically recovers', async () => {
    mocks.activity.mockResolvedValue({ activeJobs: 1, job: job() })
    mountTree(<Harness />)
    await flush()
    mocks.activity.mockRejectedValue({ status: 503 })
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(bar()?.value).toBe(10)
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Retrying')
    mocks.activity.mockResolvedValue({ activeJobs: 1, job: job({ succeeded: 20 }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(bar()?.value).toBe(23)
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })

  it('reads the finished job and retries only its failed items', async () => {
    mocks.activity.mockResolvedValue({ activeJobs: 1, job: job() })
    mocks.get.mockResolvedValue(job({ status: 'partial', succeeded: 97, failed: 2, skipped: 1 }))
    mountTree(<Harness />)
    await flush()
    mocks.activity.mockResolvedValue({ activeJobs: 0, job: null })
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(bar()?.value).toBe(100)
    mocks.retry.mockResolvedValue({ jobId: 'job-retry' })
    mocks.activity.mockResolvedValue({ activeJobs: 1, job: job({ id: 'job-retry', total: 2, succeeded: 0, failed: 0, skipped: 0 }) })
    const retry = document.querySelector<HTMLButtonElement>('[data-testid="favicon-job-retry"]')!
    await act(async () => { retry.click() })
    await flush()
    expect(mocks.retry).toHaveBeenCalledWith('job-existing', expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(bar()?.max).toBe(2)
    expect(bar()?.value).toBe(0)
  })

  it('aborts polling on close and clears progress if the session expires', async () => {
    mocks.activity.mockResolvedValue({ activeJobs: 1, job: job() })
    mountTree(<Harness />)
    await flush()
    mocks.activity.mockRejectedValue({ status: 401 })
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(bar()).toBeNull()
    const count = mocks.activity.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(mocks.activity).toHaveBeenCalledTimes(count)
    const signal = mocks.activity.mock.calls.at(-1)![0].signal as AbortSignal
    cleanup()
    expect(signal.aborted).toBe(true)
  })
})

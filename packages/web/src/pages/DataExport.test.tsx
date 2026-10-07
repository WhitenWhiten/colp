// @vitest-environment happy-dom
/* Data-export surface boundary.
 *
 * Behaviour — the export page driven with the Product client mocked: the
 * exposure gate, the 404-means-unavailable path, breadcrumbs, create/poll
 * cadence on the real 2000ms interval, the download blob and filename, format
 * availability, and the expired/failed rows. Nothing here reads source text.
 *
 * Architecture — absences a render cannot reach: the module must reach the API
 * through the barrel (never a deep client/transport import), and the retired
 * demo seed, demo toast and mock lede must not come back in any branch. The
 * old suite's `setTimeout` ban became a behaviour probe instead: advancing the
 * clock is what would expose fabricated progress.
 */
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductApiError, type ExportJob } from '../api'
import { ExportWorkerStub } from '../test/exportWorker'
import { DataExport } from './DataExport'
import dataExportSource from './DataExport.tsx?raw'
import { clearRouteCache } from '../lib/routeCache'
import { cleanup, domFinishedLoading, findButtonByName, mountTree, waitForDom } from '../test/render'

const mocks = vi.hoisted(() => ({
  enabled: true,
  listMyExportJobs: vi.fn(),
  createMyExportJob: vi.fn(),
  getMyExportJob: vi.fn(),
  downloadMyExportJob: vi.fn(),
  toast: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    isExportJobsExposureEnabled: () => mocks.enabled,
    productClient: {
      ...actual.productClient,
      listMyExportJobs: mocks.listMyExportJobs,
      createMyExportJob: mocks.createMyExportJob,
      getMyExportJob: mocks.getMyExportJob,
      downloadMyExportJob: mocks.downloadMyExportJob,
    },
  }
})

vi.mock('../components/AppToast', () => ({
  useToast: () => ({ toast: mocks.toast, success: mocks.success, error: mocks.error }),
}))

function job(overrides: Partial<ExportJob> = {}): ExportJob {
  return {
    jobId: 'job-1',
    status: 'ready',
    createdAt: '2026-08-23T00:00:00.000Z',
    ...overrides,
  }
}

function createButtons() {
  return [...document.querySelectorAll<HTMLButtonElement>('button')]
    .filter((node) => node.textContent?.trim() === 'Create export')
}

function formatButton(name: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    .find((node) => node.querySelector('strong')?.textContent === name)
  if (!button) throw new Error(`missing format ${name}`)
  return button
}

describe('DataExport Product wiring', () => {

  function render() {
    mountTree(
        <MemoryRouter>
          <DataExport />
        </MemoryRouter>,
      )
  }

  beforeEach(() => {
    clearRouteCache()
    vi.stubGlobal('Worker', ExportWorkerStub)
    vi.clearAllMocks()
    mocks.enabled = true
    mocks.listMyExportJobs.mockResolvedValue({ items: [] })
    mocks.createMyExportJob.mockResolvedValue(job({ status: 'pending' }))
    mocks.getMyExportJob.mockResolvedValue(job())
    mocks.downloadMyExportJob.mockResolvedValue({ exportedAt: '2026-08-23T00:00:00.000Z', collections: [] })
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    cleanup()
    clearRouteCache()
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  describe('export jobs behaviour', () => {
    it('keeps flag-off inert and does not call Product methods', async () => {
      mocks.enabled = false
      render()
      await waitForDom(domFinishedLoading)
      expect(document.querySelector('[data-testid="export-jobs-flag-off"]')).not.toBeNull()
      expect(document.body.textContent).toContain('Library export is not available yet')
      expect(document.body.textContent).toContain('It will appear here when it is ready.')
      expect(document.body.textContent).not.toContain('This workspace has not enabled')
      expect(document.querySelector('[aria-label="Breadcrumb"] a')?.getAttribute('href')).toBe('/library')
      expect(document.querySelector('h1')?.textContent).toBe('Export your library')
      expect(mocks.listMyExportJobs).not.toHaveBeenCalled()
      expect(mocks.createMyExportJob).not.toHaveBeenCalled()
      expect(mocks.getMyExportJob).not.toHaveBeenCalled()
      expect(mocks.downloadMyExportJob).not.toHaveBeenCalled()
    })

    it('shows the same empty state when list returns 404 resource_not_found', async () => {
      // Both of StrictMode's mount effects issue the request; a one-shot rejection
      // would let the second land a success over the flag-off state under test.
      mocks.listMyExportJobs.mockRejectedValue(
        new ProductApiError({ status: 404, code: 'resource_not_found', message: 'not found' }),
      )
      render()
      await waitForDom(domFinishedLoading)
      expect(document.querySelector('[data-testid="export-jobs-flag-off"]')).not.toBeNull()
      expect(document.body.textContent).toContain('Library export is not available yet')
      expect(document.body.textContent).toContain('It will appear here when it is ready.')
      expect(mocks.listMyExportJobs.mock.calls.length).toBeGreaterThanOrEqual(1)
      expect(mocks.createMyExportJob).not.toHaveBeenCalled()
    })

    it('breadcrumbs back to Library rather than Settings', async () => {
      render()
      await waitForDom(domFinishedLoading)
      const crumb = document.querySelector<HTMLAnchorElement>('[aria-label="Breadcrumb"] a')
      expect(crumb?.textContent).toBe('Library')
      expect(crumb?.getAttribute('href')).toBe('/library')
      expect(document.querySelector('a[href="/settings"]')).toBeNull()
    })

    it('shows live empty history with Create still enabled', async () => {
      render()
      await waitForDom(domFinishedLoading)
      expect(document.querySelector('[data-testid="export-jobs-flag-off"]')).toBeNull()
      expect(document.querySelector('[data-testid="export-history"]')).not.toBeNull()
      expect(document.querySelectorAll('[data-testid="export-history"] article')).toHaveLength(0)
      const buttons = createButtons()
      expect(buttons.length).toBeGreaterThan(0)
      expect(buttons.every((button) => !button.disabled)).toBe(true)
    })

    it('posts createMyExportJob with maxRetries 0', async () => {
      render()
      await waitForDom(domFinishedLoading)
      act(() => createButtons()[0]!.click())
      await waitForDom(domFinishedLoading)
      expect(mocks.createMyExportJob).toHaveBeenCalledWith(
        expect.objectContaining({ intentId: 'create-export-job', maxRetries: 0 }),
      )
    })

    it('shows Queued for pending jobs and polls the list after 2000ms', async () => {
      vi.useFakeTimers()
      mocks.listMyExportJobs.mockResolvedValue({ items: [job({ status: 'pending' })] })
      render()
      await waitForDom(domFinishedLoading)
      expect(document.body.textContent).toContain('Queued')
      // StrictMode issues the mount request twice. What this test is about is the
      // POLL: exactly one more request per 2000ms tick.
      const afterMount = mocks.listMyExportJobs.mock.calls.length
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000)
      })
      expect(mocks.listMyExportJobs.mock.calls.length).toBe(afterMount + 1)
    })

    it('does not abort or overlap a poll that takes longer than the polling interval', async () => {
      vi.useFakeTimers()
      mocks.listMyExportJobs.mockResolvedValue({ items: [job({ status: 'running' })] })
      render()
      await waitForDom(domFinishedLoading)
      let finish!: (value: { items: ExportJob[] }) => void
      mocks.listMyExportJobs.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      const before = mocks.listMyExportJobs.mock.calls.length
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
      expect(mocks.listMyExportJobs.mock.calls.length).toBe(before + 1)
      expect(mocks.listMyExportJobs.mock.lastCall?.[0].signal.aborted).toBe(false)
      await act(async () => finish({ items: [job()] }))
      expect(document.body.textContent).toContain('Ready')
    })

    it('never fabricates progress or a ready export while the clock advances', async () => {
      vi.useFakeTimers()
      mocks.listMyExportJobs.mockResolvedValue({ items: [job({ status: 'running' })] })
      render()
      await waitForDom(domFinishedLoading)
      expect(document.body.textContent).toContain('Preparing export')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000)
      })
      /* Time may only re-ask the server. The retired surface faked progress on
         a timer until the row offered a download; after 15 polls the status is
         still whatever the server reported and no Download exists. */
      expect(document.body.textContent).toContain('Preparing export')
      expect(document.body.textContent).not.toContain('Ready')
      expect([...document.querySelectorAll('[data-testid="export-history"] article button')]).toEqual([])
    })

    it('downloads ready jobs via downloadMyExportJob and a credentialed blob URL', async () => {
      mocks.listMyExportJobs.mockResolvedValue({ items: [job({ jobId: 'job-1', status: 'ready' })] })
      const createObjectURL = vi.fn(() => 'blob:known-library')
      const revokeObjectURL = vi.fn()
      vi.spyOn(URL, 'createObjectURL').mockImplementation(createObjectURL)
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revokeObjectURL)
      const click = vi.fn()
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
        click(this.download, this.href)
      })
      render()
      await waitForDom(domFinishedLoading)
      const download = [...document.querySelectorAll<HTMLButtonElement>('button')]
        .find((node) => node.textContent?.trim() === 'Download')
      expect(download).toBeTruthy()
      await act(async () => {
        download!.click()
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(mocks.downloadMyExportJob).toHaveBeenCalledWith('job-1', { signal: expect.any(AbortSignal) })
      expect(createObjectURL).toHaveBeenCalled()
      /* The filename carries the server's job id, not a locally minted one. */
      expect(click).toHaveBeenCalledWith('known-library-job-1.json', expect.any(String))
      expect(revokeObjectURL).not.toHaveBeenCalled()
    })

    it('allows selecting Markdown and HTML, with JSON initially selected', async () => {
      render()
      await waitForDom(domFinishedLoading)
      expect(formatButton('JSON').getAttribute('aria-checked')).toBe('true')
      for (const format of ['Markdown', 'HTML']) {
        expect(formatButton(format).getAttribute('aria-disabled')).toBeNull()
        act(() => formatButton(format).click())
        expect(formatButton(format).getAttribute('aria-checked')).toBe('true')
      }
    })

    it.each(['Markdown', 'HTML'] as const)('downloads a ready job in selected %s format', async (format) => {
      mocks.listMyExportJobs.mockResolvedValue({ items: [job()] })
      const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:export')
      const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
      render()
      await waitForDom(domFinishedLoading)
      act(() => formatButton(format).click())
      await act(async () => findButtonByName('Download')!.click())
      expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe(`known-library-job-1.${format === 'HTML' ? 'html' : 'md'}`)
      const blob = createObjectURL.mock.calls[0]![0] as Blob
      expect(blob.type).toContain(format === 'HTML' ? 'text/html' : 'text/markdown')
    })

    it('automatically downloads a newly created export once, using its selected format', async () => {
      vi.useFakeTimers()
      vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:export')
      const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
      const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
      render()
      await waitForDom(domFinishedLoading)
      act(() => formatButton('Markdown').click())
      mocks.listMyExportJobs.mockResolvedValue({ items: [job({ status: 'running' })] })
      await act(async () => createButtons()[0]!.click())
      act(() => formatButton('HTML').click())
      mocks.listMyExportJobs.mockResolvedValue({ items: [job()] })
      await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
      expect(click).toHaveBeenCalledTimes(1)
      expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe('known-library-job-1.md')
      expect(revoke).not.toHaveBeenCalled()
      await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
      expect(click).toHaveBeenCalledTimes(1)
      expect(revoke).toHaveBeenCalledWith('blob:export')
    })

    it('does not offer Download for expired jobs', async () => {
      mocks.listMyExportJobs.mockResolvedValue({ items: [job({ status: 'expired' })] })
      render()
      await waitForDom(domFinishedLoading)
      expect(document.body.textContent).toContain('Expired')
      expect(
        [...document.querySelectorAll('[data-testid="export-history"] article button')].some(
          (node) => node.textContent?.trim() === 'Download',
        ),
      ).toBe(false)
    })

    it('does not offer Download for failed jobs and can show errorClass', async () => {
      mocks.listMyExportJobs.mockResolvedValue({
        items: [
          job({ status: 'failed', errorClass: 'internal' }),
          job({ jobId: 'job-too-big', status: 'failed', errorClass: 'over_capacity' }),
        ],
      })
      render()
      await waitForDom(domFinishedLoading)
      expect(document.body.textContent).toContain('Failed')
      expect(document.body.textContent).toContain('Failed: library too large to export')
      expect(document.body.textContent).not.toContain('(internal)')
      // Failures already on record at load stay in the archive list; no toast.
      expect(mocks.error).not.toHaveBeenCalled()
      expect(
        [...document.querySelectorAll('[data-testid="export-history"] article button')].some(
          (node) => node.textContent?.trim() === 'Download',
        ),
      ).toBe(false)
    })

    it('toasts on 409 command_in_progress and refreshes the list without a second POST', async () => {
      mocks.createMyExportJob.mockRejectedValueOnce(
        new ProductApiError({ status: 409, code: 'command_in_progress', message: 'busy' }),
      )
      render()
      await waitForDom(domFinishedLoading)
      act(() => createButtons()[0]!.click())
      await waitForDom(domFinishedLoading)
      expect(mocks.toast).toHaveBeenCalledWith('An export is already in progress')
      expect(mocks.createMyExportJob).toHaveBeenCalledTimes(1)
      expect(mocks.listMyExportJobs.mock.calls.length).toBeGreaterThan(1)
    })

    it('keeps polling a newly created job if the first refresh fails', async () => {
      vi.useFakeTimers()
      vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:export')
      const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
      render()
      await waitForDom(domFinishedLoading)
      mocks.listMyExportJobs.mockRejectedValueOnce(new Error('temporary outage'))
      await act(async () => createButtons()[0]!.click())
      expect(document.body.textContent).toContain('Queued')
      expect(createButtons()[0]!.disabled).toBe(true)
      expect(mocks.error).toHaveBeenCalledWith("Couldn't refresh your exports. Try again.")
      mocks.listMyExportJobs.mockResolvedValue({ items: [job()] })
      await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
      expect(click).toHaveBeenCalledTimes(1)
    })

    it('shows creation failures inline with a persistent retry action', async () => {
      mocks.createMyExportJob.mockRejectedValueOnce(new Error('network unavailable'))
      render()
      await waitForDom(domFinishedLoading)
      await act(async () => createButtons()[0]!.click())
      expect(mocks.error).not.toHaveBeenCalled()
      expect(document.querySelector('[role="alert"]')?.textContent).toContain("Couldn't create the export")
      expect(findButtonByName('Try again')).toBeTruthy()
    })

    it('toasts failed jobs once across repeated polling', async () => {
      vi.useFakeTimers()
      mocks.listMyExportJobs.mockResolvedValue({ items: [job({ status: 'running' })] })
      render()
      await waitForDom(domFinishedLoading)
      mocks.listMyExportJobs.mockResolvedValue({ items: [
        job({ status: 'failed', errorClass: 'internal' }),
        job({ jobId: 'job-2', status: 'pending' }),
      ] })
      await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
      expect(mocks.error).toHaveBeenCalledTimes(1)
      expect(mocks.error).toHaveBeenCalledWith('Your export failed. Please create a new export.')
    })

    it('toasts polling outages once, keeps the job visible, and recovers', async () => {
      vi.useFakeTimers()
      mocks.listMyExportJobs.mockResolvedValue({ items: [job({ status: 'running' })] })
      render()
      await waitForDom(domFinishedLoading)
      mocks.listMyExportJobs.mockRejectedValue(new Error('offline'))
      await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
      expect(mocks.error).toHaveBeenCalledTimes(1)
      expect(mocks.error).toHaveBeenCalledWith("Couldn't refresh your exports. Try again.")
      expect(document.body.textContent).toContain('Preparing export')
      mocks.listMyExportJobs.mockResolvedValue({ items: [job({ status: 'running' })] })
      await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
      mocks.listMyExportJobs.mockRejectedValue(new Error('offline again'))
      await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
      expect(mocks.error).toHaveBeenCalledTimes(2)
    })

    it('toasts initial list failures', async () => {
      mocks.listMyExportJobs.mockRejectedValue(new Error('offline'))
      render()
      await waitForDom(domFinishedLoading)
      expect(mocks.error).toHaveBeenCalledWith("Couldn't refresh your exports. Try again.")
      expect(document.body.textContent).toContain("Couldn't load your exports")
    })

    it('waits for a manual download before starting the newly completed export', async () => {
      vi.useFakeTimers()
      mocks.listMyExportJobs.mockResolvedValue({ items: [job({ jobId: 'old-job' })] })
      vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:export')
      const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
      render()
      await waitForDom(domFinishedLoading)
      mocks.listMyExportJobs.mockResolvedValue({ items: [job({ status: 'pending' }), job({ jobId: 'old-job' })] })
      await act(async () => createButtons()[0]!.click())
      let finish!: (value: unknown) => void
      mocks.downloadMyExportJob.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      act(() => findButtonByName('Download')!.click())
      mocks.listMyExportJobs.mockResolvedValue({ items: [job(), job({ jobId: 'old-job' })] })
      await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
      expect(mocks.downloadMyExportJob).toHaveBeenCalledTimes(1)
      await act(async () => finish({ exportedAt: '2026-09-20T00:00:00.000Z', collections: [] }))
      expect(mocks.downloadMyExportJob).toHaveBeenCalledTimes(2)
      expect(click).toHaveBeenCalledTimes(2)
    })

    it('allows only one outstanding download and cancels it when leaving the page', async () => {
      mocks.listMyExportJobs.mockResolvedValue({ items: [job()] })
      let finish!: (value: unknown) => void
      mocks.downloadMyExportJob.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      const createObjectURL = vi.spyOn(URL, 'createObjectURL')
      render()
      await waitForDom(domFinishedLoading)
      act(() => {
        findButtonByName('Download')!.click()
        findButtonByName('Download')!.click()
      })
      expect(mocks.downloadMyExportJob).toHaveBeenCalledTimes(1)
      expect(findButtonByName('Download')!.disabled).toBe(true)
      const signal = mocks.downloadMyExportJob.mock.lastCall?.[1].signal as AbortSignal
      cleanup()
      expect(signal.aborted).toBe(true)
      await act(async () => finish({ exportedAt: '2026-09-20T00:00:00.000Z', collections: [] }))
      expect(createObjectURL).not.toHaveBeenCalled()
      expect(mocks.error).not.toHaveBeenCalled()
    })

    it('toasts download failures and keeps the manual retry available', async () => {
      mocks.listMyExportJobs.mockResolvedValue({ items: [job()] })
      mocks.downloadMyExportJob.mockRejectedValueOnce(new Error('R2 unavailable'))
      render()
      await waitForDom(domFinishedLoading)
      await act(async () => findButtonByName('Download')!.click())
      expect(mocks.error).toHaveBeenCalledWith('Could not download this export. Try Download again.')
      expect(findButtonByName('Download')).toBeTruthy()
    })

    it('renders no mock or demo copy and never toasts a demo download', async () => {
      render()
      await waitForDom(domFinishedLoading)
      expect(document.body.textContent?.toLowerCase()).not.toContain('mock')
      expect(mocks.toast).not.toHaveBeenCalledWith(expect.stringMatching(/download started \(demo\)/i))
      /* The lede is the accepted portability copy, not a placeholder. */
      expect(document.querySelector('h1')?.textContent).toBe('Export your library')
    })
  })

  describe('architecture invariants that cannot be behaviour tested', () => {
    it('keeps the page on the public api barrel with no demo seed or fake ids', () => {
      /* An unused deep import changes no observable behaviour, and a demo seed
         that no branch renders would still ship — so these absences are
         asserted on module specifiers, symbols and literals rather than on a
         formatted import line. The reachable halves (rendered "mock" copy, the
         demo toast, the download filename) are observed above. */
      expect(dataExportSource).toMatch(/from ['"]\.\.\/api['"]/u)
      expect(dataExportSource).not.toMatch(
        /from ['"]\.\.\/api\/(?:productClient|product-client|product-transport|types|mock-data)['"]/u,
      )
      expect(dataExportSource).not.toContain('exportHistorySeed')
      expect(dataExportSource).not.toContain('download started (demo)')
      expect(dataExportSource).not.toMatch(/this screen is a mock/i)
      /* No locally minted export ids: the job id is the transport's. */
      expect(dataExportSource).not.toMatch(/export-\$\{Date\.now\(\)\}/u)
    })
  })
})

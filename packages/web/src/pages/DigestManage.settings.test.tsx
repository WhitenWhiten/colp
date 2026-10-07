// @vitest-environment happy-dom
/**
 * Settings, schedule and address tests for the digest manage page, split out
 * of DigestManage.test.tsx to keep each suite under the 600-line test gate.
 */
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReportSeries } from '../api/types'
import { canonicalSiteOrigin } from '../lib/chrome'
import { reportSeriesPath } from '../lib/reports'
import { cleanup, domFinishedLoading, findButtonByName, waitForDom } from '../test/render'
import {
  clickTab,
  confirmDialog,
  fieldHint,
  linkByText,
  mocks,
  renderDigestManage,
  series,
  setInput,
  setSelect,
  setUpDigestManage,
  state,
  tearDownDigestManage,
} from './DigestManage.test-helper'

vi.mock('../auth/AuthContext', async () => {
  const { mocks: authMocks } = await import('./DigestManage.test-mocks')
  return { useAuth: () => authMocks.auth }
})
vi.mock('../components/AppToast', async () => {
  const { mocks: toastMocks } = await import('./DigestManage.test-mocks')
  return { useToast: () => ({ toast: toastMocks.toast, success: toastMocks.success, error: toastMocks.error }) }
})
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  const { productClientMocks } = await import('./DigestManage.test-mocks')
  return { ...actual, productClient: { ...actual.productClient, ...productClientMocks() } }
})

describe('DigestManage settings', () => {
  beforeEach(setUpDigestManage)
  afterEach(tearDownDigestManage)

  const render = renderDigestManage

  it('saves settings with the series resource revision in If-Match', async () => {
    let releaseSave = () => {}
    const gate = new Promise<void>((resolve) => { releaseSave = resolve })
    mocks.patchReport.mockImplementation(async (_id: string, patch: Record<string, unknown>) => {
      state.series = { ...state.series, ...(patch as Partial<ReportSeries>) }
      await gate
      return state.series
    })
    render()
    await waitForDom(domFinishedLoading)

    clickTab('Settings')
    await waitForDom(() => document.querySelector('[data-testid="digest-settings-form"]') !== null)
    setInput('ds-title', 'AI weekly renamed')
    const save = findButtonByName('Save settings')
    expect(save.disabled).toBe(false)
    act(() => {
      (document.querySelector('[data-testid="digest-settings-form"]') as HTMLFormElement)
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    await waitForDom(() => [...document.querySelectorAll('button')].some((button) => button.textContent === 'Saving…'))
    // The status bar stays hidden while the save is in flight; the button already says Saving….
    expect(document.querySelector('[data-testid="digest-op-bar"]')).toBeNull()
    await act(async () => { releaseSave() })
    await waitForDom(() => mocks.patchReport.mock.calls.length === 1)
    expect(mocks.patchReport).toHaveBeenCalledWith(
      'rep-1',
      expect.objectContaining({ title: 'AI weekly renamed' }),
      '"sr-1"',
      expect.objectContaining({ intentId: expect.any(String) }),
    )
    await waitForDom(() => mocks.success.mock.calls.some((call) => call[0] === 'Settings saved'))
    expect(document.querySelector('[data-testid="digest-op-bar"]')).toBeNull()
  })

  it('commits tags and language with Save settings instead of a second save button', async () => {
    mocks.updateReportCatalog.mockResolvedValue({ tags: [], language: 'en', revision: '2' })
    render()
    await waitForDom(domFinishedLoading)
    clickTab('Settings')
    await waitForDom(() => document.getElementById('report-catalog-language') !== null)
    expect([...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Save tags and language')).toBe(false)
    expect(findButtonByName('Save settings').disabled).toBe(true)
    setSelect('report-catalog-language', 'en')
    expect(findButtonByName('Save settings').disabled).toBe(false)
    act(() => {
      (document.querySelector('[data-testid="digest-settings-form"]') as HTMLFormElement)
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    await waitForDom(() => mocks.success.mock.calls.some((call) => call[0] === 'Settings saved'))
    expect(mocks.updateReportCatalog).toHaveBeenCalledWith('rep-1', { tags: [], language: 'en' }, '"1"', expect.objectContaining({ maxRetries: 0 }))
    // Only the catalog changed: no series PATCH, one toast.
    expect(mocks.patchReport).not.toHaveBeenCalled()
    expect(mocks.success).toHaveBeenCalledTimes(1)
  })

  it('confirms before saving public visibility from settings', async () => {
    mocks.patchReport.mockImplementation(async (_id: string, patch: Record<string, unknown>) => {
      state.series = { ...state.series, ...(patch as Partial<ReportSeries>) }
      return state.series
    })
    render()
    await waitForDom(domFinishedLoading)

    clickTab('Settings')
    await waitForDom(() => document.querySelector('[data-testid="digest-settings-form"]') !== null)
    setSelect('ds-visibility', 'public')
    // Confirm required — nothing sent yet.
    expect(mocks.patchReport).not.toHaveBeenCalled()
    act(() => {
      (document.querySelector('[data-testid="digest-settings-form"]') as HTMLFormElement)
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    await confirmDialog()
    await waitForDom(() => mocks.patchReport.mock.calls.length === 1)
    expect(mocks.patchReport).toHaveBeenCalledWith(
      'rep-1', { visibility: 'public' }, '"sr-1"', expect.objectContaining({ intentId: expect.any(String) }),
    )
  })

  it('asks before leaving unsaved digest settings', async () => {
    render()
    await waitForDom(domFinishedLoading)

    clickTab('Settings')
    await waitForDom(() => document.querySelector('[data-testid="digest-settings-form"]') !== null)
    setInput('ds-title', 'AI weekly renamed')
    expect(document.querySelector('[data-testid="digest-settings-form"]')?.textContent).toContain('Unsaved changes')

    const digests = [...document.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Breadcrumb"] a')]
      .find((anchor) => anchor.textContent?.trim() === 'Digests')
    expect(digests).toBeTruthy()
    act(() => { digests!.click() })
    await waitForDom(() => document.querySelector('[data-testid="modal-panel"]') !== null)
    const panel = document.querySelector('[data-testid="modal-panel"]')!
    expect(panel.textContent).toContain('Discard changes?')
    expect(panel.textContent).toContain('You have unsaved changes to this digest’s settings.')
    expect(document.querySelector('h1')?.textContent).toBe('AI weekly')
  })

  it('turns the schedule on and off from settings', async () => {
    mocks.putReportSchedule.mockImplementation(async () => {
      state.schedule = {
        id: 'sch-1', seriesId: 'rep-1', enabled: true, rrule: 'FREQ=WEEKLY',
        dtstart: '2026-09-14T00:00:00.000Z', timeZone: 'UTC', catchUpPolicy: 'skip',
        maxCatchUp: 0, nextRunAt: '2026-09-21T00:00:00.000Z', resourceRevision: 'sch-r1',
      }
      return state.schedule
    })
    render()
    await waitForDom(domFinishedLoading)
    clickTab('Settings')
    await waitForDom(() => document.getElementById('digest-schedule-freq') !== null)

    setSelect('digest-schedule-freq', 'WEEKLY')
    await waitForDom(() => mocks.putReportSchedule.mock.calls.length === 1)
    // No schedule existed → no If-Match header.
    expect(mocks.putReportSchedule).toHaveBeenCalledWith(
      'rep-1',
      expect.objectContaining({ rrule: 'FREQ=WEEKLY' }),
      undefined,
      expect.objectContaining({ intentId: expect.any(String) }),
    )
    await waitForDom(() => mocks.success.mock.calls.some((call) => call[0] === 'Schedule saved'))
    await waitForDom(() => document.body.textContent!.includes('next run'))

    mocks.deleteReportSchedule.mockImplementation(async () => { state.schedule = null })
    setSelect('digest-schedule-freq', 'off')
    await confirmDialog()
    await waitForDom(() => mocks.deleteReportSchedule.mock.calls.length === 1)
    expect(mocks.deleteReportSchedule).toHaveBeenCalledWith(
      'rep-1', '"sch-r1"', expect.objectContaining({ intentId: expect.any(String) }),
    )
    await waitForDom(() => mocks.success.mock.calls.some((call) => call[0] === 'Schedule turned off'))
  })

  it('explains a private digest and does not offer View public', async () => {
    render()
    await waitForDom(domFinishedLoading)

    expect(linkByText('View public')).toBeUndefined()
    const copy = findButtonByName('Copy link')
    expect(copy.classList.contains('btn-ghost')).toBe(true)
    expect(copy.classList.contains('btn-sm')).toBe(true)
    const address = [...(copy.parentElement?.children ?? [])].find((node) => node.tagName === 'SPAN')
    expect(address?.textContent).toBe('/reports/ai-weekly')
    expect(copy.parentElement?.querySelector('code')).toBeNull()
    // Visibility has one control: the Settings form select. The head only
    // shows the status badge.
    expect([...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Change visibility')).toBe(false)

    clickTab('Settings')
    await waitForDom(() => document.getElementById('ds-visibility') !== null)
    expect(fieldHint('ds-visibility')).toBe('Only you and collaborators can open it.')
    const indexing = document.getElementById('ds-indexing') as HTMLInputElement
    expect(indexing.disabled).toBe(true)
    expect(indexing.checked).toBe(false)
    expect(fieldHint('ds-indexing')).toBe('Available when visibility is Public.')
    expect(fieldHint('digest-schedule-freq')).toBe('Off. You publish issues yourself.')
    expect(document.body.textContent).not.toContain('On each scheduled run')
    expect(document.body.textContent).not.toContain('published by hand')

    setSelect('ds-visibility', 'unlisted')
    expect(fieldHint('ds-visibility')).toBe("Anyone with the link can open it. It isn't listed in the directory.")
    expect((document.getElementById('ds-indexing') as HTMLInputElement).disabled).toBe(true)
    // The header follows the saved visibility, not the unsaved select.
    expect(linkByText('View public')).toBeUndefined()

    setSelect('ds-visibility', 'public')
    expect(fieldHint('ds-visibility')).toBe('Listed in the digest directory. Anyone can open and follow it.')
    expect((document.getElementById('ds-indexing') as HTMLInputElement).disabled).toBe(false)
    expect(fieldHint('ds-indexing')).toBe('Lets search engines index the public pages.')
  })

  it('offers View public only for public and unlisted digests', async () => {
    for (const visibility of ['private', 'protected'] as const) {
      state.series = series({ visibility })
      render()
      await waitForDom(domFinishedLoading)
      expect(linkByText('View public')).toBeUndefined()
      expect(document.body.textContent).toContain('/reports/ai-weekly')
      cleanup()
      window.__KNOWN_FLAGS__ = { reports: true }
    }
    for (const visibility of ['public', 'unlisted'] as const) {
      state.series = series({ visibility })
      render()
      await waitForDom(domFinishedLoading)
      const link = linkByText('View public')
      expect(link?.getAttribute('href')).toBe('/reports/ai-weekly')
      expect(link?.classList.contains('btn')).toBe(true)
      expect(link?.classList.contains('btn-secondary')).toBe(true)
      cleanup()
      window.__KNOWN_FLAGS__ = { reports: true }
    }
  })

  it('turns indexing off when visibility leaves public and warns in the slug hint', async () => {
    state.series = series({ visibility: 'public', allowSearchIndexing: true })
    mocks.patchReport.mockImplementation(async (_id: string, patch: Record<string, unknown>) => {
      state.series = { ...state.series, ...(patch as Partial<ReportSeries>) }
      return state.series
    })
    render()
    await waitForDom(domFinishedLoading)
    clickTab('Settings')
    await waitForDom(() => document.getElementById('ds-indexing') !== null)

    const indexing = () => document.getElementById('ds-indexing') as HTMLInputElement
    expect(indexing().disabled).toBe(false)
    expect(indexing().checked).toBe(true)
    expect(fieldHint('ds-indexing')).toBe('Lets search engines index the public pages.')
    expect(fieldHint('ds-visibility')).toBe('Listed in the digest directory. Anyone can open and follow it.')
    expect(fieldHint('ds-slug')).toContain('Leave empty to keep the digest unaddressed.')

    setInput('ds-slug', 'ai-weekly-renamed')
    const slugField = document.getElementById('ds-slug')?.closest('.field')
    const slugHints = [...(slugField?.querySelectorAll('span') ?? [])].filter((span) => span.classList.contains('field-hint'))
    expect(slugHints).toHaveLength(1)
    expect(slugHints[0]?.textContent).toBe('Changing the address breaks existing links to /reports/ai-weekly.')
    expect(slugField?.querySelector('[role="alert"]')).toBeNull()

    setInput('ds-slug', '  ai-weekly  ')
    expect(fieldHint('ds-slug')).toContain('Leave empty to keep the digest unaddressed.')
    expect(fieldHint('ds-slug')).not.toContain('Changing the address')

    setInput('ds-slug', 'moved-weekly')
    setSelect('ds-visibility', 'protected')
    expect(fieldHint('ds-visibility')).toBe('Only you and collaborators can open it for now.')
    expect(indexing().disabled).toBe(true)
    expect(indexing().checked).toBe(false)
    expect(fieldHint('ds-indexing')).toBe('Available when visibility is Public.')

    setSelect('ds-visibility', 'unlisted')
    expect(indexing().checked).toBe(false)
    act(() => {
      (document.querySelector('[data-testid="digest-settings-form"]') as HTMLFormElement)
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    await waitForDom(() => mocks.patchReport.mock.calls.length === 1)
    expect(document.querySelector('[data-testid="modal-panel"]')).toBeNull()
    expect(mocks.patchReport).toHaveBeenCalledWith(
      'rep-1',
      { slug: 'moved-weekly', visibility: 'unlisted', allowSearchIndexing: false },
      '"sr-1"',
      expect.objectContaining({ intentId: expect.any(String) }),
    )
  })

  it('keeps the normal slug hint when the digest has no address yet', async () => {
    state.series = series({ slug: null, visibility: 'public' })
    render()
    await waitForDom(domFinishedLoading)
    expect(document.body.textContent).not.toContain('Copy link')
    expect(linkByText('View public')).toBeUndefined()

    clickTab('Settings')
    await waitForDom(() => document.getElementById('ds-slug') !== null)
    setInput('ds-slug', 'brand-new')
    expect(fieldHint('ds-slug')).toBe('Lowercase letters, numbers and dashes — becomes the public address /reports/<slug>. Leave empty to keep the digest unaddressed.')
    expect(fieldHint('ds-slug')).not.toContain('Changing the address')
  })

  it('copies the digest address and reports when the clipboard refuses', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    const previousSecure = window.isSecureContext
    const previousClipboard = navigator.clipboard
    const previousExec = document.execCommand
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    Object.defineProperty(document, 'execCommand', { configurable: true, value: () => false })
    try {
      render()
      await waitForDom(domFinishedLoading)
      await act(async () => { findButtonByName('Copy link').click() })
      await waitForDom(() => mocks.success.mock.calls.length === 1)
      expect(writeText).toHaveBeenCalledWith(`${canonicalSiteOrigin()}${reportSeriesPath('ai-weekly')}`)
      expect(mocks.success).toHaveBeenCalledWith('Link copied')

      writeText.mockImplementation(async () => {
        throw new Error('denied')
      })
      await act(async () => { findButtonByName('Copy link').click() })
      await waitForDom(() => mocks.error.mock.calls.length === 1)
      expect(mocks.error).toHaveBeenCalledWith('Couldn’t copy the link')
    } finally {
      Object.defineProperty(window, 'isSecureContext', { configurable: true, value: previousSecure })
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: previousClipboard })
      Object.defineProperty(document, 'execCommand', { configurable: true, value: previousExec })
    }
  })
})

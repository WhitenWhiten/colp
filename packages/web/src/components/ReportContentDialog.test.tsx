// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductApiError } from '../api/errors'
import { ReportButton, ReportContentDialog } from './ReportContentDialog'
import { cleanup, mountTree } from '../test/render'

const mocks = vi.hoisted(() => ({
  submitModerationReport: vi.fn(),
  isLoggedIn: true,
  isLive: true,
  success: vi.fn(),
  error: vi.fn(),
}))

vi.mock('../api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../api')>(),
  isLive: () => mocks.isLive,
  productClient: {
    submitModerationReport: (...args: unknown[]) => mocks.submitModerationReport(...args),
    mutationIntentKey: (scope: string, id: string) => `${scope}:${id}`,
    newCommandId: () => '11111111-1111-4111-8111-111111111111',
  },
}))

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ isLoggedIn: mocks.isLoggedIn }),
}))

vi.mock('./AppToast', () => ({
  useToast: () => ({ success: mocks.success, error: mocks.error }),
}))

describe('content-governance report dialog', () => {
  beforeEach(() => {
    mocks.submitModerationReport.mockReset()
    mocks.submitModerationReport.mockResolvedValue({ id: 'case_1' })
    mocks.isLoggedIn = true
    mocks.isLive = true
    mocks.success.mockReset()
    mocks.error.mockReset()
  })
  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  it('submits a report against the stable locator', async () => {
    mountTree(
      <ReportContentDialog
        target={{ kind: 'collection', id: 'col_1' }}
        label="this collection"
        onClose={vi.fn()}
      />,
    )
    expect(document.querySelector('[data-testid="report-content-dialog"]')).toBeTruthy()
    expect(document.querySelector('form')).toBeTruthy()
    const description = document.querySelector<HTMLTextAreaElement>('#report-description')
    expect(description).toBeTruthy()
    expect(document.querySelector('#report-category')).toBeTruthy()
    await act(async () => {
      description!.value = 'unsolicited ads'
      description!.dispatchEvent(new Event('input', { bubbles: true }))
      document.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    await vi.waitFor(() => {
      expect(mocks.submitModerationReport).toHaveBeenCalled()
    })
    expect(mocks.submitModerationReport.mock.calls[0]?.[0]).toMatchObject({
      target: { kind: 'collection', id: 'col_1' },
      category: 'spam',
    })
    expect(mocks.success).toHaveBeenCalledWith('Report submitted.')
  })

  it('shows an inline error when submit fails and does not toast', async () => {
    mocks.submitModerationReport.mockRejectedValueOnce(new ProductApiError({
      status: 503,
      code: 'upstream_unavailable',
      message: 'The report could not be submitted',
    }))
    mountTree(
      <ReportContentDialog
        target={{ kind: 'collection', id: 'col_1' }}
        label="this collection"
        onClose={vi.fn()}
      />,
    )
    const description = document.querySelector<HTMLTextAreaElement>('[data-testid="report-description"]')
    await act(async () => {
      description!.value = 'unsolicited ads'
      description!.dispatchEvent(new Event('input', { bubbles: true }))
      document.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    await vi.waitFor(() => {
      // R15-23: a 503 reads as plain outage copy.
      expect(document.querySelector('[role="alert"]')?.textContent)
        .toBe('Know-N is having trouble right now. Try again in a minute.')
    })
    expect(mocks.error).not.toHaveBeenCalled()
    expect(document.querySelector('[data-testid="report-content-dialog"]')).toBeTruthy()
    expect(document.querySelector('form')).toBeTruthy()
  })

  // R15-11: guests get a report path instead of nothing.
  it('offers a signed-out visitor sign-in and a prefilled email', () => {
    mocks.isLoggedIn = false
    mountTree(
      <MemoryRouter>
        <ReportContentDialog target={{ kind: 'account', id: 'acc_1' }} label="this profile" onClose={vi.fn()} />
      </MemoryRouter>,
    )
    expect(document.querySelector('[data-testid="report-content-dialog"]')).toBeTruthy()
    expect(document.querySelector('form')).toBeNull()
    expect(document.querySelector('[data-testid="report-sign-in"]')?.getAttribute('href')).toMatch(/^\/login/)
    const email = document.querySelector('[data-testid="report-email"]')?.getAttribute('href') ?? ''
    expect(email).toMatch(/^mailto:help@know-n\.com\?subject=Report%20this%20profile&body=/)
    expect(decodeURIComponent(email)).toContain(`Page: ${window.location.href}`)
    expect(mocks.submitModerationReport).not.toHaveBeenCalled()
  })

  it('falls back to email alone when in-app reporting is off', () => {
    mocks.isLive = false
    mountTree(
      <MemoryRouter>
        <ReportContentDialog target={{ kind: 'collection', id: 'col_1' }} label="this collection" onClose={vi.fn()} />
      </MemoryRouter>,
    )
    expect(document.querySelector('form')).toBeNull()
    expect(document.querySelector('[data-testid="report-sign-in"]')).toBeNull()
    expect(document.querySelector('[data-testid="report-email"]')).toBeTruthy()
  })

  it('ReportButton opens the dialog for its target', async () => {
    mountTree(
      <ReportButton target={{ kind: 'digest_series', id: 'ser_1' }} label="this digest" testId="report-x" />,
    )
    expect(document.querySelector('[data-testid="report-content-dialog"]')).toBeNull()
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="report-x"]')?.click()
    })
    expect(document.querySelector('[data-testid="report-content-dialog"]')?.textContent).toContain('Report this digest')
  })
})

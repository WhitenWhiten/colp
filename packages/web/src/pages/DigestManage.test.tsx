// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductApiError } from '../api/errors'
import type { ReportMember } from '../api/types'
import { cleanup, domFinishedLoading, findButtonByName, waitForDom } from '../test/render'
import {
  clickTab,
  confirmDialog,
  edition,
  member,
  mocks,
  renderDigestManage,
  series,
  setInput,
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

function submitAttach() {
  act(() => {
    (document.querySelector('[data-testid="attach-issue-form"]') as HTMLFormElement)
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

/** Opens a digest issue row's ⋯ menu and returns its item (the menu is
    portaled to body, Library row grammar). */
function rowMenuItem(row: Element, label: string): HTMLElement {
  const trigger = row.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')
  if (!trigger) throw new Error('row menu trigger missing')
  if (trigger.getAttribute('aria-expanded') !== 'true') act(() => { trigger.click() })
  const item = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')]
    .find((node) => node.textContent?.trim() === label)
  if (!item) throw new Error(`row menu item ${label} missing`)
  return item
}

describe('DigestManage', () => {
  beforeEach(setUpDigestManage)
  afterEach(tearDownDigestManage)

  const render = renderDigestManage

  it('renders the workbench head and the issue table with per-state actions', async () => {
    render()
    await waitForDom(domFinishedLoading)

    expect(document.body.textContent).toContain('AI weekly')
    expect(document.body.textContent).toContain('2 issues')
    expect(document.body.textContent).toContain('AI links') // source column title lookup
    const rows = [...document.querySelectorAll('[data-testid="digest-issue-row"]')]
    expect(rows).toHaveLength(2)
    // The working draft leads the table.
    const [draftRow, publishedRow] = rows as [Element, Element]
    expect(draftRow.textContent).toContain('Draft')
    expect(publishedRow.textContent).toContain('Published')
    expect(publishedRow.querySelector('[data-label="Source"]')?.textContent).toContain('AI links')
    expect(publishedRow.querySelector('[data-label="Source"]')?.hasAttribute('data-empty')).toBe(false)
    expect(publishedRow.querySelector('[data-label="Period"]')?.textContent).toBe('—')
    expect(publishedRow.querySelector('[data-label="Period"]')?.hasAttribute('data-empty')).toBe(true)
    expect(publishedRow.querySelector('[data-label="State"]')?.textContent).toContain('Published')
    expect(publishedRow.querySelector('[data-label="Title"]')).toBeNull()
    expect(publishedRow.querySelector('[data-label="Actions"]')).toBeNull()
    // Only Publish stays visible; the rest sits behind the row's ⋯ menu.
    expect([...draftRow.querySelectorAll('button')].map((button) => button.textContent?.trim())).toContain('Publish')
    expect(draftRow.textContent).not.toContain('Delete')
    expect(publishedRow.textContent).not.toContain('Withdraw')
    expect(rowMenuItem(publishedRow, 'Withdraw')).toBeTruthy()
    // The published row's menu links into the public reader.
    expect(rowMenuItem(publishedRow, 'Open').getAttribute('href')).toBe('/reports/ai-weekly/issues/ed-1')
    expect([...document.querySelectorAll('[role="menu"] [role="menuitem"]')].some((node) => node.textContent === 'Delete')).toBe(false)
    expect(rowMenuItem(draftRow, 'Edit')).toBeTruthy()
    expect(rowMenuItem(draftRow, 'Delete')).toBeTruthy()
  })

  it('publishes a draft after the danger confirm, with the edition revision in If-Match', async () => {
    mocks.publishReportIssue.mockImplementation(async () => {
      state.issues = state.issues.map((item) => (item.id === 'ed-2' ? { ...item, state: 'published' as const } : item))
      return { ...edition('ed-2'), state: 'published' }
    })
    render()
    await waitForDom(domFinishedLoading)

    const rows = [...document.querySelectorAll('[data-testid="digest-issue-row"]')]
    const publish = [...rows[0]!.querySelectorAll('button')].find((b) => b.textContent === 'Publish')!
    act(() => { publish.click() })
    await confirmDialog()
    await waitForDom(() => mocks.publishReportIssue.mock.calls.length === 1)
    expect(mocks.publishReportIssue).toHaveBeenCalledWith(
      'rep-1', 'ed-2', '"er-ed-2"', expect.objectContaining({ intentId: expect.any(String) }),
    )
    await waitForDom(() => {
      const updated = [...document.querySelectorAll('[data-testid="digest-issue-row"]')]
      return updated[1]!.textContent!.includes('Published')
    })
  })

  it('withdraws a published issue after confirm', async () => {
    mocks.withdrawReportIssue.mockResolvedValue({ ...edition('ed-1'), state: 'withdrawn' })
    render()
    await waitForDom(domFinishedLoading)

    const rows = [...document.querySelectorAll('[data-testid="digest-issue-row"]')]
    const withdraw = rowMenuItem(rows[1]!, 'Withdraw')
    act(() => { withdraw.click() })
    await confirmDialog()
    await waitForDom(() => mocks.withdrawReportIssue.mock.calls.length === 1)
    expect(mocks.withdrawReportIssue).toHaveBeenCalledWith(
      'rep-1', 'ed-1', '"er-ed-1"', expect.objectContaining({ intentId: expect.any(String) }),
    )
  })

  it('deletes a draft after confirm', async () => {
    mocks.deleteReportIssue.mockImplementation(async () => {
      state.issues = state.issues.filter((item) => item.id !== 'ed-2')
    })
    render()
    await waitForDom(domFinishedLoading)

    const rows = [...document.querySelectorAll('[data-testid="digest-issue-row"]')]
    const del = rowMenuItem(rows[0]!, 'Delete')
    act(() => { del.click() })
    await confirmDialog()
    await waitForDom(() => mocks.deleteReportIssue.mock.calls.length === 1)
    expect(mocks.deleteReportIssue).toHaveBeenCalledWith(
      'rep-1', 'ed-2', '"er-ed-2"', expect.objectContaining({ intentId: expect.any(String) }),
    )
    await waitForDom(() => document.querySelectorAll('[data-testid="digest-issue-row"]').length === 1)
  })

  it('edits draft metadata through the modal', async () => {
    mocks.patchReportIssue.mockResolvedValue(edition('ed-2'))
    render()
    await waitForDom(domFinishedLoading)

    const rows = [...document.querySelectorAll('[data-testid="digest-issue-row"]')]
    const edit = rowMenuItem(rows[0]!, 'Edit')
    act(() => { edit.click() })
    await waitForDom(() => document.querySelector('[data-testid="edit-issue-form"]') !== null)

    setInput('ei-title', 'Renamed issue')
    act(() => {
      (document.querySelector('[data-testid="edit-issue-form"]') as HTMLFormElement)
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    await waitForDom(() => mocks.patchReportIssue.mock.calls.length === 1)
    expect(mocks.patchReportIssue).toHaveBeenCalledWith(
      'rep-1', 'ed-2',
      expect.objectContaining({ title: 'Renamed issue' }),
      '"er-ed-2"',
      expect.objectContaining({ intentId: expect.any(String) }),
    )
  })

  it('attaches a collection as a new draft issue', async () => {
    mocks.createReportIssue.mockImplementation(async () => {
      state.issues = [...state.issues, edition('ed-3', { editionOrdinal: 3 })]
      return edition('ed-3', { editionOrdinal: 3 })
    })
    render()
    await waitForDom(domFinishedLoading)

    act(() => { findButtonByName('New issue').click() })
    await waitForDom(() => {
      const pick = document.getElementById('ai-collection') as HTMLButtonElement | null
      return pick !== null && !pick.disabled
    })
    act(() => { (document.getElementById('ai-collection') as HTMLButtonElement).click() })
    await waitForDom(() => document.querySelector('[data-testid="destination-picker"]') !== null)
    act(() => {
      [...document.querySelectorAll<HTMLButtonElement>('[data-testid="destination-option"]')]
        .find((button) => button.textContent?.includes('AI links'))
        ?.click()
    })
    // The key is pre-filled behind Advanced and follows the period's week.
    const key = document.getElementById('ai-key') as HTMLInputElement
    expect(key.closest('details')?.open).toBe(false)
    expect(key.value).toMatch(/^\d{4}-W\d{2}$/)
    setInput('ai-period-start', '2026-09-14')
    expect(key.value).toBe('2026-W38')
    setInput('ai-title', 'Week 38')
    submitAttach()
    await waitForDom(() => mocks.createReportIssue.mock.calls.length === 1)
    expect(mocks.createReportIssue).toHaveBeenCalledWith(
      'rep-1',
      expect.objectContaining({ collectionId: 'col-1', issueKey: '2026-W38', title: 'Week 38' }),
      expect.objectContaining({ intentId: expect.any(String) }),
    )
    await waitForDom(() => document.querySelector('[data-testid="attach-issue-form"]') === null)
  })

  it('shows New issue errors under their own fields and keeps a typed key', async () => {
    render()
    await waitForDom(domFinishedLoading)
    act(() => { findButtonByName('New issue').click() })
    await waitForDom(() => {
      const pick = document.getElementById('ai-collection') as HTMLButtonElement | null
      return pick !== null && !pick.disabled
    })

    submitAttach()
    const pick = document.getElementById('ai-collection')!
    expect(document.getElementById('ai-collection-error')?.textContent).toBe('Pick a source collection.')
    expect(pick.getAttribute('aria-invalid')).toBe('true')
    expect(pick.getAttribute('aria-describedby')).toBe('ai-collection-error')

    act(() => { (pick as HTMLButtonElement).click() })
    await waitForDom(() => document.querySelector('[data-testid="destination-picker"]') !== null)
    act(() => {
      [...document.querySelectorAll<HTMLButtonElement>('[data-testid="destination-option"]')]
        .find((button) => button.textContent?.includes('AI links'))
        ?.click()
    })
    expect(document.getElementById('ai-collection-error')).toBeNull()
    // Picking prefills the title from the collection.
    expect((document.getElementById('ai-title') as HTMLInputElement).value).toBe('AI links')

    setInput('ai-period-start', '2026-09-14')
    setInput('ai-period-end', '2026-09-07')
    submitAttach()
    const periodEnd = document.getElementById('ai-period-end')!
    expect(document.getElementById('ai-period-error')?.textContent).toBe('The end date must be on or after the start date.')
    expect(periodEnd.getAttribute('aria-invalid')).toBe('true')
    expect(periodEnd.getAttribute('aria-describedby')).toBe('ai-period-error')
    setInput('ai-period-end', '2026-09-20')
    expect(document.getElementById('ai-period-error')).toBeNull()

    // A typed key stops following the period, and a blank one opens Advanced.
    setInput('ai-key', 'special')
    setInput('ai-period-start', '2026-09-07')
    expect((document.getElementById('ai-key') as HTMLInputElement).value).toBe('special')
    setInput('ai-key', '  ')
    submitAttach()
    const key = document.getElementById('ai-key')!
    expect(key.closest('details')?.open).toBe(true)
    expect(document.getElementById('ai-key-error')?.textContent).toBe('An issue needs a key like 2026-W38.')
    expect(key.getAttribute('aria-describedby')).toBe('ai-key-error')
    expect(mocks.createReportIssue).not.toHaveBeenCalled()
    expect(document.querySelectorAll('[data-testid="attach-issue-form"] [role="alert"]')).toHaveLength(1)
  })

  it('adds and removes collaborators with the policy revision in If-Match', async () => {
    mocks.putReportMember.mockImplementation(async (_id: string, subjectId: string, body: { role: ReportMember['role'] }) => {
      state.members = [...state.members.filter((m) => m.subjectId !== subjectId), member(subjectId, body.role)]
      return member(subjectId, body.role)
    })
    mocks.deleteReportMember.mockImplementation(async (_id: string, subjectId: string) => {
      state.members = state.members.filter((m) => m.subjectId !== subjectId)
    })
    render()
    await waitForDom(domFinishedLoading)
    clickTab('Collaborators')
    await waitForDom(() => document.getElementById('member-subject') !== null)

    expect(document.querySelector('label[for="member-subject"]')?.textContent).toBe('Account ID')

    // Owner row carries no controls.
    const rows = [...document.querySelectorAll('[data-testid="digest-member-row"]')]
    expect(rows[0]!.textContent).toContain('Owner')
    expect(rows[0]!.textContent).toContain('Account ID')
    expect(rows[0]!.querySelector('select, button.collab-remove, button.btn-danger-ghost')).toBeNull()
    expect(rows[1]!.textContent).toContain('Remove')

    setInput('member-subject', 'acct_new')
    act(() => {
      (document.querySelector('[data-testid="digest-members"] form.collab-invite') as HTMLFormElement)
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    await waitForDom(() => mocks.putReportMember.mock.calls.length === 1)
    expect(mocks.putReportMember).toHaveBeenCalledWith(
      'rep-1', 'acct_new', { role: 'editor' }, '"sp-1"',
      expect.objectContaining({ intentId: expect.any(String) }),
    )
    await waitForDom(() => mocks.success.mock.calls.some((call) => call[0] === 'Collaborator added'))

    const editorRow = () => [...document.querySelectorAll('[data-testid="digest-member-row"]')]
      .find((row) => row.textContent!.includes('sub-other'))!
    act(() => {
      [...editorRow().querySelectorAll('button')].find((button) => button.textContent === 'Viewer')?.click()
    })
    await waitForDom(() => mocks.success.mock.calls.some((call) => call[0] === 'Role updated'))

    const remove = editorRow().querySelector<HTMLButtonElement>('button.btn-danger-ghost.btn-sm')!
    expect(remove.classList.contains('btn')).toBe(true)
    expect(remove.textContent).toBe('Remove')
    act(() => { remove.click() })
    // The shared danger modal asks; no inline two-step confirm in the row.
    await waitForDom(() => document.querySelector('[data-testid="modal-panel"]') !== null)
    expect(document.querySelector('[data-testid="modal-panel"]')?.textContent).toContain('Remove this collaborator?')
    expect([...editorRow().querySelectorAll('button')].filter((button) => button.textContent === 'Remove')).toHaveLength(1)
    await confirmDialog()
    await waitForDom(() => mocks.deleteReportMember.mock.calls.length === 1)
    expect(mocks.deleteReportMember).toHaveBeenCalledWith(
      'rep-1', 'sub-other', '"sp-1"', expect.objectContaining({ intentId: expect.any(String) }),
    )
    await waitForDom(() => mocks.success.mock.calls.some((call) => call[0] === 'Collaborator removed'))
  })

  it('surfaces a stale-data bar on 412 and refreshes instead of replaying', async () => {
    mocks.patchReportIssue.mockRejectedValue(
      new ProductApiError({ status: 412, code: 'precondition_failed', message: 'stale revision' }),
    )
    render()
    await waitForDom(domFinishedLoading)

    const rows = [...document.querySelectorAll('[data-testid="digest-issue-row"]')]
    const edit = rowMenuItem(rows[0]!, 'Edit')
    act(() => { edit.click() })
    await waitForDom(() => document.querySelector('[data-testid="edit-issue-form"]') !== null)
    setInput('ei-title', 'Renamed issue')
    act(() => {
      (document.querySelector('[data-testid="edit-issue-form"]') as HTMLFormElement)
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    await waitForDom(() => document.querySelector('[data-testid="digest-op-bar"]') !== null)
    expect(document.querySelector('[data-testid="digest-op-bar"]')!.textContent).toContain('changed on the server')
    expect(mocks.abandonReportManageIntent).toHaveBeenCalled()
    // The intent was abandoned — it is not retried verbatim.
    expect(mocks.patchReportIssue).toHaveBeenCalledTimes(1)
  })

  it('parks an unknown-outcome intent and retries it verbatim', async () => {
    mocks.publishReportIssue
      .mockRejectedValueOnce(
        new ProductApiError({ status: 0, code: 'transport_error', message: 'offline' }),
      )
      .mockImplementation(async () => {
        state.issues = state.issues.map((item) => (item.id === 'ed-2' ? { ...item, state: 'published' as const } : item))
        return { ...edition('ed-2'), state: 'published' }
      })
    render()
    await waitForDom(domFinishedLoading)

    const rows = [...document.querySelectorAll('[data-testid="digest-issue-row"]')]
    const publish = [...rows[0]!.querySelectorAll('button')].find((b) => b.textContent === 'Publish')!
    act(() => { publish.click() })
    await confirmDialog()
    await waitForDom(() => document.querySelector('[data-testid="digest-op-bar"]') !== null)
    expect(document.querySelector('[data-testid="digest-op-bar"]')!.textContent).toContain('may not have been applied')

    act(() => { findButtonByName('Try again').click() })
    await waitForDom(() => mocks.publishReportIssue.mock.calls.length === 2)
    const first = mocks.publishReportIssue.mock.calls[0]
    const second = mocks.publishReportIssue.mock.calls[1]
    // Same intent id — the command receipt, not a new command.
    expect((second![3] as { intentId: string }).intentId).toBe((first![3] as { intentId: string }).intentId)
    await waitForDom(() => document.querySelector('[data-testid="digest-op-bar"]') === null)
  })

  it('shows Retry when the first load fails, then the digest title after it succeeds', async () => {
    // StrictMode replays the mount effect, so the failure has to be the
    // endpoint's base behaviour: one queued rejection is spent by the first
    // invocation and the replay would render the digest instead of Retry.
    mocks.getReport.mockRejectedValue(
      new ProductApiError({ status: 500, code: 'internal_error', message: 'boom' }),
    )
    render()
    await waitForDom(domFinishedLoading)

    expect(document.body.textContent).toContain("Couldn't load this digest")
    const retry = findButtonByName(/retry|try again/i)
    expect(retry.textContent).toMatch(/retry|try again/i)

    mocks.getReport.mockImplementation(async () => state.series)
    act(() => { retry.click() })
    await waitForDom(() => document.querySelector('h1')?.textContent === 'AI weekly')
    expect(document.querySelector('h1')?.textContent).toBe('AI weekly')
  })

  it('shows the unavailable state for a missing digest and when the flag is off', async () => {
    mocks.getReport.mockRejectedValue(
      new ProductApiError({ status: 404, code: 'resource_not_found', message: 'gone' }),
    )
    render()
    await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('Digest unavailable')

    cleanup()
    window.__KNOWN_FLAGS__ = { reports: false }
    render()
    await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('Digest unavailable')
  })
})

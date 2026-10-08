// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductApiError } from '../../api/errors'
import { ModerationCaseDetail } from './ModerationCaseDetail'
import { cleanup, mountTree, waitForDom } from '../../test/render'

function dialogText(title: string): string {
  return document.querySelector(`[role="dialog"][aria-label="${title}"]`)?.textContent ?? ''
}

async function confirmDialog(title: string, confirmLabel: string) {
  const dialog = document.querySelector(`[role="dialog"][aria-label="${title}"]`)
  if (!dialog) throw new Error(`confirm dialog missing: ${title}`)
  const button = [...dialog.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.textContent?.trim() === confirmLabel)
  if (!button) throw new Error(`confirm button missing: ${confirmLabel}`)
  await act(async () => {
    button.click()
    await Promise.resolve()
  })
}

const mocks = vi.hoisted(() => ({
  getModerationCase: vi.fn(),
  getModerationEvidence: vi.fn(),
  getModerationAction: vi.fn(),
  createModerationAction: vi.fn(),
  revokeModerationAction: vi.fn(),
  updateModerationCase: vi.fn(),
  isLoggedIn: true,
  isLive: true,
}))

vi.mock('../../api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../api')>(),
  isLive: () => mocks.isLive,
  productClient: {
    getModerationCase: (...args: unknown[]) => mocks.getModerationCase(...args),
    getModerationEvidence: (...args: unknown[]) => mocks.getModerationEvidence(...args),
    getModerationAction: (...args: unknown[]) => mocks.getModerationAction(...args),
    createModerationAction: (...args: unknown[]) => mocks.createModerationAction(...args),
    revokeModerationAction: (...args: unknown[]) => mocks.revokeModerationAction(...args),
    updateModerationCase: (...args: unknown[]) => mocks.updateModerationCase(...args),
    mutationIntentKey: (kind: string, id: string) => `${kind}:${id}`,
    newCommandId: () => '11111111-1111-4111-8111-111111111111',
  },
}))

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ isLoggedIn: mocks.isLoggedIn }),
}))

describe('content-governance admin case detail', () => {
  beforeEach(() => {
    mocks.getModerationCase.mockReset()
    mocks.getModerationEvidence.mockReset()
    mocks.getModerationAction.mockReset()
    mocks.createModerationAction.mockReset()
    mocks.revokeModerationAction.mockReset()
    mocks.isLoggedIn = true
    mocks.isLive = true
    mocks.getModerationCase.mockResolvedValue({
      case: {
        id: 'case_1',
        target: { kind: 'collection', id: 'col_1' },
        category: 'spam',
        status: 'in_review',
        publicResolution: null,
        revision: '2',
        createdAt: '2026-09-15T00:00:00.000Z',
        updatedAt: '2026-09-15T00:00:00.000Z',
      },
      reporterAccountId: 'acc_1',
      description: 'spam',
      assignedToAccountId: null,
      evidenceIds: ['ev_1'],
      actionIds: [],
      internalNote: null,
    })
    mocks.getModerationEvidence.mockResolvedValue({
      id: 'ev_1',
      caseId: 'case_1',
      target: { kind: 'collection', id: 'col_1' },
      capturedAt: '2026-09-15T00:00:00.000Z',
      sourceRevision: null,
      title: 'Notes',
      text: 'spam advertisement copy',
      sourceUrl: null,
      truncated: false,
    })
    mocks.createModerationAction.mockResolvedValue({
      id: 'act_1',
      caseId: 'case_1',
      target: { kind: 'collection', id: 'col_1' },
      action: 'hide_public',
      reason: 'Hide public collection',
      actorAccountId: 'mod_1',
      state: 'active',
      revision: '1',
      createdAt: '2026-09-15T00:00:00.000Z',
      revokedAt: null,
      revokeReason: null,
    })
  })
  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  it('lets a moderator hide a collection through the official action API', async () => {
    mountTree(
      <MemoryRouter initialEntries={['/admin/moderation/cases/case_1']}>
        <Routes>
          <Route path="/admin/moderation/cases/:caseId" element={<ModerationCaseDetail />} />
        </Routes>
      </MemoryRouter>,
    )
    await waitForDom(() => document.querySelector('[data-testid="admin-moderation-case"]') !== null)
    const hide = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Hide public')
    expect(hide).toBeTruthy()
    await act(async () => { hide?.click() })
    expect(dialogText('Hide “Notes”?')).toContain('replaced by a notice for everyone else. You can revoke this later.')
    await confirmDialog('Hide “Notes”?', 'Hide')
    await waitForDom(() => mocks.createModerationAction.mock.calls.length === 1)
    expect(mocks.createModerationAction.mock.calls[0]?.[0]).toMatchObject({
      caseId: 'case_1',
      action: 'hide_public',
      target: { kind: 'collection', id: 'col_1' },
    })
  })

  it('lets a moderator hide a bookmark against the stable collectionId+node locator', async () => {
    mocks.getModerationCase.mockResolvedValue({
      case: {
        id: 'case_2',
        target: { kind: 'bookmark', id: 'node_1', collectionId: 'col_1' },
        category: 'spam',
        status: 'in_review',
        publicResolution: null,
        revision: '2',
        createdAt: '2026-09-15T00:00:00.000Z',
        updatedAt: '2026-09-15T00:00:00.000Z',
      },
      reporterAccountId: 'acc_1',
      description: 'phishing bookmark',
      assignedToAccountId: null,
      evidenceIds: ['ev_1'],
      actionIds: [],
      internalNote: null,
    })
    mocks.createModerationAction.mockResolvedValue({
      id: 'act_2',
      caseId: 'case_2',
      target: { kind: 'bookmark', id: 'node_1', collectionId: 'col_1' },
      action: 'hide_public',
      reason: 'Hide public bookmark',
      actorAccountId: 'mod_1',
      state: 'active',
      revision: '1',
      createdAt: '2026-09-15T00:00:00.000Z',
      revokedAt: null,
      revokeReason: null,
    })
    mountTree(
      <MemoryRouter initialEntries={['/admin/moderation/cases/case_2']}>
        <Routes>
          <Route path="/admin/moderation/cases/:caseId" element={<ModerationCaseDetail />} />
        </Routes>
      </MemoryRouter>,
    )
    await waitForDom(() => document.querySelector('[data-testid="admin-moderation-case"]') !== null)
    expect(document.body.textContent).toContain('Bookmark node_1 · in collection col_1')
    const hide = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Hide public')
    expect(hide).toBeTruthy()
    await act(async () => { hide?.click() })
    await confirmDialog('Hide “Notes”?', 'Hide')
    await waitForDom(() => mocks.createModerationAction.mock.calls.length === 1)
    expect(mocks.createModerationAction.mock.calls[0]?.[0]).toMatchObject({
      caseId: 'case_2',
      action: 'hide_public',
      target: { kind: 'bookmark', id: 'node_1', collectionId: 'col_1' },
    })
  })

  it('lets a moderator hide a digest series and an edition with seriesId', async () => {
    mocks.getModerationCase.mockResolvedValue({
      case: {
        id: 'case_3',
        target: { kind: 'digest_series', id: 'ser_1' },
        category: 'spam',
        status: 'in_review',
        publicResolution: null,
        revision: '2',
        createdAt: '2026-09-15T00:00:00.000Z',
        updatedAt: '2026-09-15T00:00:00.000Z',
      },
      reporterAccountId: 'acc_1',
      description: 'spam digest',
      assignedToAccountId: null,
      evidenceIds: ['ev_1'],
      actionIds: [],
      internalNote: null,
    })
    mocks.createModerationAction.mockResolvedValue({
      id: 'act_3',
      caseId: 'case_3',
      target: { kind: 'digest_series', id: 'ser_1' },
      action: 'hide_public',
      reason: 'Hide public digest',
      actorAccountId: 'mod_1',
      state: 'active',
      revision: '1',
      createdAt: '2026-09-15T00:00:00.000Z',
      revokedAt: null,
      revokeReason: null,
    })
    mountTree(
      <MemoryRouter initialEntries={['/admin/moderation/cases/case_3']}>
        <Routes>
          <Route path="/admin/moderation/cases/:caseId" element={<ModerationCaseDetail />} />
        </Routes>
      </MemoryRouter>,
    )
    await waitForDom(() => document.querySelector('[data-testid="admin-moderation-case"]') !== null)
    const hide = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Hide public')
    expect(hide).toBeTruthy()
    await act(async () => { hide?.click() })
    await confirmDialog('Hide “Notes”?', 'Hide')
    await waitForDom(() => mocks.createModerationAction.mock.calls.length === 1)
    expect(mocks.createModerationAction.mock.calls[0]?.[0]).toMatchObject({
      caseId: 'case_3',
      action: 'hide_public',
      target: { kind: 'digest_series', id: 'ser_1' },
    })

    mocks.getModerationCase.mockResolvedValue({
      case: {
        id: 'case_4',
        target: { kind: 'digest_edition', id: 'ed_1', seriesId: 'ser_1' },
        category: 'spam',
        status: 'in_review',
        publicResolution: null,
        revision: '2',
        createdAt: '2026-09-15T00:00:00.000Z',
        updatedAt: '2026-09-15T00:00:00.000Z',
      },
      reporterAccountId: 'acc_1',
      description: 'spam edition',
      assignedToAccountId: null,
      evidenceIds: ['ev_1'],
      actionIds: [],
      internalNote: null,
    })
    mocks.createModerationAction.mockReset()
    mocks.createModerationAction.mockResolvedValue({
      id: 'act_4',
      caseId: 'case_4',
      target: { kind: 'digest_edition', id: 'ed_1', seriesId: 'ser_1' },
      action: 'delist',
      reason: 'Delist edition',
      actorAccountId: 'mod_1',
      state: 'active',
      revision: '1',
      createdAt: '2026-09-15T00:00:00.000Z',
      revokedAt: null,
      revokeReason: null,
    })
    cleanup()
    document.body.innerHTML = ''
    mountTree(
      <MemoryRouter initialEntries={['/admin/moderation/cases/case_4']}>
        <Routes>
          <Route path="/admin/moderation/cases/:caseId" element={<ModerationCaseDetail />} />
        </Routes>
      </MemoryRouter>,
    )
    await waitForDom(() => document.querySelector('[data-testid="admin-moderation-case"]') !== null)
    expect(document.body.textContent).toContain('Digest issue ed_1 · in digest ser_1')
    const delist = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Delist')
    expect(delist).toBeTruthy()
    await act(async () => { delist?.click() })
    expect(dialogText('Delist “Notes”?')).toContain('removed from Explore, search and the directory')
    await confirmDialog('Delist “Notes”?', 'Delist')
    await waitForDom(() => mocks.createModerationAction.mock.calls.length === 1)
    expect(mocks.createModerationAction.mock.calls[0]?.[0]).toMatchObject({
      caseId: 'case_4',
      action: 'delist',
      target: { kind: 'digest_edition', id: 'ed_1', seriesId: 'ser_1' },
    })
  })

  it('lets a moderator restrict an account from the case locator', async () => {
    mocks.getModerationCase.mockResolvedValue({
      case: {
        id: 'case_5',
        target: { kind: 'account', id: 'acc_spam' },
        category: 'spam',
        status: 'in_review',
        publicResolution: null,
        revision: '2',
        createdAt: '2026-09-16T00:00:00.000Z',
        updatedAt: '2026-09-16T00:00:00.000Z',
      },
      reporterAccountId: 'acc_1',
      description: 'spam farm',
      assignedToAccountId: null,
      evidenceIds: ['ev_1'],
      actionIds: [],
      internalNote: null,
    })
    mocks.createModerationAction.mockResolvedValue({
      id: 'act_5',
      caseId: 'case_5',
      target: { kind: 'account', id: 'acc_spam' },
      action: 'restrict_publication',
      reason: 'Restrict account publication',
      actorAccountId: 'mod_1',
      state: 'active',
      revision: '1',
      createdAt: '2026-09-16T00:00:00.000Z',
      revokedAt: null,
      revokeReason: null,
    })
    mountTree(
      <MemoryRouter initialEntries={['/admin/moderation/cases/case_5']}>
        <Routes>
          <Route path="/admin/moderation/cases/:caseId" element={<ModerationCaseDetail />} />
        </Routes>
      </MemoryRouter>,
    )
    await waitForDom(() => document.querySelector('[data-testid="admin-moderation-account-locator"]') !== null)
    expect(document.body.textContent).toContain('Account acc_spam')
    // The case is already in review, so Start review is not offered again.
    const startReview = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Start review')
    expect(startReview?.disabled).toBe(true)
    const restrict = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Restrict publication')
    expect(restrict).toBeTruthy()
    await act(async () => { restrict?.click() })
    expect(dialogText('Restrict publication?')).toContain('stop appearing in Explore, search and feeds until this is revoked.')
    await confirmDialog('Restrict publication?', 'Restrict')
    await waitForDom(() => mocks.createModerationAction.mock.calls.length === 1)
    expect(mocks.createModerationAction.mock.calls[0]?.[0]).toMatchObject({
      caseId: 'case_5',
      action: 'restrict_publication',
      target: { kind: 'account', id: 'acc_spam' },
    })
  })

  it('loads evidence and revokes a preloaded active action', async () => {
    mocks.getModerationCase.mockResolvedValue({
      case: {
        id: 'case_1',
        target: { kind: 'collection', id: 'col_1' },
        category: 'spam',
        status: 'in_review',
        publicResolution: null,
        revision: '2',
        createdAt: '2026-09-15T00:00:00.000Z',
        updatedAt: '2026-09-15T00:00:00.000Z',
      },
      reporterAccountId: 'acc_1',
      description: 'spam',
      assignedToAccountId: null,
      evidenceIds: ['ev_1'],
      actionIds: ['act_1'],
      internalNote: null,
    })
    mocks.getModerationAction.mockResolvedValue({
      id: 'act_1',
      caseId: 'case_1',
      target: { kind: 'collection', id: 'col_1' },
      action: 'hide_public',
      reason: 'Hide public collection',
      actorAccountId: 'mod_1',
      state: 'active',
      revision: '1',
      createdAt: '2026-09-15T00:00:00.000Z',
      revokedAt: null,
      revokeReason: null,
    })
    mocks.revokeModerationAction.mockResolvedValue({
      id: 'act_1',
      caseId: 'case_1',
      target: { kind: 'collection', id: 'col_1' },
      action: 'hide_public',
      reason: 'Hide public collection',
      actorAccountId: 'mod_1',
      state: 'revoked',
      revision: '2',
      createdAt: '2026-09-15T00:00:00.000Z',
      revokedAt: '2026-09-15T01:00:00.000Z',
      revokeReason: 'Revoke official collection control',
    })
    mountTree(
      <MemoryRouter initialEntries={['/admin/moderation/cases/case_1']}>
        <Routes>
          <Route path="/admin/moderation/cases/:caseId" element={<ModerationCaseDetail />} />
        </Routes>
      </MemoryRouter>,
    )
    await waitForDom(() => document.querySelector('[data-testid="admin-moderation-evidence"]') !== null)
    expect(document.querySelector('[data-testid="admin-moderation-evidence"]')?.textContent).toContain('spam advertisement copy')
    const revoke = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Revoke')
    expect(revoke).toBeTruthy()
    await act(async () => { revoke?.click() })
    expect(dialogText('Revoke this action?')).toContain('The original action is undone')
    await confirmDialog('Revoke this action?', 'Revoke')
    await waitForDom(() => mocks.revokeModerationAction.mock.calls.length === 1)
    expect(mocks.revokeModerationAction.mock.calls[0]?.[0]).toBe('act_1')
    expect(mocks.revokeModerationAction.mock.calls[0]?.[1]).toEqual({ reason: 'Revoked by a reviewer (hide_public)' })
  })

  it('treats a server 403 as missing official access', async () => {
    mocks.getModerationCase.mockRejectedValue(new ProductApiError({
      status: 403,
      code: 'insufficient_permission',
      message: 'You do not have permission to perform this action.',
    }))
    mountTree(
      <MemoryRouter initialEntries={['/admin/moderation/cases/case_1']}>
        <Routes>
          <Route path="/admin/moderation/cases/:caseId" element={<ModerationCaseDetail />} />
        </Routes>
      </MemoryRouter>,
    )
    await waitForDom(() => document.body.textContent?.includes('Official reviewer access is required.') === true)
    expect(document.querySelector('[data-testid="admin-moderation-case"]')).toBeNull()
    expect([...document.querySelectorAll('button')].some((button) => button.textContent === 'Retry')).toBe(false)
  })
  it('shows the feature as unavailable while the governance flag is off', () => {
    mocks.isLive = false
    mountTree(
      <MemoryRouter initialEntries={['/admin/moderation/cases/case_1']}>
        <Routes>
          <Route path="/admin/moderation/cases/:caseId" element={<ModerationCaseDetail />} />
        </Routes>
      </MemoryRouter>,
    )
    expect(document.body.textContent).toContain('Moderation cases are not available yet')
    expect(document.body.textContent).toContain('It will appear here when it is ready.')
    expect(mocks.getModerationCase).not.toHaveBeenCalled()
  })

  it('clears the loaded case when the next case fails to load', async () => {
    /* Without the projection reset the previous case stays on screen under the
       new URL, and its non-null view suppresses the error branch — the failed
       load leaves no trace. */
    let nav: ReturnType<typeof useNavigate> | null = null
    function Harness() {
      nav = useNavigate()
      return <ModerationCaseDetail />
    }
    mountTree(
      <MemoryRouter initialEntries={['/admin/moderation/cases/case_1']}>
        <Routes>
          <Route path="/admin/moderation/cases/:caseId" element={<Harness />} />
        </Routes>
      </MemoryRouter>,
    )
    await waitForDom(() => document.querySelector('[data-testid="admin-moderation-case"]') !== null)
    expect(document.body.textContent).toContain('Notes')

    mocks.getModerationCase.mockRejectedValue(new Error('offline'))
    await act(async () => { nav!('/admin/moderation/cases/case_2') })
    await waitForDom(() => document.body.textContent?.includes("Couldn't load this case") === true)
    expect(document.querySelector('[data-testid="admin-moderation-case"]')).toBeNull()
    expect(document.body.textContent).not.toContain('Notes')
  })

})

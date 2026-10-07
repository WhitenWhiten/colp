/**
 * Shared scaffold for the DigestManage suites (DigestManage.test.tsx,
 * DigestManage.settings.test.tsx).
 *
 * Each suite still registers its own vi.mock(...) factories; those factories
 * `await import('./DigestManage.test-mocks')` (the leaf module, never this
 * one). `state` is what the default endpoint mocks answer with; a test edits
 * it to change what the next read sees.
 */
import { act } from 'react'
import { Route, Routes } from 'react-router-dom'
import type {
  OwnedCollectionListItem,
  ReportEdition,
  ReportEditionPage,
  ReportMember,
  ReportSeries,
} from '../api/types'
import { clearRouteCache } from '../lib/routeCache'
import { cleanup, mountTree, waitForDom } from '../test/render'
import { DigestManage } from './DigestManage'
import { mocks } from './DigestManage.test-mocks'

export { mocks } from './DigestManage.test-mocks'

export function series(overrides: Partial<ReportSeries> = {}): ReportSeries {
  return {
    id: 'rep-1',
    ownerSubjectId: 'sub-me',
    title: 'AI weekly',
    summary: 'Weekly AI reading',
    slug: 'ai-weekly',
    visibility: 'private',
    allowSearchIndexing: false,
    state: 'active',
    resourceRevision: 'sr-1',
    contentRevision: 'sc-1',
    policyRevision: 'sp-1',
    ...overrides,
  }
}

export function edition(id: string, overrides: Partial<ReportEdition> = {}): ReportEdition {
  return {
    id,
    seriesId: 'rep-1',
    sourceCollectionId: 'col-1',
    issueKey: `key-${id}`,
    editionOrdinal: 1,
    titleSnapshot: `Issue ${id}`,
    summarySnapshot: null,
    sourceContentRevision: 'src-1',
    sourcePolicyRevision: null,
    resourceRevision: `er-${id}`,
    periodStart: null,
    periodEnd: null,
    state: 'draft',
    publishedAt: null,
    ...overrides,
  }
}

export function member(subjectId: string, role: ReportMember['role'] = 'editor'): ReportMember {
  return { seriesId: 'rep-1', subjectId, role, revokedAt: null }
}

export function issuesPage(items: ReportEdition[]): ReportEditionPage {
  return { items, nextCursor: null }
}

export function owned(id: string, title: string): OwnedCollectionListItem {
  return {
    collection: {
      id, kind: 'bookmarks', title, summary: null, visibility: 'private',
      allowSearchIndexing: false, publicationSlug: null, publishedAt: null,
      rootNodeId: `${id}-root`, revision: '1', etag: '"1"', contentRevision: '1',
      contentEtag: '"1"', policyRevision: '1', policyEtag: '"1"',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    },
    capabilities: {
      updateCollection: true, deleteCollection: true, managePublication: true,
      manageMembers: true, createNode: true, updateNode: true, moveNode: true,
      deleteNode: true, restoreNode: true, annotateNode: true, manageAnnotationVisibility: true,
      uploadBookmarkIcon: true,
    },
  } as OwnedCollectionListItem
}

export function setInput(id: string, value: string) {
  const input = document.getElementById(id) as HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

export function setSelect(id: string, value: string) {
  const select = document.getElementById(id) as HTMLSelectElement
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
  act(() => {
    setter.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

export function linkByText(text: string): HTMLAnchorElement | undefined {
  return [...document.querySelectorAll('a')].find((anchor) => anchor.textContent?.trim() === text)
}

export function fieldHint(id: string): string {
  const field = document.getElementById(id)?.closest('.field')
  const hint = [...(field?.querySelectorAll('span') ?? [])].find((span) => span.classList.contains('field-hint'))
  return hint?.textContent ?? ''
}

export function clickTab(name: string) {
  act(() => {
    [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find((tab) => tab.textContent === name)
      ?.click()
  })
}

/** Confirm the shared danger modal (ConfirmProvider is mounted by mountTree). */
export async function confirmDialog() {
  await waitForDom(() => document.querySelector('[data-testid="modal-panel"]') !== null)
  const panel = document.querySelector('[data-testid="modal-panel"]')!
  const danger = [...panel.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.className.includes('btn-danger'))
  act(() => { danger!.click() })
  /* The modal leaves through its exit animation; wait for the unmount inside
     act so the trailing state update is not flagged as un-acted. */
  await waitForDom(() => document.querySelector('[data-testid="modal-panel"]') === null)
}

export const state: {
  series: ReportSeries
  issues: ReportEdition[]
  members: ReportMember[]
  schedule: unknown
} = { series: series(), issues: [], members: [], schedule: null }

export function setUpDigestManage() {
  clearRouteCache()
  state.series = series()
  state.issues = [
    edition('ed-1', { state: 'published', editionOrdinal: 1, publishedAt: '2026-09-01T00:00:00.000Z' }),
    edition('ed-2', { state: 'draft', editionOrdinal: 2 }),
  ]
  state.members = [member('sub-me', 'owner'), member('sub-other', 'editor')]
  state.schedule = null

  mocks.auth.isLoggedIn = true
  mocks.auth.bootstrapping = false
  for (const mock of Object.values(mocks)) {
    if (typeof mock === 'function' && 'mockReset' in mock) (mock as { mockReset: () => void }).mockReset()
  }
  mocks.commandSeq = 0
  // mockReset clears implementations — restore the intent helpers.
  mocks.newCommandId.mockImplementation(() => `cmd-${++mocks.commandSeq}`)
  mocks.mutationIntentKey.mockImplementation((scope: string, id: string) => `${scope}:${id}`)

  mocks.getReport.mockImplementation(async () => state.series)
  mocks.listReportIssues.mockImplementation(async () => issuesPage(state.issues))
  mocks.getReportSchedule.mockImplementation(async () => ({ schedule: state.schedule }))
  mocks.listReportMembers.mockImplementation(async () => ({ items: state.members, nextCursor: null }))
  mocks.loadOwnedCollections.mockResolvedValue([owned('col-1', 'AI links')])
  // CG-01 catalog fields fetch the report catalog when the form mounts.
  mocks.getReportCatalog.mockResolvedValue({ tags: [], language: null, revision: '1' })

  window.__KNOWN_FLAGS__ = { reports: true }
  document.body.innerHTML = '<div id="root"></div>'
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
}

export function tearDownDigestManage() {
  cleanup()
  delete window.__KNOWN_FLAGS__
  document.body.innerHTML = ''
}

export function renderDigestManage(route = '/library/digests/rep-1') {
  mountTree(
    <Routes>
      <Route path="/library/digests/:id" element={<DigestManage />} />
    </Routes>,
    { route },
  )
}

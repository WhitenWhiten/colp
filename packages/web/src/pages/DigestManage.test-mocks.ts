/**
 * Leaf module holding the mock instances shared by the DigestManage suites.
 * It must not import any application code: vi.mock factories
 * `await import(...)` it while the module graph (helper → DigestManage →
 * ../api) is still initializing, and an app import here would deadlock
 * that cycle.
 */
import { vi } from 'vitest'

export const mocks = {
  auth: { isLoggedIn: true, bootstrapping: false },
  toast: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  getReport: vi.fn(),
  listReportIssues: vi.fn(),
  getReportSchedule: vi.fn(),
  listReportMembers: vi.fn(),
  loadOwnedCollections: vi.fn(),
  patchReport: vi.fn(),
  deleteReport: vi.fn(),
  createReportIssue: vi.fn(),
  patchReportIssue: vi.fn(),
  deleteReportIssue: vi.fn(),
  publishReportIssue: vi.fn(),
  withdrawReportIssue: vi.fn(),
  putReportSchedule: vi.fn(),
  deleteReportSchedule: vi.fn(),
  putReportMember: vi.fn(),
  deleteReportMember: vi.fn(),
  abandonReportManageIntent: vi.fn(),
  getReportCatalog: vi.fn(),
  updateReportCatalog: vi.fn(),
  commandSeq: 0,
  newCommandId: vi.fn(() => `cmd-${++mocks.commandSeq}`),
  mutationIntentKey: vi.fn((scope: string, id: string) => `${scope}:${id}`),
}

/** The productClient methods the suites replace, spread over the real client. */
export function productClientMocks() {
  return {
    getReport: mocks.getReport,
    listReportIssues: mocks.listReportIssues,
    getReportSchedule: mocks.getReportSchedule,
    listReportMembers: mocks.listReportMembers,
    loadOwnedCollections: mocks.loadOwnedCollections,
    patchReport: mocks.patchReport,
    deleteReport: mocks.deleteReport,
    createReportIssue: mocks.createReportIssue,
    patchReportIssue: mocks.patchReportIssue,
    deleteReportIssue: mocks.deleteReportIssue,
    publishReportIssue: mocks.publishReportIssue,
    withdrawReportIssue: mocks.withdrawReportIssue,
    putReportSchedule: mocks.putReportSchedule,
    deleteReportSchedule: mocks.deleteReportSchedule,
    putReportMember: mocks.putReportMember,
    deleteReportMember: mocks.deleteReportMember,
    abandonReportManageIntent: mocks.abandonReportManageIntent,
    getReportCatalog: mocks.getReportCatalog,
    updateReportCatalog: mocks.updateReportCatalog,
    newCommandId: mocks.newCommandId,
    mutationIntentKey: mocks.mutationIntentKey,
  }
}

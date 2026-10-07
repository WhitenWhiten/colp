/**
 * Leaf module holding the mock state shared by the Library page suites.
 * It must not import any application code: vi.mock factories
 * `await import(...)` it while the module graph (helper → Library → ../api)
 * is still initializing, and an app import here would deadlock that cycle.
 */
import { vi } from 'vitest'
import type { OwnedCollectionListItem, ReportIssueTimelinePage } from '../api/types'

export const mocks = {
  isLive: vi.fn((flag: string) => ['collectionList', 'savedResources', 'readingProgress'].includes(flag)),
  auth: { isLoggedIn: true, bootstrapping: false, sessionState: 'ready' as string, refreshSession: vi.fn(async () => undefined) },
  collections: {
    items: [] as OwnedCollectionListItem[],
    state: 'ready' as 'loading' | 'ready' | 'error',
    message: '',
    hasMore: false,
    isLoadingMore: false,
    reload: vi.fn(async () => undefined),
    loadMore: vi.fn(async () => undefined),
  },
  shared: {
    items: [] as OwnedCollectionListItem[],
    state: 'ready' as 'loading' | 'ready' | 'error',
    message: '',
    hasMore: false,
    isLoadingMore: false,
    reload: vi.fn(async () => undefined),
    loadMore: vi.fn(async () => undefined),
  },
  invites: {
    items: [] as Array<{ inviteId: string; collectionId: string; collectionTitle: string }>,
    state: 'ready' as 'loading' | 'ready' | 'error',
    message: '',
    pendingInviteId: null as string | null,
    accept: vi.fn(async () => ({ collectionId: '' })),
    decline: vi.fn(async () => undefined),
  },
    saved: { items: [] as Array<{ resourceType: string; resourceId: string; target: { availability: string; title: string; url: string | null; collectionId: string | null } }>, state: 'ready', message: '', reload: vi.fn() },
  progress: { items: [] as Array<{ resourceType: string; resourceId: string; status: string; progress: number; target: { availability: string; title: string; url: string | null; collectionId: string | null } }>, state: 'ready', message: '', reload: vi.fn() },
  loadEditorSnapshot: vi.fn(),
  loadPublicCollectionSnapshot: vi.fn(),
  loadAnnotations: vi.fn(async () => []),
  listFollowedCollections: vi.fn(),
  listFollowedReports: vi.fn(async () => ({ items: [], nextCursor: null })),
  listMyReports: vi.fn(async () => ({ items: [], nextCursor: null })),
  getFollowedReportIssuesPage: vi.fn(async (): Promise<ReportIssueTimelinePage> => ({ items: [], nextCursor: null })),
  getMyLibraryOrder: vi.fn(),
}

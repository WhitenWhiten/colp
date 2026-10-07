/**
 * Leaf module holding the mock instances shared by the LibraryDesk
 * suites (LibraryDesk.test.tsx, LibraryDesk.actions.test.tsx,
 * LibraryDesk.sharing.test.tsx).
 * It must not import any application code: vi.mock factories
 * `await import(...)` it while the module graph (helper → LibraryDesk
 * → mocked modules) is still initializing, and an app import here would
 * deadlock that cycle.
 */
import { vi } from 'vitest'
import type { OwnedCollectionListItem } from '../../api/types'

export const mocks = {
  auth: { isLoggedIn: true, bootstrapping: false, refreshSession: vi.fn(async () => undefined) },
  toast: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  loadEditorSnapshot: vi.fn(),
  loadPublicCollectionSnapshot: vi.fn(),
  loadAnnotations: vi.fn(),
  createCollectionNode: vi.fn(),
  updateCollectionNode: vi.fn(),
  moveCollectionNode: vi.fn(),
  deleteCollectionNode: vi.fn(),
  createAnnotation: vi.fn(),
  updateAnnotation: vi.fn(),
  deleteAnnotation: vi.fn(),
  getAnnotation: vi.fn(),
  abandonAnnotationIntent: vi.fn(),
  uploadBookmarkFavicon: vi.fn(),
  deleteBookmarkFavicon: vi.fn(),
  getBookmarkFaviconSource: vi.fn(),
  setBookmarkFaviconSource: vi.fn(),
  getBookmarkPreviewMode: vi.fn(),
  setBookmarkPreviewMode: vi.fn(),
  requestLinkPreviews: vi.fn(),
  listFollowedCollections: vi.fn(),
  listFollowedReports: vi.fn(),
  listMyReports: vi.fn(),
  getFollowedReportIssuesPage: vi.fn(),
  getMyLibraryOrder: vi.fn(),
  updateMyLibraryOrder: vi.fn(),
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
    items: [] as Array<{
      inviteId: string
      collectionId: string
      collectionTitle: string
      role: 'editor' | 'viewer'
      email: string
      expiresAt: string
      invitedAt: string
    }>,
    state: 'ready' as 'loading' | 'ready' | 'error',
    message: '',
    pendingInviteId: null as string | null,
    reload: vi.fn(async () => undefined),
    accept: vi.fn(async () => ({ collectionId: 'col-shared', subjectId: 'sub-b', role: 'editor' as const, grantedAt: '2026-08-19T00:00:00.000Z', policyEtag: '"p-2"' })),
    decline: vi.fn(async () => undefined),
  },
}

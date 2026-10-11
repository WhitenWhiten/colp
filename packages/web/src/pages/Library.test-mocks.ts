/**
 * Leaf module holding the mock state shared by the Library page suites.
 * It must not import any application code: vi.mock factories
 * `await import(...)` it while the module graph (helper → Library → ../api)
 * is still initializing, and an app import here would deadlock that cycle.
 */
import { vi } from 'vitest'
import type { OwnedCollectionListItem } from '../api/types'

export const mocks = {
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
  loadEditorSnapshot: vi.fn(),
  loadPublicCollectionSnapshot: vi.fn(),
  loadAnnotations: vi.fn(async () => []),
  getMyLibraryOrder: vi.fn(),
}

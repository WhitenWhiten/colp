/**
 * Leaf module holding the mock instances shared by the Collection page
 * suites. It must not import any application code: vi.mock factories
 * `await import(...)` it while the module graph (helper → Collection →
 * ../api) is still initializing, and an app import here would deadlock
 * that cycle.
 */
import { vi } from 'vitest'

export const mocks = {
  loadPublicCollectionSnapshot: vi.fn(),
  recordPublicCollectionInsightEvent: vi.fn(),
  getPublicProfilePage: vi.fn(),
  isFollowingProfile: vi.fn(),
  followProfile: vi.fn(),
  unfollowProfile: vi.fn(),
  abandonFollowIntent: vi.fn(),
  /* FO-05 sort toggle + children layer */
  listCollectionChildren: vi.fn(),
  /* R7-07 save-to-library flow */
  loadEditorSnapshot: vi.fn(),
  createCollectionNode: vi.fn(),
  getCollectionFollowState: vi.fn(),
  followCollection: vi.fn(),
  unfollowCollection: vi.fn(),
  abandonCollectionFollowIntent: vi.fn(),
  /* CS-01 community vote control */
  resolveCommunityTarget: vi.fn(),
  setCommunityVote: vi.fn(),
  abandonCommunityVoteIntent: vi.fn(),
  /* CS-03 community comments panel (same resolved target) */
  getCommunityComments: vi.fn(),
  toast: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}

export type MockIntersectionObserverInstance = {
  callback: IntersectionObserverCallback
  options?: IntersectionObserverInit
  elements: Set<Element>
  disconnected: boolean
  observe: (element: Element) => void
  unobserve: (element: Element) => void
  disconnect: () => void
  trigger: (isIntersecting?: boolean) => void
}

export const ioState = {
  instances: [] as MockIntersectionObserverInstance[],
}

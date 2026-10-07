/**
 * Leaf module holding the mock instances shared by the Collection masthead
 * suites (`Collection.masthead.test.tsx` and `Collection.masthead-counts.test.tsx`).
 *
 * It must not import any application code and it registers no mocks: each suite
 * hoists its own `vi.mock` factories and reads these instances from a module-scope
 * import. The instances live in a leaf rather than in a suite because `vi.hoisted`
 * state is per-module — a helper that calls `vi.hoisted` owns a DIFFERENT instance
 * than the suite mocking against it.
 */
import { vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  loadPublicCollectionSnapshot: vi.fn(),
  recordPublicCollectionInsightEvent: vi.fn(),
  getPublicProfilePage: vi.fn(),
  isFollowingProfile: vi.fn(),
  followProfile: vi.fn(),
  unfollowProfile: vi.fn(),
  abandonFollowIntent: vi.fn(),
  getCollectionFollowState: vi.fn(),
  followCollection: vi.fn(),
  unfollowCollection: vi.fn(),
  abandonCollectionFollowIntent: vi.fn(),
  toast: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}))

type MockIntersectionObserverInstance = {
  callback: IntersectionObserverCallback
  options?: IntersectionObserverInit
  elements: Set<Element>
  disconnected: boolean
  observe: (element: Element) => void
  unobserve: (element: Element) => void
  disconnect: () => void
  trigger: (isIntersecting?: boolean) => void
}

const ioState = vi.hoisted(() => ({
  instances: [] as MockIntersectionObserverInstance[],
}))

export { mocks, ioState }
export type { MockIntersectionObserverInstance }

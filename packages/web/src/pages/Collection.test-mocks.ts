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
  /* R7-07 save-to-library flow */
  loadEditorSnapshot: vi.fn(),
  createCollectionNode: vi.fn(),
  /* CS-03 community comments panel (same resolved target) */
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

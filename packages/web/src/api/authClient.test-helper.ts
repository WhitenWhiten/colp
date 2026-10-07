/**
 * Shared harness for authClient unit tests. Not production code.
 */
import { afterEach, beforeEach, vi } from 'vitest'
import {
  createMemorySessionStorage,
  installSessionStorage,
  resetProductSession,
} from './test-helpers'

export type AuthClientTestHarness = {
  restoreFetch: (() => void) | undefined
}

function installLocation(origin: string): () => void {
  const g = globalThis as typeof globalThis & { location?: { origin: string } }
  const previous = g.location
  Object.defineProperty(g, 'location', {
    configurable: true,
    value: { origin },
  })
  return () => {
    if (previous === undefined) {
      Object.defineProperty(g, 'location', { configurable: true, value: undefined })
    } else {
      Object.defineProperty(g, 'location', { configurable: true, value: previous })
    }
  }
}

function installLocalStorage(storage: Storage): () => void {
  const g = globalThis as typeof globalThis & { localStorage?: Storage }
  const previous = g.localStorage
  Object.defineProperty(g, 'localStorage', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: storage,
  })
  return () => {
    if (previous === undefined) {
      Object.defineProperty(g, 'localStorage', {
        configurable: true,
        value: undefined,
      })
    } else {
      g.localStorage = previous
    }
  }
}

export function authenticatedSessionBody(csrfToken: string) {
  return {
    authenticated: true,
    csrfToken,
    idleExpiresAt: '2026-07-25T00:00:00.000Z',
    absoluteExpiresAt: '2026-07-26T00:00:00.000Z',
  }
}

export function installAuthClientTestLifecycle(): AuthClientTestHarness {
  const harness: AuthClientTestHarness = { restoreFetch: undefined }
  let restoreLocation: () => void
  let restoreStorage: () => void
  let restoreLocalStorage: () => void

  beforeEach(() => {
    vi.stubEnv('VITE_MOCK_SESSION', 'false')
    restoreLocation = installLocation('http://localhost')
    restoreStorage = installSessionStorage(createMemorySessionStorage())
    restoreLocalStorage = installLocalStorage(createMemorySessionStorage())
    harness.restoreFetch = undefined
    resetProductSession()
  })

  afterEach(() => {
    harness.restoreFetch?.()
    restoreLocalStorage()
    restoreStorage()
    restoreLocation()
    resetProductSession()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  return harness
}

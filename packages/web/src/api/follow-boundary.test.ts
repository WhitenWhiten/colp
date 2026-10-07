/* P5-06 Follow boundary.
 *
 * Behaviour: the follower read and the follow/unfollow mutations are driven
 * through the real canonical client with `fetch` mocked, so the generated
 * runtime is what actually answers — the route, the pagination query, the
 * credentials and the mutation command id are observed, not read off the
 * source text.
 *
 * Architecture: the remaining claim is an absent import — the web tree must
 * bridge the generated Follow runtime rather than duplicating Follow DTOs or
 * spelling the Follow routes itself. An unused import changes no observable
 * behaviour, so it is asserted against the module specifier and the route
 * literal instead of an arbitrary substring of formatting.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FollowRelation } from './types'
import { productClient } from './productClient'
import productClientSource from './productClient.ts?raw'
import { isFollowExposureEnabled, isLive } from './featureFlags'
import featureFlagsSource from './featureFlags.ts?raw'
import {
  createMemorySessionStorage, installFetchMock, installSessionStorage, jsonResponse,
  requestHeaders, requestMethod, requestPathAndSearch, resetProductSession, seedAuthenticatedSession,
} from './test-helpers'

const clientDomainSources = Object.values(import.meta.glob('./product-client-*.ts', {
  eager: true,
  import: 'default',
  query: '?raw',
})) as string[]
const clientSources = [productClientSource, ...clientDomainSources].join('\n')

const follower = { profileId: 'profile-2', handle: 'kai', displayName: 'Kai', avatarUrl: null }
const relation: FollowRelation = {
  actorProfileId: 'profile-1', targetProfileId: 'profile-2', following: true,
  changedAt: '2026-07-29T08:00:00.000Z',
}

describe('P5-06 Follow boundary', () => {
  let restoreStorage: () => void
  let restoreFetch: (() => void) | undefined

  beforeEach(() => {
    restoreStorage = installSessionStorage(createMemorySessionStorage())
    resetProductSession()
    seedAuthenticatedSession('csrf-follow-boundary')
  })
  afterEach(() => {
    restoreFetch?.()
    restoreStorage()
    resetProductSession()
  })

  describe('generated runtime behaviour', () => {
    it('reads a follower page from the generated followers route', async () => {
      const mock = installFetchMock(() => jsonResponse({ items: [follower], nextCursor: 'cursor-2' }))
      restoreFetch = mock.restore
      await expect(productClient.getFollowersPage('profile-1', { limit: 20 }, { maxRetries: 0 }))
        .resolves.toEqual({ items: [follower], nextCursor: 'cursor-2' })
      expect(mock.calls).toHaveLength(1)
      const { pathname, searchParams } = requestPathAndSearch(mock.calls[0]!)
      expect(pathname).toBe('/api/v1/profiles/profile-1/followers')
      expect(searchParams.get('limit')).toBe('20')
      expect(mock.calls[0]!.init).toMatchObject({ credentials: 'include' })
    })

    it('follows and unfollows on the generated follow route with a command id', async () => {
      const mock = installFetchMock(() => jsonResponse(relation))
      restoreFetch = mock.restore
      await productClient.followProfile('profile-2', { intentId: 'follow-intent', maxRetries: 0 })
      await productClient.unfollowProfile('profile-2', { intentId: 'unfollow-intent', maxRetries: 0 })
      expect(mock.calls.map(requestMethod)).toEqual(['PUT', 'DELETE'])
      for (const call of mock.calls) {
        expect(requestPathAndSearch(call).pathname).toBe('/api/v1/profiles/profile-2/follow')
        expect(requestHeaders(call).get('known-command-id')).toBeTruthy()
        expect(requestHeaders(call).get('x-csrf-token')).toBe('csrf-follow-boundary')
      }
      /* Distinct intents never share a command id. */
      expect(requestHeaders(mock.calls[0]!).get('known-command-id'))
        .not.toBe(requestHeaders(mock.calls[1]!).get('known-command-id'))
    })
  })

  describe('architecture invariants that cannot be behaviour tested', () => {
    it('keeps Follow exposure live after P5-07 acceptance', () => {
      /* Behavioural half: the switch the surfaces call really is on. */
      expect(isLive('follow')).toBe(true)
      expect(isFollowExposureEnabled()).toBe(true)
      expect(featureFlagsSource).toMatch(/follow:\s*true/u)
      expect(featureFlagsSource).toContain('P5-07')
    })

    it('bridges the P5-05 generated runtime rather than copying Follow routes or DTOs', () => {
      /* The web tree imports the generated runtime… */
      expect(clientSources).toMatch(/from\s+['"]@known\/product-v1-client['"]/u)
      expect(clientSources).toContain('createProductFollowClient')
      /* …and never spells the Follow routes or hand-rolls the request: the
         generated runtime owns endpoint identity. */
      expect(clientSources).not.toMatch(/\/api\/v1\/profiles/u)
      expect(clientSources).not.toMatch(/\bfetch\s*\([^)]*\/follow/u)
    })
  })
})

// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { productClient } from './productClient'
import { installFetchMock } from './test-helpers'

describe('resolveCommunityTarget (R15-29)', () => {
  let restore: (() => void) | undefined
  afterEach(() => restore?.())

  it('shares one in-flight read per target and lets each caller abort its own wait', async () => {
    const pending: Array<() => void> = []
    const mock = installFetchMock(() => new Promise<Response>((_resolve, reject) => {
      pending.push(() => reject(new TypeError('network down')))
    }))
    restore = mock.restore
    const query = { kind: 'collection' as const, id: 'col-1' }
    const vote = new AbortController()

    const fromVote = productClient.resolveCommunityTarget(query, { maxRetries: 0, signal: vote.signal })
    const fromComments = productClient.resolveCommunityTarget(query, { maxRetries: 0 })
    const other = productClient.resolveCommunityTarget({ kind: 'collection', id: 'col-2' }, { maxRetries: 0 })
    await Promise.resolve()
    expect(mock.calls).toHaveLength(2)

    vote.abort()
    await expect(fromVote).rejects.toMatchObject({ name: 'AbortError' })

    for (const reject of pending.splice(0)) reject()
    await expect(fromComments).rejects.toBeTruthy()
    await expect(other).rejects.toBeTruthy()

    // Settled reads are not cached: the next resolve goes to the network.
    const again = productClient.resolveCommunityTarget(query, { maxRetries: 0 })
    await Promise.resolve()
    expect(mock.calls).toHaveLength(3)
    for (const reject of pending.splice(0)) reject()
    await expect(again).rejects.toBeTruthy()
  })
})

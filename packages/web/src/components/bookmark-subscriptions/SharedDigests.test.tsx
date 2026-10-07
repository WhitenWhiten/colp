// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, mountTree, waitForDom } from '../../test/render'
import { SharedDigests } from './SharedDigests'

const mocks = vi.hoisted(() => ({ getSharedMemberDigests: vi.fn() }))
vi.mock('../../api/memberDigestClient', () => ({ getSharedMemberDigests: mocks.getSharedMemberDigests }))
vi.mock('./SubscribeButton', () => ({ SubscribeButton: () => null }))

describe('SharedDigests', () => {
  afterEach(() => { cleanup(); mocks.getSharedMemberDigests.mockReset() })

  it('shows a load failure as an alert EmptyState with Try again', async () => {
    mocks.getSharedMemberDigests.mockRejectedValue(new Error('down'))
    mountTree(<MemoryRouter><SharedDigests /></MemoryRouter>)
    await waitForDom(() => document.querySelector('[role="alert"]') !== null)
    const alert = document.querySelector('[role="alert"]')!
    expect(alert.textContent).toContain("Couldn't load shared digests")
    mocks.getSharedMemberDigests.mockResolvedValue({ items: [{ sourceType: 'digest_series', sourceId: 's1', title: 'Shared weekly', owner: null, openUrl: '', visibility: 'private' }], nextCursor: null })
    const retry = [...alert.querySelectorAll('button')].find((button) => button.textContent === 'Try again')!
    await act(async () => { retry.click() })
    await waitForDom(() => document.body.textContent?.includes('Shared weekly') === true)
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })
})

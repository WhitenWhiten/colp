// @vitest-environment happy-dom
import { act, useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { OwnedCollectionListItem } from '../../api'
import { clearSession } from '../../api/sessionStore'
import { clearRouteCache } from '../../lib/routeCache'
import { cleanup, mountTree, waitForDom } from '../../test/render'
import { useLibraryDeskOrder } from './ordering'

const mocks = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), error: vi.fn() }))
vi.mock('../../api', async original => ({
  ...await original<typeof import('../../api')>(),
  productClient: { getMyLibraryOrder: mocks.get, updateMyLibraryOrder: mocks.update,
    newCommandId: () => 'command', mutationIntentKey: () => 'shared-order', subscribeSession: () => () => {} },
}))
const items = ['first', 'second'].map(id => ({ collection: { id, title: id } } as OwnedCollectionListItem))
function Harness() {
  const [, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const order = useLibraryDeskOrder({ isLoggedIn: true, bootstrapping: false, error: mocks.error,
    sharedSidebarItems: items, setExpanded })
  return <>
    <span data-testid="shared-order">{order.orderedSharedItems.map(item => item.collection.id).join(',')}</span>
    <button onClick={() => order.beginReorder('shared')}>Reorder shared</button>
    <button onClick={() => order.setSectionIds('shared', ['second', 'first'])}>Second first</button>
    <button onClick={() => order.finishReorder()}>Done</button>
  </>
}
function click(label: string) { act(() => [...document.querySelectorAll('button')].find(button => button.textContent === label)!.click()) }
function order() { return document.querySelector('[data-testid="shared-order"]')?.textContent }
beforeEach(() => {
  vi.clearAllMocks(); clearSession(); clearRouteCache()
  mocks.get.mockResolvedValue({ sections: { mine: ['obsolete-owned-order'], shared: ['first', 'second', 'unloaded'] } })
  mocks.update.mockResolvedValue({})
})
afterEach(cleanup)
it('restores saved Shared with you order independently of obsolete owned order', async () => {
  mocks.get.mockResolvedValue({ sections: { mine: ['second', 'first'], shared: ['second', 'first'] } })
  mountTree(<Harness />)
  await waitForDom(() => order() === 'second,first')
  expect(mocks.update).not.toHaveBeenCalled()
})
it('persists Shared with you reordering and retains ranks for unloaded shared rows', async () => {
  mountTree(<Harness />)
  await waitForDom(() => mocks.get.mock.calls.length > 0)
  click('Reorder shared'); click('Second first'); click('Done')
  await waitForDom(() => mocks.update.mock.calls.length === 1)
  expect(order()).toBe('second,first')
  expect(mocks.update).toHaveBeenCalledWith('shared', { collectionIds: ['second', 'first', 'unloaded'] }, expect.anything())
})
it('rolls back a failed Shared with you order write and reports the failure', async () => {
  mocks.update.mockRejectedValue(new Error('offline'))
  mountTree(<Harness />)
  await waitForDom(() => mocks.get.mock.calls.length > 0)
  click('Reorder shared'); click('Second first'); click('Done')
  await waitForDom(() => mocks.error.mock.calls.length === 1)
  expect(order()).toBe('first,second')
})

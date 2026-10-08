// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import pickerSource from './SaveFolderPicker.tsx?raw'
import { SaveFolderPicker } from './SaveFolderPicker'
import { cleanup, mountTree } from '../test/render'

const mocks = vi.hoisted(() => ({
  owned: {
    items: [] as Array<{
      collection: { id: string; title: string }
      capabilities: Record<string, boolean>
      bookmarkCount?: number
    }>,
    state: 'ready' as 'loading' | 'ready' | 'error',
    message: 'Sign in to view your collections',
    hasMore: false,
    isLoadingMore: false,
    reload: async () => undefined,
    loadMore: async () => undefined,
  },
  saveResource: vi.fn(),
}))

vi.mock('../lib/useOwnedCollections', () => ({
  useOwnedCollections: () => mocks.owned,
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    productClient: { ...actual.productClient, saveResource: mocks.saveResource },
  }
})

function setOwned(
  items: Array<{ id: string; title: string; bookmarkCount?: number }>,
  extras?: Partial<Pick<typeof mocks.owned, 'state' | 'message'>>,
) {
  mocks.owned.items = items.map((item) => ({
    collection: { id: item.id, title: item.title },
    capabilities: {},
    bookmarkCount: item.bookmarkCount,
  }))
  mocks.owned.state = extras?.state ?? 'ready'
  mocks.owned.message = extras?.message ?? `${items.length} collections`
}

/* Two different kinds of claim live in this file and they are kept apart:
 *
 * 1. Behaviour — the picker renders only the caller's owned collections, marks
 *    the current one, calls `onPick(title)`, and never saves by itself. Driven
 *    through the real component with `useOwnedCollections` and the Product
 *    client mocked.
 *
 * 2. Architecture — the legacy folder fixtures (`myFolders` / `userFolders`,
 *    the hardcoded `Unsorted` bucket) are *unreferenced* in the module. An
 *    unused fixture changes nothing a render can observe, so it cannot be
 *    falsified by running code; the identifier check is kept for that, and the
 *    reachable half of the same claim is proven behaviourally above.
 */
describe('SaveFolderPicker behaviour', () => {

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true
    mocks.saveResource.mockReset()
    setOwned([], { state: 'ready', message: 'Sign in to view your collections' })
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  function renderPicker(props: Partial<Parameters<typeof SaveFolderPicker>[0]> = {}) {
    const onPick = props.onPick ?? vi.fn()
    mountTree(
        <MemoryRouter initialEntries={['/']}>
          <SaveFolderPicker
            resourceTitle="Suggested reading path"
            onCancel={() => {}}
            {...props}
            onPick={onPick}
          />
        </MemoryRouter>,
      )
    return { onPick }
  }

  it('marks the current owned collection selected and tells the user to click a row', () => {
    setOwned([
      { id: 'col-llm', title: 'LLM learning path', bookmarkCount: 4 },
      { id: 'col-research', title: 'Research notes', bookmarkCount: 12 },
    ])
    const { onPick } = renderPicker({ currentFolder: 'Research notes' })
    expect(document.body.textContent).toContain('Click a folder to shortlist')
    const selected = document.querySelector('[role="option"][aria-selected="true"]')
    expect(selected).not.toBeNull()
    expect(selected?.getAttribute('aria-selected')).toBe('true')
    expect(selected?.textContent).toMatch(/Research notes/)
    expect(onPick).not.toHaveBeenCalled()
  })

  it('calls onPick with the owned collection title and never saveResource', () => {
    setOwned([
      { id: 'col-llm', title: 'LLM learning path', bookmarkCount: 4 },
      { id: 'col-research', title: 'Research notes' },
    ])
    const { onPick } = renderPicker()
    const options = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    expect(options).toHaveLength(2)
    expect(options[0]?.textContent).toMatch(/LLM learning path/)
    expect(options[1]?.textContent).toMatch(/Research notes/)
    act(() => options[0]?.click())
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick).toHaveBeenCalledWith('LLM learning path')
    expect(mocks.saveResource).not.toHaveBeenCalled()
  })

  it('moves focus between folder options with arrow keys', () => {
    setOwned([
      { id: 'col-llm', title: 'LLM learning path' },
      { id: 'col-research', title: 'Research notes' },
      { id: 'col-papers', title: 'Papers' },
    ])
    renderPicker()
    const options = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    expect(options).toHaveLength(3)
    act(() => options[0]!.focus())
    act(() => options[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
    expect(document.activeElement).toBe(options[1])
    act(() => options[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
    expect(document.activeElement).toBe(options[2])
    act(() => options[2]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
    expect(document.activeElement).toBe(options[0])
    act(() => options[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })))
    expect(document.activeElement).toBe(options[2])
    act(() => options[2]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })))
    expect(document.activeElement).toBe(options[0])
  })

  it('shows EmptyState when signed out and does not list Design systems', () => {
    setOwned([], { state: 'ready', message: 'Sign in to view your collections' })
    renderPicker()
    expect(document.body.textContent).toContain('Sign in to view your collections')
    expect(document.body.textContent).not.toContain('Design systems')
    expect(document.body.textContent).not.toContain('Reading later')
    expect(document.querySelector('[role="option"]')).toBeNull()
    expect(document.querySelector('[role="status"]')).not.toBeNull()
    expect(document.querySelector('a[href="/library/new"]')).toBeNull()
    expect(mocks.saveResource).not.toHaveBeenCalled()
  })

  it('uses EmptyState for loading, error, and an empty owned list', () => {
    setOwned([], { state: 'loading', message: 'Loading collections' })
    renderPicker()
    expect(document.querySelector('[role="status"]')).not.toBeNull()
    expect(document.body.textContent).toContain('Loading collections')
    expect(document.querySelector('[role="option"]')).toBeNull()

    setOwned([], { state: 'error', message: "Couldn't load collections" })
    renderPicker()
    expect(document.querySelector('[role="alert"]')).not.toBeNull()
    expect(document.body.textContent).toContain("Couldn't load collections")

    setOwned([], { state: 'ready', message: 'No collections yet' })
    renderPicker()
    expect(document.body.textContent).toContain('No collections yet')
    expect(document.body.textContent).not.toContain('Unsorted')
    expect(document.querySelector('[role="option"]')).toBeNull()
  })

  it('offers a New collection link when the owned list is empty for a signed-in user', () => {
    setOwned([], { state: 'ready', message: 'No collections yet' })
    renderPicker()
    const create = document.querySelector<HTMLAnchorElement>('a[href="/library/new"]')
    expect(create).not.toBeNull()
    expect(create?.textContent?.trim()).toBe('New collection')

    setOwned([], { state: 'loading', message: 'Loading collections' })
    renderPicker()
    expect(document.querySelector('a[href="/library/new"]')).toBeNull()
  })
})

describe('architecture invariants that cannot be behaviour tested', () => {
  it('keeps the legacy folder fixtures and any direct save call out of the picker', () => {
    /* `myFolders` / `userFolders` were the seeded option sources and `Unsorted`
       the hardcoded fallback bucket; both were removed, and their return would
       be invisible until the seeded branch is actually taken. `saveResource`
       would be a second, silent write path beside `onPick` — proven not taken
       behaviourally above, and proven not referenced here. Word boundaries so
       an unrelated longer identifier cannot keep this green. */
    /* Non-vacuity: a `?raw` import that silently resolved to an empty string
       would make every absence check below pass while scanning nothing. */
    expect(pickerSource.length).toBeGreaterThan(3000)
    expect(pickerSource).not.toMatch(/\bmyFolders\b/)
    expect(pickerSource).not.toMatch(/\buserFolders\b/)
    expect(pickerSource).not.toMatch(/\bsaveResource\b/)
    expect(pickerSource).not.toMatch(/\bUnsorted\b/)
    /* The picker must reach the client through the shared barrel, never a
       private transport module (module specifier, not formatting). */
    expect(pickerSource).not.toMatch(/from ['"][^'"]*(?:productClient|product-transport|legacy-demo|mock-data)['"]/)
  })
})

// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditableNodeView, OwnedCollectionListItem } from '../api/types'
import { CollectionDestinationPicker } from './CollectionDestinationPicker'
import { cleanup, mountTree, waitForDom } from '../test/render'

const mocks = vi.hoisted(() => ({
  loadEditorSnapshot: vi.fn(),
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    productClient: {
      ...actual.productClient,
      loadEditorSnapshot: mocks.loadEditorSnapshot,
    },
  }
})

function folderNode(
  id: string,
  title: string,
  parentId: string,
  position: string,
  collectionId = 'col-x',
): EditableNodeView {
  return {
    id,
    collectionId,
    kind: 'folder',
    folderRole: null,
    parentId,
    position,
    title,
    description: null,
    tags: [],
    visibility: 'inherit',
    revision: '1',
    etag: `"${id}"`,
    readOnly: false,
    readOnlyReason: null,
    childrenRevision: '1',
    childrenEtag: `"${id}-c"`,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  }
}

function bookmarkNode(
  id: string,
  title: string,
  parentId: string,
  position: string,
  collectionId = 'col-x',
): EditableNodeView {
  return {
    id,
    collectionId,
    kind: 'bookmark',
    parentId,
    position,
    title,
    url: `https://${id}.example`,
    description: null,
    tags: [],
    visibility: 'inherit',
    revision: '1',
    etag: `"${id}"`,
    readOnly: false,
    readOnlyReason: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  }
}

function collectionItem(id: string, title: string, createNode: boolean): OwnedCollectionListItem {
  return {
    collection: {
      id,
      kind: 'bookmarks',
      title,
      summary: null,
      visibility: 'private',
      allowSearchIndexing: false,
      publicationSlug: null,
      publishedAt: null,
      rootNodeId: `root-${id}`,
      revision: '1',
      etag: `"c-${id}"`,
      contentRevision: '1',
      contentEtag: `"cc-${id}"`,
      policyRevision: '1',
      policyEtag: `"p-${id}"`,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    },
    capabilities: {
      updateCollection: false,
      managePublication: false,
      createNode,
      updateNode: false,
      moveNode: false,
      deleteNode: false,
    },
  }
}

function destinationButtons() {
  return [...document.querySelectorAll<HTMLButtonElement>('[data-testid="destination-option"]')]
}

function destinationLabels() {
  return destinationButtons().map((button) => button.textContent?.trim())
}

function clickDestination(label: string) {
  act(() => {
    destinationButtons().find((button) => button.textContent?.includes(label))?.click()
  })
}

describe('CollectionDestinationPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })
  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  it('locks move mode to the current collection and lists nested folders', () => {
    const onPick = vi.fn()
    mountTree(
      <MemoryRouter>
        <CollectionDestinationPicker
          mode="move"
          count={2}
          current={{
            collection: { id: 'col-x', title: 'Reading queue' },
            rootId: 'root-x',
            nodes: [
              folderNode('f-1', 'Later', 'root-x', 'a'),
              folderNode('f-2', 'Deep dive', 'f-1', 'a'),
              bookmarkNode('b-1', 'Some link', 'root-x', 'b'),
            ],
          }}
          owned={[collectionItem('col-other', 'Another shelf', true)]}
          onPick={onPick}
          onClose={() => {}}
        />
      </MemoryRouter>,
    )
    const picker = document.querySelector('[data-testid="destination-picker"]')
    expect(picker?.getAttribute('data-mode')).toBe('move')
    expect(picker?.textContent).toContain('Reading queue')
    // Locked: owned collections are never offered as move destinations.
    expect(picker?.textContent).not.toContain('Another shelf')
    expect(destinationLabels()).toEqual(['Top level', 'Later', 'Deep dive'])
    expect(document.querySelector('[aria-label="Folders in Reading queue"]')).not.toBeNull()
    clickDestination('Deep dive')
    expect(onPick).toHaveBeenCalledWith({
      collectionId: 'col-x',
      parentId: 'f-2',
      collectionTitle: 'Reading queue',
      parentTitle: 'Deep dive',
    })
    expect(mocks.loadEditorSnapshot).not.toHaveBeenCalled()
  })

  it('names a moved folder "folder" instead of "bookmark"', () => {
    mountTree(
      <MemoryRouter>
        <CollectionDestinationPicker
          mode="move"
          count={1}
          noun="folder"
          current={{
            collection: { id: 'col-x', title: 'Reading queue' },
            rootId: 'root-x',
            nodes: [folderNode('f-1', 'Later', 'root-x', 'a')],
          }}
          onPick={() => {}}
          onClose={() => {}}
        />
      </MemoryRouter>,
    )
    expect(document.querySelector('[data-testid="destination-picker"]')?.textContent)
      .toContain('Move 1 folder within')
  })

  it('picks the top level of the locked collection in move mode', () => {
    const onPick = vi.fn()
    mountTree(
      <MemoryRouter>
        <CollectionDestinationPicker
          mode="move"
          count={1}
          current={{
            collection: { id: 'col-x', title: 'Reading queue' },
            rootId: 'root-x',
            nodes: [folderNode('f-1', 'Later', 'root-x', 'a')],
          }}
          onPick={onPick}
          onClose={() => {}}
        />
      </MemoryRouter>,
    )
    clickDestination('Top level')
    expect(onPick).toHaveBeenCalledWith({
      collectionId: 'col-x',
      parentId: 'root-x',
      collectionTitle: 'Reading queue',
      parentTitle: null,
    })
  })

  it('disables and flags the current parent in move mode', () => {
    const onPick = vi.fn()
    mountTree(
      <MemoryRouter>
        <CollectionDestinationPicker
          mode="move"
          count={1}
          current={{
            collection: { id: 'col-x', title: 'Reading queue' },
            rootId: 'root-x',
            nodes: [
              folderNode('f-1', 'Later', 'root-x', 'a'),
              folderNode('f-2', 'Deep dive', 'f-1', 'a'),
            ],
          }}
          currentParentId="f-1"
          onPick={onPick}
          onClose={() => {}}
        />
      </MemoryRouter>,
    )
    const current = destinationButtons().find((button) => button.textContent?.includes('Later'))
    expect(current?.disabled).toBe(true)
    expect(current?.textContent).toContain('(current)')
    const top = destinationButtons().find((button) => button.textContent?.includes('Top level'))
    expect(top?.disabled).toBe(false)
    expect(top?.textContent).not.toContain('(current)')
    clickDestination('Later')
    expect(onPick).not.toHaveBeenCalled()
    clickDestination('Deep dive')
    expect(onPick).toHaveBeenCalledWith({
      collectionId: 'col-x',
      parentId: 'f-2',
      collectionTitle: 'Reading queue',
      parentTitle: 'Deep dive',
    })
  })

  it('flags a root-level current parent on the Top level option', () => {
    const onPick = vi.fn()
    mountTree(
      <MemoryRouter>
        <CollectionDestinationPicker
          mode="move"
          count={1}
          current={{
            collection: { id: 'col-x', title: 'Reading queue' },
            rootId: 'root-x',
            nodes: [folderNode('f-1', 'Later', 'root-x', 'a')],
          }}
          currentParentId="root-x"
          onPick={onPick}
          onClose={() => {}}
        />
      </MemoryRouter>,
    )
    const top = destinationButtons().find((button) => button.textContent?.includes('Top level'))
    expect(top?.disabled).toBe(true)
    expect(top?.textContent).toContain('(current)')
    clickDestination('Top level')
    expect(onPick).not.toHaveBeenCalled()
  })

  it('never offers a moved folder or anything inside it as a destination', () => {
    const onPick = vi.fn()
    mountTree(
      <MemoryRouter>
        <CollectionDestinationPicker
          mode="move"
          count={1}
          current={{
            collection: { id: 'col-x', title: 'Reading queue' },
            rootId: 'root-x',
            nodes: [
              folderNode('f-1', 'Later', 'root-x', 'a'),
              folderNode('f-2', 'Deep dive', 'f-1', 'a'),
              folderNode('f-3', 'Deeper still', 'f-2', 'a'),
              folderNode('f-4', 'Sibling', 'root-x', 'b'),
              bookmarkNode('b-1', 'Some link', 'f-2', 'a'),
            ],
          }}
          currentParentId="root-x"
          movingIds={['f-1']}
          onPick={onPick}
          onClose={() => {}}
        />
      </MemoryRouter>,
    )
    // The moved folder and its whole subtree are gone; the root entry stays
    // (disabled as the current parent) and the sibling folder remains valid.
    expect(destinationLabels()).toEqual(['Top level(current)', 'Sibling'])
  })

  it('moving a bookmark excludes nothing — bookmarks can never be parents', () => {
    const onPick = vi.fn()
    mountTree(
      <MemoryRouter>
        <CollectionDestinationPicker
          mode="move"
          count={1}
          current={{
            collection: { id: 'col-x', title: 'Reading queue' },
            rootId: 'root-x',
            nodes: [
              folderNode('f-1', 'Later', 'root-x', 'a'),
              bookmarkNode('b-1', 'Some link', 'root-x', 'b'),
            ],
          }}
          movingIds={['b-1']}
          onPick={onPick}
          onClose={() => {}}
        />
      </MemoryRouter>,
    )
    expect(destinationLabels()).toEqual(['Top level', 'Later'])
  })

  it('moving several folders excludes each subtree', () => {
    const onPick = vi.fn()
    mountTree(
      <MemoryRouter>
        <CollectionDestinationPicker
          mode="move"
          count={2}
          current={{
            collection: { id: 'col-x', title: 'Reading queue' },
            rootId: 'root-x',
            nodes: [
              folderNode('f-1', 'Later', 'root-x', 'a'),
              folderNode('f-2', 'Deep dive', 'f-1', 'a'),
              folderNode('f-3', 'Sibling', 'root-x', 'b'),
              folderNode('f-4', 'Remaining', 'root-x', 'c'),
            ],
          }}
          movingIds={['f-1', 'f-3']}
          onPick={onPick}
          onClose={() => {}}
        />
      </MemoryRouter>,
    )
    expect(destinationLabels()).toEqual(['Top level', 'Remaining'])
  })

  it('disables nothing when a mixed selection has no shared parent', () => {
    const onPick = vi.fn()
    mountTree(
      <MemoryRouter>
        <CollectionDestinationPicker
          mode="move"
          count={2}
          current={{
            collection: { id: 'col-x', title: 'Reading queue' },
            rootId: 'root-x',
            nodes: [folderNode('f-1', 'Later', 'root-x', 'a')],
          }}
          currentParentId={null}
          onPick={onPick}
          onClose={() => {}}
        />
      </MemoryRouter>,
    )
    for (const button of destinationButtons()) {
      expect(button.disabled).toBe(false)
      expect(button.textContent).not.toContain('(current)')
    }
  })

  it('lists owned plus createNode shared collections in copy mode and filters the rest', async () => {
    mocks.loadEditorSnapshot.mockResolvedValue({
      root: { id: 'root-col-b' },
      nodes: [folderNode('fb-1', 'Inbox', 'root-col-b', 'a', 'col-b')],
    })
    const onPick = vi.fn()
    mountTree(
      <MemoryRouter>
        <CollectionDestinationPicker
          mode="copy"
          count={3}
          owned={[collectionItem('col-a', 'My shelf', true)]}
          shared={[
            collectionItem('col-b', 'Team docs', true),
            collectionItem('col-c', 'Read only share', false),
          ]}
          onPick={onPick}
          onClose={() => {}}
        />
      </MemoryRouter>,
    )
    expect(document.body.textContent).toContain('Copies the link, title and note')
    expect(destinationLabels()).toEqual(['My shelf', 'Team docs'])
    expect(document.body.textContent).not.toContain('Read only share')

    clickDestination('Team docs')
    expect(mocks.loadEditorSnapshot).toHaveBeenCalledWith('col-b', expect.anything())
    await waitForDom(() => destinationButtons().some((button) => button.textContent?.includes('Inbox')))
    expect(destinationLabels()).toEqual(['All collections', 'Top level', 'Inbox'])
    clickDestination('Inbox')
    expect(onPick).toHaveBeenCalledWith({
      collectionId: 'col-b',
      parentId: 'fb-1',
      collectionTitle: 'Team docs',
      parentTitle: 'Inbox',
    })
  })

  it('shows a loading state while the target tree loads', async () => {
    let resolveSnapshot: (value: unknown) => void = () => {}
    mocks.loadEditorSnapshot.mockImplementation(
      () => new Promise((resolve) => { resolveSnapshot = resolve }),
    )
    mountTree(
      <MemoryRouter>
        <CollectionDestinationPicker
          mode="copy"
          count={1}
          owned={[collectionItem('col-a', 'My shelf', true)]}
          onPick={() => {}}
          onClose={() => {}}
        />
      </MemoryRouter>,
    )
    clickDestination('My shelf')
    expect(document.body.textContent).toContain('Loading folders…')
    await act(async () => {
      resolveSnapshot({ root: { id: 'root-col-a' }, nodes: [] })
      await Promise.resolve()
    })
    expect(document.body.textContent).not.toContain('Loading folders…')
    expect(destinationButtons().some((button) => button.textContent?.includes('Top level'))).toBe(true)
  })

  it('offers a New collection way out when nothing can receive copies', () => {
    mountTree(
      <MemoryRouter>
        <CollectionDestinationPicker
          mode="copy"
          count={1}
          owned={[]}
          shared={[collectionItem('col-c', 'Read only share', false)]}
          onPick={() => {}}
          onClose={() => {}}
        />
      </MemoryRouter>,
    )
    expect(document.body.textContent).toContain('No destination collections')
    expect(document.body.textContent).not.toContain('Read only share')
    const link = document.querySelector<HTMLAnchorElement>('a[href="/library/new"]')
    expect(link?.textContent).toContain('New collection')
  })

  it('picks an owned collection immediately in collection mode without loading folders', () => {
    const onPick = vi.fn()
    mountTree(
      <MemoryRouter>
        <CollectionDestinationPicker
          mode="collection"
          owned={[
            collectionItem('col-a', 'AI links', true),
            collectionItem('col-b', 'Later', false),
          ]}
          shared={[collectionItem('col-c', 'Shared shelf', true)]}
          onPick={onPick}
          onClose={() => {}}
        />
      </MemoryRouter>,
    )
    const picker = document.querySelector('[data-testid="destination-picker"]')
    expect(picker?.getAttribute('data-mode')).toBe('collection')
    expect(destinationLabels().some((label) => label?.includes('AI links'))).toBe(true)
    expect(destinationLabels().some((label) => label?.includes('Later'))).toBe(true)
    expect(destinationLabels().some((label) => label?.includes('Shared shelf'))).toBe(false)
    clickDestination('AI links')
    expect(mocks.loadEditorSnapshot).not.toHaveBeenCalled()
    expect(onPick).toHaveBeenCalledWith({
      collectionId: 'col-a',
      parentId: 'root-col-a',
      collectionTitle: 'AI links',
      parentTitle: null,
    })
  })
})

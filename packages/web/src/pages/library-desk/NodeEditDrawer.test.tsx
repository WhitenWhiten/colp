// @vitest-environment happy-dom
/* FE-04: the node edit drawer. Field/persistence cases mount the drawer
   directly; the entry-point case drives the desk's ⋯ menu end to end. */
import { useState } from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { MemoryRouter, useNavigate } from 'react-router-dom'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnnotationView, EditorSnapshot } from '../../api'
import { domFinishedLoading, waitForDom, cleanup, mountTree } from '../../test/render'
import { NodeEditDrawer } from './NodeEditDrawer'
import {
  clickMenuItem,
  mocks,
  mount,
  openRowMenu,
  setUpLibraryDesk,
  snapshot,
  tearDownLibraryDesk,
} from './LibraryDesk.test-helper'

vi.mock('../../auth/AuthContext', async () => {
  const { mocks } = await import('./LibraryDesk.test-mocks')
  return { useAuth: () => mocks.auth }
})
vi.mock('../../components/AppToast', async () => {
  const { mocks } = await import('./LibraryDesk.test-mocks')
  return { useToast: () => ({ toast: mocks.toast, success: mocks.success, error: mocks.error }) }
})
vi.mock('../../lib/useOwnedCollections', async () => {
  const { mocks } = await import('./LibraryDesk.test-mocks')
  return { useOwnedCollections: () => mocks.collections }
})
vi.mock('../../lib/useSharedCollections', async () => {
  const { mocks } = await import('./LibraryDesk.test-mocks')
  return { useSharedCollections: () => mocks.shared }
})
vi.mock('../../lib/useMyCollaborationInvites', async () => {
  const { mocks } = await import('./LibraryDesk.test-mocks')
  return { useMyCollaborationInvites: () => mocks.invites }
})
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>()
  const { mocks } = await import('./LibraryDesk.test-mocks')
  return {
    ...actual,
    productClient: {
      ...actual.productClient,
      loadEditorSnapshot: mocks.loadEditorSnapshot,
      loadAnnotations: mocks.loadAnnotations,
      loadPublicCollectionSnapshot: mocks.loadPublicCollectionSnapshot,
      createCollectionNode: mocks.createCollectionNode,
      updateCollectionNode: mocks.updateCollectionNode,
      moveCollectionNode: mocks.moveCollectionNode,
      deleteCollectionNode: mocks.deleteCollectionNode,
      createAnnotation: mocks.createAnnotation,
      updateAnnotation: mocks.updateAnnotation,
      deleteAnnotation: mocks.deleteAnnotation,
      getAnnotation: mocks.getAnnotation,
      abandonAnnotationIntent: mocks.abandonAnnotationIntent,
      uploadBookmarkFavicon: mocks.uploadBookmarkFavicon,
      deleteBookmarkFavicon: mocks.deleteBookmarkFavicon,
      getBookmarkFaviconSource: mocks.getBookmarkFaviconSource,
      setBookmarkFaviconSource: mocks.setBookmarkFaviconSource,
      getBookmarkPreviewMode: mocks.getBookmarkPreviewMode,
      setBookmarkPreviewMode: mocks.setBookmarkPreviewMode,
      listFollowedCollections: mocks.listFollowedCollections,
      listFollowedReports: mocks.listFollowedReports,
      listMyReports: mocks.listMyReports,
      getFollowedReportIssuesPage: mocks.getFollowedReportIssuesPage,
      getMyLibraryOrder: mocks.getMyLibraryOrder,
      updateMyLibraryOrder: mocks.updateMyLibraryOrder,
      newCommandId: () => '11111111-1111-4111-8111-111111111111',
      mutationIntentKey: (scope: string, commandId: string) => `${scope}:${commandId}`,
    },
  }
})

const loadTree = vi.fn(async () => undefined)

function faviconSource(overrides: Record<string, unknown> = {}) {
  return {
    collectionId: 'col-1',
    nodeId: 'col-1-loose',
    revision: '1',
    policyRevision: '1',
    sourceMode: 'inherit',
    effectiveMode: 'capture',
    iconUrl: null,
    iconVersion: null,
    directUrl: null,
    status: 'missing',
    restorable: false,
    updatedAt: '2026-07-22T00:00:00.000Z',
    etag: '"favicon-source:col-1-loose:1"',
    ...overrides,
  }
}

function annotation(overrides: Partial<AnnotationView> = {}): AnnotationView {
  return {
    id: 'annotation-tldr-1',
    collectionId: 'col-1',
    subject: { type: 'node', id: 'col-1-loose' },
    type: 'tldr',
    format: 'plain',
    value: 'Existing TL;DR',
    visibility: 'private',
    creator: null,
    provenance: { kind: 'human' },
    revision: 'revision-1',
    createdAt: '2026-07-22T00:00:00.000Z',
    updatedAt: '2026-07-22T00:00:00.000Z',
    extensions: {},
    ...overrides,
  }
}

function DrawerHarness({
  nodeId = 'col-1-loose',
  snap = snapshot(),
}: {
  nodeId?: string
  snap?: EditorSnapshot
}) {
  const [openId, setOpenId] = useState<string | null>(nodeId)
  const navigate = useNavigate()
  return (
    <NodeEditDrawer
      snap={snap}
      nodeId={openId}
      onClose={() => setOpenId(null)}
      loadTree={loadTree}
      navigate={navigate}
      toast={mocks.toast}
      success={mocks.success}
      error={mocks.error}
      refreshSession={mocks.auth.refreshSession}
    />
  )
}

function mountDrawer(options: { nodeId?: string; snap?: EditorSnapshot } = {}) {
  mountTree(
    <MemoryRouter>
      <DrawerHarness {...options} />
    </MemoryRouter>,
  )
}

function control<T extends HTMLInputElement | HTMLTextAreaElement>(id: string): T {
  const element = document.getElementById(id) as T | null
  if (!element) throw new Error(`missing control: ${id}`)
  return element
}

function type(id: string, value: string) {
  const element = control(id)
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  act(() => {
    setter?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function click(testId: string) {
  act(() => {
    document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)?.click()
  })
}

function clickButton(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.textContent?.trim() === label)
  if (!button) throw new Error(`missing button: ${label}`)
  act(() => button.click())
}

/** The two Private/Public groups are told apart by their radiogroup label. */
function setVisibility(label: 'TL;DR' | 'Note', segment: 'Private' | 'Public') {
  const group = document.querySelector(`[role="radiogroup"][aria-label="${label} visibility"]`)
  const button = [...(group?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])]
    .find((candidate) => candidate.textContent === segment)
  if (!button) throw new Error(`missing ${label} ${segment} segment`)
  act(() => button.click())
}

function tagChips(): string[] {
  return [...document.querySelectorAll('[data-testid="tag-chip"]')].map((chip) => chip.textContent ?? '')
}

function keyDown(id: string, key: string) {
  act(() => {
    control(id).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

function drawer(): HTMLElement | null {
  return document.querySelector('[data-testid="node-drawer"]')
}

async function save() {
  clickButton('Save')
  await waitForDom(domFinishedLoading)
}

describe('Node edit drawer', () => {
  beforeEach(() => {
    setUpLibraryDesk()
    loadTree.mockClear()
    mocks.createAnnotation.mockResolvedValue(annotation())
    mocks.updateAnnotation.mockResolvedValue(annotation({ revision: 'revision-2' }))
    mocks.updateCollectionNode.mockResolvedValue({})
    mocks.uploadBookmarkFavicon.mockResolvedValue({})
    mocks.deleteBookmarkFavicon.mockResolvedValue({})
    mocks.getBookmarkFaviconSource.mockResolvedValue(faviconSource())
    mocks.setBookmarkFaviconSource.mockResolvedValue(faviconSource({ revision: '2' }))
    mocks.getBookmarkPreviewMode.mockResolvedValue({ nodeId: 'col-1-loose', mode: 'auto', previewImage: null, etag: '"preview-mode:1"' })
  })
  afterEach(tearDownLibraryDesk)

  it('opens from the row ⋯ menu with the title focused and the node loaded', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    openRowMenu('Loose bookmark')
    clickMenuItem('Edit details')
    await waitForDom(domFinishedLoading)

    expect(drawer()).not.toBeNull()
    expect(drawer()?.getAttribute('aria-modal')).toBe('true')
    expect(drawer()?.getAttribute('aria-labelledby')).toBe('node-drawer-title node-drawer-subject')
    expect(document.getElementById('node-drawer-title')?.textContent).toBe('Bookmark')
    expect(document.getElementById('node-drawer-subject')?.textContent).toBe('Loose bookmark')
    expect(document.activeElement?.id).toBe('nd-title')
    expect(control('nd-title').value).toBe('Loose bookmark')
    expect(control('nd-url').value).toBe('https://loose.example')
    expect(tagChips()).toEqual(['research'])
    expect(control('nd-tags').value).toBe('')
    expect(mocks.loadAnnotations).toHaveBeenCalledWith(
      'col-1',
      { resourceType: 'node', resourceId: 'col-1-loose' },
      expect.objectContaining({ signal: expect.any(AbortSignal), maxRetries: 0 }),
    )
  })

  it('patches the changed node fields with the frozen etag in one payload', async () => {
    mountDrawer()
    type('nd-title', 'Renamed bookmark')
    type('nd-desc', 'Why this one matters')
    type('nd-tags', 'research, reading')
    await save()

    expect(mocks.updateCollectionNode).toHaveBeenCalledTimes(1)
    const [collectionId, nodeId, body, ifMatch, options] = mocks.updateCollectionNode.mock.calls[0]!
    expect(collectionId).toBe('col-1')
    expect(nodeId).toBe('col-1-loose')
    expect(body).toEqual({
      title: 'Renamed bookmark',
      url: 'https://loose.example',
      description: 'Why this one matters',
      tags: ['research', 'reading'],
    })
    expect(ifMatch).toBe('"l-col-1"')
    expect(options).toEqual({ intentId: expect.stringContaining('update-node:col-1-loose') })
    expect(mocks.success).not.toHaveBeenCalled()
    expect(document.querySelector('[data-testid="node-drawer-status"]')?.textContent).toBe('Saved')
  })

  it('creates the TL;DR on first save with the visibility the switch shows', async () => {
    mountDrawer()
    type('nd-tldr', 'A trustworthy one-liner')
    setVisibility('TL;DR', 'Public')
    await save()

    expect(mocks.createAnnotation).toHaveBeenCalledTimes(1)
    const [collectionId, subject, body, options] = mocks.createAnnotation.mock.calls[0]!
    expect(collectionId).toBe('col-1')
    expect(subject).toEqual({ resourceType: 'node', resourceId: 'col-1-loose' })
    expect(body).toMatchObject({ type: 'tldr', format: 'plain', value: 'A trustworthy one-liner', visibility: 'public' })
    expect(options).toMatchObject({ clearIntentOnSuccess: false })
    expect(mocks.updateCollectionNode).not.toHaveBeenCalled()
  })

  it('updates an existing TL;DR against its revision', async () => {
    mocks.loadAnnotations.mockResolvedValue([annotation()])
    mountDrawer()
    await waitForDom(domFinishedLoading)
    expect(control('nd-tldr').value).toBe('Existing TL;DR')

    type('nd-tldr', 'Edited TL;DR')
    await save()

    expect(mocks.updateAnnotation).toHaveBeenCalledTimes(1)
    const [collectionId, annotationId, body, ifMatch] = mocks.updateAnnotation.mock.calls[0]!
    expect(collectionId).toBe('col-1')
    expect(annotationId).toBe('annotation-tldr-1')
    expect(body).toEqual({ value: 'Edited TL;DR', format: 'plain' })
    expect(ifMatch).toBe('"revision-1"')
  })

  it('saves note text and its visibility through the same workflow', async () => {
    mountDrawer()
    type('nd-note', 'Keep this one for the framing')
    setVisibility('Note', 'Public')
    await save()

    expect(mocks.createAnnotation).toHaveBeenCalledTimes(1)
    expect(mocks.createAnnotation.mock.calls[0]![2]).toMatchObject({
      type: 'note',
      value: 'Keep this one for the framing',
      visibility: 'public',
    })
  })

  it('reloads the Gallery snapshot after hiding a preview', async () => {
    mocks.getBookmarkPreviewMode.mockResolvedValue({ nodeId: 'col-1-loose', mode: 'auto', previewImage: null, etag: '"preview-mode:1"' })
    mocks.setBookmarkPreviewMode.mockResolvedValue({ nodeId: 'col-1-loose', mode: 'none', previewImage: null, etag: '"preview-mode:2"' })
    mountDrawer()
    await waitForDom(() => document.querySelector('[data-testid="preview-mode-control"]') !== null)
    await act(async () => document.querySelector<HTMLInputElement>('[data-testid="preview-mode-control"] input[value="none"]')!.click())
    expect(loadTree).toHaveBeenCalledWith('col-1', { silent: true })
  })

  it('edits tags as chips: Enter commits, Backspace removes the last, and a chip has its own remove', async () => {
    mountDrawer()
    type('nd-tags', 'reading')
    keyDown('nd-tags', 'Enter')
    expect(tagChips()).toEqual(['research', 'reading'])
    expect(control('nd-tags').value).toBe('')

    keyDown('nd-tags', 'Backspace')
    expect(tagChips()).toEqual(['research'])

    act(() => document.querySelector<HTMLButtonElement>('[aria-label="Remove tag research"]')!.click())
    expect(tagChips()).toEqual([])
    await save()
    expect(mocks.updateCollectionNode.mock.calls[0]![2]).toMatchObject({ tags: [] })
  })

  it('offers the collection tags while typing and keeps their spelling', async () => {
    mountDrawer({ nodeId: 'col-1-folder' })
    type('nd-tags', 'sear')
    const suggestion = document.querySelector<HTMLButtonElement>('[aria-label="Add tag research"]')
    expect(suggestion).not.toBeNull()
    act(() => suggestion!.click())
    expect(tagChips()).toEqual(['research'])

    // Typed in another case, a known tag still lands as the collection's spelling.
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="Remove tag research"]')!.click())
    type('nd-tags', '#RESEARCH')
    keyDown('nd-tags', 'Enter')
    expect(tagChips()).toEqual(['research'])
  })

  it('hides URL and favicon for a folder and still saves every folder field', async () => {
    mountDrawer({ nodeId: 'col-1-folder' })
    expect(document.getElementById('nd-url')).toBeNull()
    expect(document.getElementById('nd-favicon')).toBeNull()
    expect(control('nd-title').value).toBe('Later')

    type('nd-title', 'Read later')
    type('nd-desc', 'Queue for the weekend')
    type('nd-tags', 'later')
    type('nd-tldr', 'Folder-level takeaway')
    await save()

    expect(mocks.updateCollectionNode).toHaveBeenCalledTimes(1)
    expect(mocks.updateCollectionNode.mock.calls[0]![2]).toEqual({
      title: 'Read later',
      description: 'Queue for the weekend',
      tags: ['later'],
    })
    expect(mocks.createAnnotation.mock.calls[0]![2]).toMatchObject({ type: 'tldr', value: 'Folder-level takeaway' })
  })

  it('sets the bookmark icon source with the server ETag and refreshes', async () => {
    /* Server state, not a call-order queue: reads describe the stored source,
       so StrictMode's remount re-reads the same pre-write revision. The write
       flips the stored source, which is what the refetch must observe. */
    let serverSource = faviconSource()
    mocks.getBookmarkFaviconSource.mockImplementation(() => Promise.resolve(serverSource))
    mocks.setBookmarkFaviconSource.mockImplementation(async () => {
      serverSource = faviconSource({
        revision: '2',
        sourceMode: 'none',
        effectiveMode: 'none',
        etag: '"favicon-source:col-1-loose:2"',
      })
      return serverSource
    })
    mountDrawer()
    await waitForDom(domFinishedLoading)

    const none = document.querySelector('input[value="none"]') as HTMLInputElement | null
    expect(none).not.toBeNull()
    expect((document.querySelector('input[value="inherit"]') as HTMLInputElement).checked).toBe(true)
    const readsBeforeWrite = mocks.getBookmarkFaviconSource.mock.calls.length
    act(() => none!.click())
    await waitForDom(() => (document.querySelector('input[value="none"]') as HTMLInputElement).checked)

    // The control GETs for the server ETag, PUTs with If-Match, then refetches:
    // exactly one further source read lands after the write (the StrictMode
    // remount read is already counted in the baseline), so neither a missing
    // refetch nor a refetch loop passes.
    expect(mocks.getBookmarkFaviconSource.mock.calls.length).toBe(readsBeforeWrite + 1)
    expect(mocks.setBookmarkFaviconSource).toHaveBeenCalledWith(
      'col-1',
      'col-1-loose',
      { sourceMode: 'none' },
      '"favicon-source:col-1-loose:1"',
      expect.objectContaining({
        intentId: expect.stringContaining('set-favicon-source:col-1:col-1-loose'),
        maxRetries: 0,
      }),
    )
    expect((document.querySelector('input[value="none"]') as HTMLInputElement).checked).toBe(true)
    expect((document.querySelector('input[value="inherit"]') as HTMLInputElement).checked).toBe(false)
  })

  it('confirms before discarding unsaved edits on close', async () => {
    mountDrawer()
    type('nd-title', 'Half-typed')
    click('node-drawer-veil')
    // R9-19: the shared danger modal replaces window.confirm — Cancel keeps
    // the drawer open, the destructive action closes it. The drawer itself
    // is a role="dialog", so find the shared modal by its aria-label.
    const dialog = () => document.querySelector('[role="dialog"][aria-label="Close this editor?"]')
    expect(dialog()?.textContent).toContain('unsaved changes to this item')
    expect(drawer()).not.toBeNull()

    clickButton('Cancel')
    expect(drawer()).not.toBeNull()

    click('node-drawer-veil')
    await act(async () => {
      const confirm = [...(dialog()?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
        .find((candidate) => candidate.textContent?.trim() === 'Discard changes')
      if (!confirm) throw new Error('confirm button missing')
      confirm.click()
      await Promise.resolve()
    })
    expect(drawer()).toBeNull()
  })

  it('says why a read-only bookmark cannot be edited and keeps Save off', async () => {
    const snap = snapshot()
    const readOnlySnap = {
      ...snap,
      nodes: snap.nodes.map((node) => node.id === 'col-1-loose'
        ? { ...node, readOnly: true }
        : node),
    }
    mountDrawer({ snap: readOnlySnap })
    await waitForDom(domFinishedLoading)
    expect(drawer()?.textContent).toContain('You can view this bookmark but not edit it.')
    const save = [...(drawer()?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
      .find((button) => button.textContent?.trim() === 'Save')
    expect(save?.disabled).toBe(true)
    expect(control<HTMLInputElement>('nd-title').disabled).toBe(true)
  })

  it('keeps the 719px full-screen sheet rule in the drawer stylesheet', async () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles/library.css'), 'utf8')
    const section = css.slice(css.indexOf('/* ——— Node edit drawer ——— */'))
    const block = section.slice(section.indexOf('@media (max-width: 719px)'))
    const rule = block.slice(block.indexOf('.node-drawer {'), block.indexOf('}', block.indexOf('.node-drawer {')))
    expect(rule).toContain('inset: 0')
    expect(rule).toContain('width: auto')
    expect(rule).toContain('node-drawer-rise')
    // The drawer itself is the right-hand panel outside that breakpoint.
    mountDrawer()
    await waitForDom(domFinishedLoading)
    expect(drawer()?.classList.contains('node-drawer')).toBe(true)
  })

  it('closes on Esc and returns focus to the ⋯ trigger', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="Actions for Loose bookmark"]')
    act(() => trigger?.focus())
    openRowMenu('Loose bookmark')
    clickMenuItem('Edit details')
    await waitForDom(domFinishedLoading)
    expect(document.activeElement?.id).toBe('nd-title')

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    expect(drawer()).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
})

// Keep the import used even when the file runs in isolation.
void cleanup

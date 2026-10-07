// @vitest-environment happy-dom
/* FE-06: the shared Annotation state machine now owns the TL;DR as an
   editable annotation, forwards visibility on create/update, and accepts any
   node id (folder included) as the subject. These cases drive the hook directly
   so the intent/revision contract is pinned without a page in the way. */
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnnotationView } from '../api'
import { useAnnotationWorkflow, type AnnotationSubjectLocator } from './useAnnotationWorkflow'
import { cleanup, mountTree } from '../test/render'

const mocks = vi.hoisted(() => ({
  loadAnnotations: vi.fn(),
  getAnnotation: vi.fn(),
  createAnnotation: vi.fn(),
  updateAnnotation: vi.fn(),
  deleteAnnotation: vi.fn(),
  abandonAnnotationIntent: vi.fn(),
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    productClient: {
      ...actual.productClient,
      loadAnnotations: mocks.loadAnnotations,
      getAnnotation: mocks.getAnnotation,
      createAnnotation: mocks.createAnnotation,
      updateAnnotation: mocks.updateAnnotation,
      deleteAnnotation: mocks.deleteAnnotation,
      abandonAnnotationIntent: mocks.abandonAnnotationIntent,
    },
  }
})

function annotation(overrides: Partial<AnnotationView> = {}): AnnotationView {
  return {
    id: 'annotation-1',
    collectionId: 'collection-1',
    subject: { type: 'node', id: 'node-1' },
    type: 'tldr',
    format: 'plain',
    value: 'Existing TL;DR',
    visibility: 'private',
    creator: null,
    provenance: { kind: 'human' },
    revision: 'revision-1',
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z',
    extensions: {},
    ...overrides,
  }
}

function deleteResult() {
  return {
    receipt: {
      resourceType: 'annotation' as const, targetId: 'annotation-1', collectionId: 'collection-1',
      scope: 'single' as const, deletedAt: '2026-07-25T00:00:00.000Z', deleteRevision: 'revision-2',
      operationId: 'operation-1', affectedCount: 1 as const, purgeAfter: '2026-08-24T00:00:00.000Z',
    },
    fence: { contentRevision: 'cc1', policyRevision: 'p1' },
  }
}

let workflow: ReturnType<typeof useAnnotationWorkflow> | null = null

function Harness({ locator }: { locator: AnnotationSubjectLocator | null }) {
  workflow = useAnnotationWorkflow(locator)
  return (
    <output data-testid="state">
      {JSON.stringify({
        tldr: workflow.tldr ? { id: workflow.tldr.id, value: workflow.tldr.value } : null,
        note: workflow.note ? { id: workflow.note.id, value: workflow.note.value } : null,
        state: workflow.state,
        pending: workflow.pending?.kind ?? null,
        visibility: workflow.pending?.visibility ?? null,
      })}
    </output>
  )
}

function state() {
  return JSON.parse(document.querySelector('[data-testid="state"]')!.textContent!) as {
    tldr: { id: string; value: string } | null
    note: { id: string; value: string } | null
    state: string
    pending: string | null
    visibility: string | null
  }
}

async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
}

/* R9-19: destructive mutations open the shared confirm modal (mounted by the
   test render's ConfirmProvider); the action runs only after it resolves. */
function confirmModalButton(label = 'Delete'): HTMLButtonElement {
  const dialog = document.querySelector('[role="dialog"]')
  const button = [...(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    .find((candidate) => candidate.textContent?.trim() === label)
  if (!button) throw new Error(`confirm button missing: ${label}`)
  return button
}

describe('useAnnotationWorkflow TL;DR + visibility + subject coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    document.body.innerHTML = '<div id="test-root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    mocks.loadAnnotations.mockResolvedValue([])
    mocks.abandonAnnotationIntent.mockReturnValue(undefined)
    mocks.getAnnotation.mockResolvedValue(annotation())
  })

  afterEach(() => {
    cleanup()
    workflow = null
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  async function render(locator: AnnotationSubjectLocator | null = {
    collectionId: 'collection-1', resourceType: 'node', resourceId: 'node-1',
  }) {
    mountTree(<Harness locator={locator} />)
    if (locator) await settle()
    return workflow!
  }

  it('creates a TL;DR as a tldr annotation with the explicit visibility', async () => {
    mocks.createAnnotation.mockResolvedValue(annotation({ visibility: 'public', value: 'Fresh TL;DR' }))
    const hook = await render()
    await act(async () => { hook.saveTldr('Fresh TL;DR', 'public') })
    await settle()

    expect(mocks.createAnnotation).toHaveBeenCalledTimes(1)
    const [collectionId, subject, body, options] = mocks.createAnnotation.mock.calls[0]!
    expect(collectionId).toBe('collection-1')
    expect(subject).toEqual({ resourceType: 'node', resourceId: 'node-1' })
    expect(body).toMatchObject({ type: 'tldr', format: 'plain', value: 'Fresh TL;DR', visibility: 'public' })
    expect(options).toMatchObject({ maxRetries: 0, clearIntentOnSuccess: false })
    expect(typeof options.intentId).toBe('string')
    expect(state()).toMatchObject({ tldr: { value: 'Fresh TL;DR' }, state: 'saved', pending: null })
  })

  it('updates the existing TL;DR against its frozen revision', async () => {
    mocks.loadAnnotations.mockResolvedValue([annotation()])
    mocks.updateAnnotation.mockResolvedValue(annotation({ value: 'Edited TL;DR', revision: 'revision-2' }))
    const hook = await render()
    expect(state().tldr).toEqual({ id: 'annotation-1', value: 'Existing TL;DR' })

    await act(async () => { hook.saveTldr('Edited TL;DR', 'public') })
    await settle()

    expect(mocks.updateAnnotation).toHaveBeenCalledTimes(1)
    const [collectionId, annotationId, body, ifMatch, options] = mocks.updateAnnotation.mock.calls[0]!
    expect(collectionId).toBe('collection-1')
    expect(annotationId).toBe('annotation-1')
    expect(body).toEqual({ value: 'Edited TL;DR', format: 'plain', visibility: 'public' })
    expect(ifMatch).toBe('"revision-1"')
    expect(options).toMatchObject({ maxRetries: 0, clearIntentOnSuccess: false })
    expect(state()).toMatchObject({ tldr: { value: 'Edited TL;DR' }, state: 'saved' })
  })

  it('keeps the server visibility when an update omits it', async () => {
    mocks.loadAnnotations.mockResolvedValue([annotation({ visibility: 'unlisted' })])
    mocks.updateAnnotation.mockResolvedValue(annotation({ value: 'Same visibility', visibility: 'unlisted' }))
    const hook = await render()

    await act(async () => { hook.saveTldr('Same visibility') })
    await settle()

    expect(mocks.updateAnnotation).toHaveBeenCalledTimes(1)
    expect(mocks.updateAnnotation.mock.calls[0]![2]).toEqual({ value: 'Same visibility', format: 'plain' })
  })

  it('deletes the TL;DR through a confirmed revision-matched delete and clears it locally', async () => {
    mocks.loadAnnotations.mockResolvedValue([annotation()])
    mocks.deleteAnnotation.mockResolvedValue(deleteResult())
    const hook = await render()

    await act(async () => { hook.deleteTldr() })
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Delete this TL;DR?')
    await act(async () => { confirmModalButton('Delete TL;DR').click() })
    await settle()

    expect(mocks.deleteAnnotation).toHaveBeenCalledTimes(1)
    const [collectionId, annotationId, ifMatch] = mocks.deleteAnnotation.mock.calls[0]!
    expect(collectionId).toBe('collection-1')
    expect(annotationId).toBe('annotation-1')
    expect(ifMatch).toBe('"revision-1"')
    expect(state()).toMatchObject({ tldr: null, state: 'saved' })
  })

  it('deletes an emptied TL;DR draft instead of writing blank text', async () => {
    mocks.loadAnnotations.mockResolvedValue([annotation()])
    mocks.deleteAnnotation.mockResolvedValue(deleteResult())
    const hook = await render()

    let result: Promise<boolean> | undefined
    await act(async () => { result = hook.saveTldr('   '); await Promise.resolve() })
    // The blank save awaits the shared confirm before mutating.
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Delete this TL;DR?')
    await act(async () => { confirmModalButton('Delete TL;DR').click(); await result })
    await settle()

    expect(mocks.createAnnotation).not.toHaveBeenCalled()
    expect(mocks.updateAnnotation).not.toHaveBeenCalled()
    expect(mocks.deleteAnnotation).toHaveBeenCalledTimes(1)
    expect(state()).toMatchObject({ tldr: null, state: 'saved' })
  })

  it('forwards visibility on note create and update and defaults to private when omitted', async () => {
    mocks.createAnnotation.mockResolvedValue(annotation({ type: 'note', value: 'Public note', visibility: 'public' }))
    const hook = await render()
    await act(async () => { hook.setDraft('Public note') })
    await act(async () => { hook.saveNote(false, 'public') })
    await settle()
    expect(mocks.createAnnotation.mock.calls[0]![2]).toMatchObject({ type: 'note', visibility: 'public' })

    cleanup()
    document.body.innerHTML = '<div id="test-root"></div>'
    mocks.loadAnnotations.mockResolvedValue([annotation({ type: 'note', value: 'Server note' })])
    mocks.updateAnnotation.mockResolvedValue(annotation({ type: 'note', value: 'Server note', visibility: 'unlisted' }))
    const second = await render()
    await act(async () => { second.saveNote(false, 'unlisted') })
    await settle()
    expect(mocks.updateAnnotation.mock.calls[0]![2]).toMatchObject({ visibility: 'unlisted' })

    cleanup()
    document.body.innerHTML = '<div id="test-root"></div>'
    mocks.loadAnnotations.mockResolvedValue([])
    mocks.createAnnotation.mockResolvedValue(annotation({ type: 'note', value: 'Private by default' }))
    const third = await render()
    await act(async () => { third.setDraft('Private by default') })
    await act(async () => { third.saveNote() })
    await settle()
    expect(mocks.createAnnotation.mock.calls[1]![2]).toMatchObject({ visibility: 'private' })
  })

  it('addresses a folder node and a collection subject without a kind-specific locator', async () => {
    mocks.createAnnotation.mockResolvedValue(annotation({ subject: { type: 'node', id: 'folder-7' } }))
    const folder = await render({
      collectionId: 'collection-1', resourceType: 'node', resourceId: 'folder-7',
    })
    await act(async () => { folder.saveTldr('Folder TL;DR', 'public') })
    await settle()
    expect(mocks.createAnnotation.mock.calls[0]![1]).toEqual({ resourceType: 'node', resourceId: 'folder-7' })

    cleanup()
    document.body.innerHTML = '<div id="test-root"></div>'
    mocks.loadAnnotations.mockResolvedValue([])
    mocks.createAnnotation.mockResolvedValue(annotation({ subject: { type: 'collection', id: 'collection-1' } }))
    const collection = await render({
      collectionId: 'collection-1', resourceType: 'collection', resourceId: 'collection-1',
    })
    await act(async () => { collection.saveTldr('Collection TL;DR', 'public') })
    await settle()
    expect(mocks.createAnnotation.mock.calls[1]![1]).toEqual({ resourceType: 'collection', resourceId: 'collection-1' })
  })
})

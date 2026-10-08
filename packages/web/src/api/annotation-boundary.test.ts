// @vitest-environment happy-dom
/* P2B-09 Annotation frontend boundary.
 *
 * Behaviour: the Annotation workflow is driven against the canonical client
 * with the client mocked, so each lifecycle step is observed as a call with
 * the exact arguments: the subject read, create, revision-matched update and
 * the confirmed delete. The workflow may be renamed or split freely; only a
 * change of what it calls moves these tests.
 *
 * Architecture: DTO derivation (types are erased at runtime), the private
 * transport construction (an absent deep import), the accepted-evidence gate
 * and the absence of AI/reading-state authoring and of raw markup injection.
 * None of those produce an observable behaviour difference in a passing run.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnnotationView } from './types'
import {
  useAnnotationWorkflow,
  type AnnotationSubjectLocator,
} from '../lib/useAnnotationWorkflow'
import workflowSource from '../lib/useAnnotationWorkflow.ts?raw'
import readerSource from '../pages/Reader.tsx?raw'
import resourceDetailSource from '../pages/ResourceDetail.tsx?raw'
import { cleanup, mountTree, waitForDom } from '../test/render'
import generatedBridgeSource from '../generated/product-v1.ts?raw'
import featureFlagsSource from './featureFlags.ts?raw'
import { isLive } from './featureFlags'
import transportSource from './product-transport.ts?raw'

const transportDomainSources = Object.values(import.meta.glob('./product-transport*.ts', {
  eager: true,
  import: 'default',
  query: '?raw',
})) as string[]
const transportSources = [transportSource, ...transportDomainSources].join('\n')
import typesSource from './types.ts?raw'

/* happy-dom gives modules an http(s) `import.meta.url`; resolve the evidence
   file from `import.meta.dirname`, which stays a filesystem path. */
const acceptanceEvidence = readFileSync(resolve(
  import.meta.dirname,
  '../../upstream-fixtures/phase2b-annotation-acceptance-2026-07-25.md',
), 'utf8')

const LOCATOR: AnnotationSubjectLocator = {
  collectionId: 'collection-1',
  resourceType: 'node',
  resourceId: 'node-1',
}

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
    collectionId: LOCATOR.collectionId,
    subject: { type: 'node', id: LOCATOR.resourceId },
    type: 'note',
    format: 'plain',
    value: 'Existing note',
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
      resourceType: 'annotation' as const, targetId: 'annotation-1', collectionId: LOCATOR.collectionId,
      scope: 'single' as const, deletedAt: '2026-07-25T00:00:00.000Z', deleteRevision: 'revision-2',
    },
  }
}

describe('P2B-09 Annotation frontend boundary', () => {
  describe('useAnnotationWorkflow behaviour', () => {
    let current!: ReturnType<typeof useAnnotationWorkflow>

    function Probe() {
      current = useAnnotationWorkflow(LOCATOR)
      return null
    }
    function render() {
      mountTree(createElement(Probe))
    }
    const loaded = () => current != null && current.state !== 'loading'

    beforeEach(() => {
      vi.clearAllMocks()
      mocks.loadAnnotations.mockResolvedValue([annotation()])
      mocks.getAnnotation.mockResolvedValue(annotation())
      mocks.createAnnotation.mockResolvedValue(annotation({ id: 'annotation-created', value: 'New note', format: 'markdown' }))
      mocks.updateAnnotation.mockResolvedValue(annotation({ value: 'Updated note', revision: 'revision-2' }))
      mocks.deleteAnnotation.mockResolvedValue(deleteResult())
    })
    afterEach(() => { cleanup(); document.body.innerHTML = '' })

    it('reads the subject annotations through the canonical client with the subject locator', async () => {
      render()
      await waitForDom(loaded)
      expect(mocks.loadAnnotations).toHaveBeenCalledWith(
        LOCATOR.collectionId,
        { resourceType: LOCATOR.resourceType, resourceId: LOCATOR.resourceId },
        expect.objectContaining({ maxRetries: 0 }),
      )
      for (const call of mocks.loadAnnotations.mock.calls) {
        expect(call[2]?.signal).toBeInstanceOf(AbortSignal)
      }
      expect(current.note?.id).toBe('annotation-1')
      expect(current.draft).toBe('Existing note')
    })

    it('creates a note through the canonical client when none exists yet', async () => {
      mocks.loadAnnotations.mockResolvedValue([])
      render()
      await waitForDom(loaded)
      act(() => current.setDraft('New note'))
      await act(async () => { await current.saveNote() })
      expect(mocks.createAnnotation).toHaveBeenCalledWith(
        LOCATOR.collectionId,
        { resourceType: LOCATOR.resourceType, resourceId: LOCATOR.resourceId },
        { type: 'note', format: 'markdown', value: 'New note', visibility: 'private' },
        expect.objectContaining({ maxRetries: 0, clearIntentOnSuccess: false }),
      )
      const options = mocks.createAnnotation.mock.calls[0]![3] as { intentId: string; signal: AbortSignal }
      expect(options.intentId).toMatch(/^annotation:create-note:/u)
      expect(options.signal).toBeInstanceOf(AbortSignal)
    })

    it('updates the existing note with its revision etag', async () => {
      render()
      await waitForDom(loaded)
      act(() => current.setDraft('Updated note'))
      await act(async () => { await current.saveNote() })
      expect(mocks.updateAnnotation).toHaveBeenCalledWith(
        LOCATOR.collectionId,
        'annotation-1',
        { value: 'Updated note', format: 'plain' },
        '"revision-1"',
        expect.objectContaining({ maxRetries: 0, clearIntentOnSuccess: false }),
      )
    })

    it('deletes the note through the canonical client only after the shared confirm', async () => {
      render()
      await waitForDom(loaded)
      await act(async () => { current.deleteNote() })
      await waitForDom(() => document.querySelector('[role="dialog"]')?.textContent?.includes('Delete this private note?') === true)
      expect(mocks.deleteAnnotation).not.toHaveBeenCalled()
      const dialog = document.querySelector('[role="dialog"]')
      const confirmButton = [...(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
        .find((candidate) => candidate.textContent?.trim() === 'Delete note')
      if (!confirmButton) throw new Error('confirm button missing: Delete')
      act(() => confirmButton.click())
      await waitForDom(() => mocks.deleteAnnotation.mock.calls.length > 0)
      expect(mocks.deleteAnnotation).toHaveBeenCalledWith(
        LOCATOR.collectionId,
        'annotation-1',
        '"revision-1"',
        expect.objectContaining({ maxRetries: 0 }),
      )
    })
  })

  describe('architecture invariants that cannot be behaviour tested', () => {
    it('keeps Annotation DTOs generated and transport construction private', () => {
      expect(generatedBridgeSource).toMatch(/from\s+'@known\/product-v1'/u)
      /* Type aliases are erased at runtime; assert the derivation itself. */
      expect(typesSource).toMatch(/export type AnnotationView = Schemas\['AnnotationView'\]/u)
      expect(transportSources).toContain('AnnotationView')
      /* Every Annotation surface reaches the API through the public barrel;
         deep imports into the transport/client modules exist nowhere. */
      for (const [name, source] of [['Reader', readerSource], ['ResourceDetail', resourceDetailSource], ['useAnnotationWorkflow', workflowSource]] as const) {
        expect(source, name).toMatch(/from\s+['"]\.\.\/api['"]/u)
      }
      for (const [name, source] of [['Reader', readerSource], ['ResourceDetail', resourceDetailSource]] as const) {
        expect(source, name).not.toMatch(/from\s+['"]\.\.\/api\/(?:product-transport|productClient|types)['"]/u)
        expect(source, name).not.toContain('dangerouslySetInnerHTML')
      }
    })

    it('ships the narrow Annotation capability only with accepted independent evidence', () => {
      expect(isLive('annotations')).toBe(true)
      expect(featureFlagsSource).toMatch(/annotations:\s*true/u)
      expect(featureFlagsSource).toContain('accepted after independent acceptance')
      expect(acceptanceEvidence).toContain('Result: **Accepted**')
      expect(acceptanceEvidence).not.toContain('Pending independent acceptance')
    })

    it('does not add Relation to Reader or reading-state/AI authoring to Annotation surfaces', () => {
      expect(readerSource).not.toMatch(/\bcreateRelation\b/iu)
      for (const [name, source] of [['Reader', readerSource], ['ResourceDetail', resourceDetailSource]] as const) {
        expect(source, name).not.toMatch(/\b(?:reading_state|readingState|generateAnnotation|aiProvider)\b/iu)
      }
    })
  })
})

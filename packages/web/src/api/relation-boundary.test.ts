// @vitest-environment happy-dom
/* P2B-14 Relation frontend boundary.
 *
 * Behaviour: the Relation workflow is driven against the canonical client with
 * the client mocked, so every Relation operation it performs (snapshot +
 * incoming/outgoing reads, create, update, delete) is observed as a call with
 * the exact arguments and command intent. A rename inside the workflow cannot
 * make this pass or fail; only a change of what it actually calls can.
 *
 * Architecture: the remaining assertions are about things running code cannot
 * falsify — that the DTO aliases are the generated schemas (types are erased),
 * and that the endpoint picker is a constrained select fed by the loaded
 * snapshot rather than free text or a tree move. They are anchored on module
 * specifiers and declarations rather than formatting.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorSnapshot, RelationView } from './types'
import { useRelationWorkflow } from '../lib/useRelationWorkflow'
import workflowSource from '../lib/useRelationWorkflow.ts?raw'
import resourceDetailSource from '../pages/ResourceDetail.tsx?raw'
import { cleanup, mountTree, waitForDom } from '../test/render'
import generatedBridgeSource from '../generated/product-v1.ts?raw'
import featureFlagsSource from './featureFlags.ts?raw'
import { isLive } from './featureFlags'
import transportSource from './product-transport.ts?raw'
import { editorPageBody } from './test-helpers'

const transportDomainSources = Object.values(import.meta.glob('./product-transport*.ts', {
  eager: true,
  import: 'default',
  query: '?raw',
})) as string[]
const transportSources = [transportSource, ...transportDomainSources].join('\n')
import typesSource from './types.ts?raw'

/* happy-dom gives the module an http(s) `import.meta.url`, so resolve the
   evidence file from `import.meta.dirname` (a real filesystem path). */
const evidence = readFileSync(resolve(
  import.meta.dirname,
  '../../upstream-fixtures/phase2b-relation-acceptance-2026-07-25.md',
), 'utf8')

const LOCATOR = { collectionId: 'collection-1', nodeId: 'node-1' }

const mocks = vi.hoisted(() => ({
  loadEditorSnapshot: vi.fn(),
  loadRelations: vi.fn(),
  createRelation: vi.fn(),
  updateRelation: vi.fn(),
  deleteRelation: vi.fn(),
  abandonRelationIntent: vi.fn(),
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    productClient: {
      ...actual.productClient,
      loadEditorSnapshot: mocks.loadEditorSnapshot,
      loadRelations: mocks.loadRelations,
      createRelation: mocks.createRelation,
      updateRelation: mocks.updateRelation,
      deleteRelation: mocks.deleteRelation,
      abandonRelationIntent: mocks.abandonRelationIntent,
    },
  }
})

function relation(overrides: Partial<RelationView> = {}): RelationView {
  return {
    id: 'relation-1',
    collectionId: LOCATOR.collectionId,
    fromNodeId: LOCATOR.nodeId,
    toNodeId: 'node-2',
    type: 'related',
    label: null,
    visibility: 'private',
    revision: '1',
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z',
    extensions: {},
    ...overrides,
  }
}

const outgoingRelation = relation()

function snapshot(): EditorSnapshot {
  return editorPageBody({
    nodes: [
      { id: LOCATOR.nodeId, kind: 'bookmark' },
      { id: 'node-2', kind: 'bookmark' },
      { id: 'node-3', kind: 'bookmark' },
    ],
  }) as unknown as EditorSnapshot
}

describe('P2B-14 Relation frontend boundary', () => {
  describe('useRelationWorkflow behaviour', () => {
    let current!: ReturnType<typeof useRelationWorkflow>

    function Probe() {
      current = useRelationWorkflow(LOCATOR)
      return null
    }
    function render() {
      mountTree(createElement(Probe))
    }
    const loaded = () => current != null && current.state !== 'loading'

    beforeEach(() => {
      vi.clearAllMocks()
      mocks.loadEditorSnapshot.mockResolvedValue(snapshot())
      mocks.loadRelations.mockResolvedValue([outgoingRelation])
      mocks.createRelation.mockResolvedValue(relation({ id: 'relation-created' }))
      mocks.updateRelation.mockResolvedValue(relation({ label: 'renamed', revision: '2' }))
      mocks.deleteRelation.mockResolvedValue(undefined)
    })
    afterEach(() => { cleanup(); document.body.innerHTML = '' })

    it('loads the snapshot and both relation directions through the canonical client', async () => {
      render()
      await waitForDom(loaded)
      expect(mocks.loadEditorSnapshot).toHaveBeenCalledWith(
        LOCATOR.collectionId,
        expect.objectContaining({ maxRetries: 0 }),
      )
      expect(mocks.loadRelations).toHaveBeenCalledWith(
        LOCATOR.collectionId,
        { nodeId: LOCATOR.nodeId, direction: 'incoming' },
        expect.objectContaining({ maxRetries: 0 }),
      )
      expect(mocks.loadRelations).toHaveBeenCalledWith(
        LOCATOR.collectionId,
        { nodeId: LOCATOR.nodeId, direction: 'outgoing' },
        expect.objectContaining({ maxRetries: 0 }),
      )
      for (const call of mocks.loadEditorSnapshot.mock.calls) {
        expect(call[1]?.signal).toBeInstanceOf(AbortSignal)
      }
      expect(current.incoming).toHaveLength(1)
      expect(current.outgoing).toHaveLength(1)
      /* The subject node is not offered as its own endpoint. */
      expect(current.nodes.map((node) => node.id)).toEqual(['root-1', 'node-2', 'node-3'])
    })

    it('creates a relation through the canonical client with a fresh command intent', async () => {
      render()
      await waitForDom(loaded)
      act(() => current.create({ endpointId: 'node-2', type: 'related', label: '  references  ', visibility: 'private' }))
      await waitForDom(() => mocks.createRelation.mock.calls.length > 0)
      expect(mocks.createRelation).toHaveBeenCalledWith(
        LOCATOR.collectionId,
        { fromNodeId: 'node-1', toNodeId: 'node-2', type: 'related', label: 'references', visibility: 'private' },
        expect.objectContaining({ maxRetries: 0, clearIntentOnSuccess: true }),
      )
      const options = mocks.createRelation.mock.calls[0]![2] as { intentId: string; signal: AbortSignal }
      expect(options.intentId).toMatch(/^create-relation:.+$/u)
      expect(options.signal).toBeInstanceOf(AbortSignal)
    })

    it('updates the edited relation with its revision etag', async () => {
      render()
      await waitForDom(loaded)
      act(() => current.beginEdit(outgoingRelation))
      act(() => current.setEditDraft({ type: 'related', label: 'renamed', visibility: 'protected', replacementEndpointId: 'node-2' }))
      act(() => current.save())
      await waitForDom(() => mocks.updateRelation.mock.calls.length > 0)
      expect(mocks.updateRelation).toHaveBeenCalledWith(
        LOCATOR.collectionId,
        'relation-1',
        { type: 'related', label: 'renamed', visibility: 'protected' },
        '"1"',
        expect.objectContaining({ maxRetries: 0, clearIntentOnSuccess: true }),
      )
    })

    it('deletes a relation through the canonical client only after the shared confirm', async () => {
      render()
      await waitForDom(loaded)
      await act(async () => { void current.remove(outgoingRelation) })
      await waitForDom(() => document.querySelector('[role="dialog"]')?.textContent?.includes('Delete this relation?') === true)
      expect(mocks.deleteRelation).not.toHaveBeenCalled()
      const dialog = document.querySelector('[role="dialog"]')
      const confirmButton = [...(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
        .find((candidate) => candidate.textContent?.trim() === 'Delete relation')
      if (!confirmButton) throw new Error('confirm button missing: Delete relation')
      act(() => confirmButton.click())
      await waitForDom(() => mocks.deleteRelation.mock.calls.length > 0)
      expect(mocks.deleteRelation).toHaveBeenCalledWith(
        LOCATOR.collectionId,
        'relation-1',
        '"1"',
        expect.objectContaining({ maxRetries: 0 }),
      )
    })
  })

  describe('architecture invariants that cannot be behaviour tested', () => {
    it('consumes generated Relation DTOs instead of copied schema types', () => {
      expect(generatedBridgeSource).toMatch(/from\s+'@known\/product-v1'/u)
      /* Type aliases are erased at runtime; assert the derivation itself. */
      for (const schema of ['RelationView', 'RelationPage', 'CreateRelationRequest', 'RelationMergePatch']) {
        expect(typesSource).toMatch(new RegExp(`export type ${schema} = Schemas\\['${schema}'\\]`, 'u'))
      }
      expect(transportSources).toContain('RelationView')
    })

    it('keeps endpoint identity constrained to loaded nodes and never mutates tree position', () => {
      /* Both halves are absences: the page cannot reach the tree-move endpoint
         and cannot turn a free-text value into a relation endpoint. A rename
         cannot trip these; only reintroducing the capability can. */
      expect(workflowSource).toMatch(/\bproductClient\.loadEditorSnapshot\b/u)
      expect(resourceDetailSource).toMatch(/<select\b[^>]*\baria-label="Linked bookmark"/u)
      expect(resourceDetailSource).not.toMatch(/<input\b[^>]*\baria-label="Linked bookmark"/u)
      expect(workflowSource).not.toMatch(/\b(?:moveCollectionNode|moveNode)\b/u)
      expect(workflowSource).not.toMatch(/\bposition\s*:/u)
      expect(resourceDetailSource).not.toContain('dangerouslySetInnerHTML')
    })

    it('ships accepted narrow and composite flags with independent evidence', () => {
      expect(isLive('relations')).toBe(true)
      expect(isLive('resourceDetail')).toBe(true)
      expect(featureFlagsSource).toMatch(/relations:\s*true/u)
      expect(featureFlagsSource).toMatch(/resourceDetail:\s*true/u)
      expect(evidence).toContain('Result: **Accepted**')
    })
  })
})

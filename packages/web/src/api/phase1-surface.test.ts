/**
 * P1-13: Phase 1 active surface contract for the web editor.
 *
 * Public, Paid, Collaborators, tags/cover, member-lock, Library list, etc.
 * are out of scope for the Product API active contract and must not be wired
 * to mutations or local fake success. This file documents the invariant as an
 * executable checklist; E2E asserts the same against the live editor UI.
 *
 * Source: Known-Backend/docs/08-phase1-product-api-contract.md § visibility /
 * product surface notes.
 */
import { describe, expect, it } from 'vitest'

/** Controls that must be hidden or disabled in Phase 1 editor UX. */
export const PHASE1_OUT_OF_SCOPE_CONTROLS = [
  'public-visibility',
  'paid-access',
  'collaborators',
  'collection-tags',
  'collection-cover',
  'member-lock',
  'reading-path-membership',
  'library-list-discovery',
] as const

/** Product operations that Phase 1 client may call. */
export const PHASE1_ACTIVE_OPERATIONS = [
  'getSession',
  'deleteSession',
  'getMe',
  'createCollection',
  'getCollectionEditorPage',
  'loadEditorSnapshot',
  'updateCollection',
  'createCollectionNode',
  'updateCollectionNode',
  'moveCollectionNode',
  'deleteCollectionNode',
] as const

describe('Phase 1 editor surface contract', () => {
  it('lists out-of-scope controls that UI must hide or disable', () => {
    expect(PHASE1_OUT_OF_SCOPE_CONTROLS).toContain('public-visibility')
    expect(PHASE1_OUT_OF_SCOPE_CONTROLS).toContain('paid-access')
    expect(PHASE1_OUT_OF_SCOPE_CONTROLS).toContain('collaborators')
    expect(PHASE1_OUT_OF_SCOPE_CONTROLS).toContain('collection-tags')
    expect(PHASE1_OUT_OF_SCOPE_CONTROLS).toContain('collection-cover')
    expect(PHASE1_OUT_OF_SCOPE_CONTROLS).toContain('member-lock')
    expect(PHASE1_OUT_OF_SCOPE_CONTROLS).toContain('library-list-discovery')
    // Stable set — prevent silent expansion without contract change
    expect(PHASE1_OUT_OF_SCOPE_CONTROLS).toHaveLength(8)
  })

  it('lists only active Product operations for the generated client surface', () => {
    expect(PHASE1_ACTIVE_OPERATIONS).toContain('createCollection')
    expect(PHASE1_ACTIVE_OPERATIONS).toContain('loadEditorSnapshot')
    expect(PHASE1_ACTIVE_OPERATIONS).toContain('deleteCollectionNode')
    // Must not claim out-of-scope product endpoints
    expect(PHASE1_ACTIVE_OPERATIONS.join(',')).not.toMatch(/collaborator|subscription|public|paid/i)
  })

  it('exports data-testid conventions for E2E (stable contract)', () => {
    // Documented selectors used by Playwright specs under e2e/
    const selectors = {
      editorRoot: 'phase1-editor',
      editorLoading: 'phase1-editor-loading',
      editorError: 'phase1-editor-error',
      editorTree: 'phase1-editor-tree',
      createCollection: 'phase1-create-collection',
      conflictBanner: 'phase1-conflict-banner',
      deleteConfirm: 'phase1-delete-confirm',
      outOfScope: (id: string) => `phase1-oos-${id}`,
    }
    expect(selectors.editorRoot).toBe('phase1-editor')
    for (const id of PHASE1_OUT_OF_SCOPE_CONTROLS) {
      expect(selectors.outOfScope(id)).toMatch(/^phase1-oos-/)
    }
  })
})

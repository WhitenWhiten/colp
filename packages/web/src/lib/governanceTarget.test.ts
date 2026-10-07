import { describe, expect, it } from 'vitest'
import { formatGovernanceTarget, governanceTargetHref, governanceTargetKind, governanceTargetMeta } from './governanceTarget'

describe('governance target copy', () => {
  it('formats ids and only links known product paths', () => {
    expect(formatGovernanceTarget({ kind: 'collection', id: 'col_1' })).toBe('Collection col_1')
    expect(governanceTargetHref({ kind: 'collection', id: 'col_1' })).toBe('/library/col_1')
    expect(governanceTargetHref({ kind: 'bookmark', id: 'n1', collectionId: 'col_1' })).toBe('/r/n1')
    expect(governanceTargetHref({ kind: 'comment', id: 'cmt_1' })).toBe('/community/comments/cmt_1')
    expect(governanceTargetHref({ kind: 'digest_series', id: 'rep_1' })).toBeNull()
  })
  it('keeps opaque ids out of row titles and shortens them in meta', () => {
    expect(governanceTargetKind({ kind: 'collection', id: 'col-u2YOt2abcdefghij' })).toBe('Collection')
    expect(governanceTargetMeta({ kind: 'collection', id: 'col-u2YOt2abcdefghij' })).toBe('col-u2YOt2…')
    expect(governanceTargetMeta({ kind: 'bookmark', id: 'n1', collectionId: 'col_1' })).toBe('n1 · in collection col_1')
  })
})

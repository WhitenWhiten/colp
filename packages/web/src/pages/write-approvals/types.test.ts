import { describe, expect, it } from 'vitest'
import type { WriteApprovalOperationPreview, WriteApprovalView } from '../../api'
import { operationTypeLabel } from './types'

const target: WriteApprovalView['target'] = { kind: 'node', collectionId: 'col-1', nodeId: 'node-1' }

function deletion(description: string): WriteApprovalOperationPreview {
  return { type: 'delete_subtree', collectionId: 'col-1', nodeId: 'node-1', visibility: null, nodeSummary: null, description }
}

describe('operationTypeLabel', () => {
  it('names a one-item delete plainly and a larger one with what it takes along', () => {
    expect(operationTypeLabel(deletion('delete Lobsters (1 item)'), target)).toBe('Delete')
    expect(operationTypeLabel(deletion('delete Design (9 items)'), target)).toBe('Delete with everything inside')
    expect(operationTypeLabel({ ...deletion(''), description: undefined }, target)).toBe('Delete with everything inside')
  })
})

import { describe, expect, it } from 'vitest'
import { FEATURE_FLAGS } from './featureFlags'

describe('FEATURE_FLAGS', () => {
  it('marks every self-hosted Product surface live', () => {
    expect(FEATURE_FLAGS).toEqual({
      annotations: true,
      relations: true,
      collaborators: true,
      collectionHistory: true,
      // Live since the MCP write-approval flow shipped (the W08 boundary pins it on).
      writeApprovals: true,
      linkHealth: true,
    })
  })
})

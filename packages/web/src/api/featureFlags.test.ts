import { describe, expect, it } from 'vitest'
import { FEATURE_FLAGS } from './featureFlags'

describe('FEATURE_FLAGS', () => {
  it('marks live Product surfaces true and keeps gated capabilities off', () => {
    expect(FEATURE_FLAGS.sync).toBe(true)
    expect(FEATURE_FLAGS.extension).toBe(true)
    expect(FEATURE_FLAGS.import).toBe(true)
    expect(FEATURE_FLAGS.share).toBe(true)
    // Live since the MCP write-approval flow shipped (the W08 boundary pins it on).
    expect(FEATURE_FLAGS.writeApprovals).toBe(true)
    expect(FEATURE_FLAGS.mfa).toBe(false)
    expect(FEATURE_FLAGS.readableReplica).toBe(false)
    expect(FEATURE_FLAGS.graph).toBe(false)
  })
})

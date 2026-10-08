import { describe, expect, it } from 'vitest'
import {
  MODERATION_CATEGORY_LABEL,
  MODERATION_STATUS_LABEL,
  MODERATION_STATUS_TONE,
  MODERATION_TARGET_LABEL,
  humanLabel,
} from './moderationLabels'

describe('moderation labels', () => {
  it('maps a known enum value to its label', () => {
    expect(humanLabel(MODERATION_CATEGORY_LABEL, 'illegal_content')).toBe('Illegal content')
    expect(humanLabel(MODERATION_STATUS_LABEL, 'in_review')).toBe('In review')
    expect(humanLabel(MODERATION_TARGET_LABEL, 'digest_edition')).toBe('Digest issue')
    expect(MODERATION_STATUS_TONE.resolved).toBe('success')
  })

  it('prints an unknown value as words instead of a raw enum', () => {
    expect(humanLabel(MODERATION_STATUS_LABEL, 'waiting_on_owner')).toBe('waiting on owner')
    expect(humanLabel(MODERATION_TARGET_LABEL, 'profile')).toBe('profile')
  })
})

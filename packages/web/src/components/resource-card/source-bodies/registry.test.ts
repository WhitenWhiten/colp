import { describe, expect, it } from 'vitest'
import type { WidgetType } from '../../../types/catalog'
import { FILL_TYPES } from '../WidgetBody'
import { sourceBodyRegistry } from './registry'

type WidgetKeysInRegistry = Extract<keyof typeof sourceBodyRegistry, WidgetType>
const noWidgetKeysInRegistry: [WidgetKeysInRegistry] extends [never] ? true : false = true

describe('sourceBodyRegistry', () => {
  it('does not register widget fill types as bookmark bodies', () => {
    expect(noWidgetKeysInRegistry).toBe(true)
    expect(Object.keys(sourceBodyRegistry)).not.toEqual(
      expect.arrayContaining([...FILL_TYPES]),
    )
  })
})

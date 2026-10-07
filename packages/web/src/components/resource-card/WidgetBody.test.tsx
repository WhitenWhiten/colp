import { describe, expect, it } from 'vitest'
import { WIDGET_TYPES, type WidgetType } from '../../types/catalog'
import { FILL_TYPES, TOOL_TYPES } from './WidgetBody'

type MissingFill = Exclude<WidgetType, (typeof FILL_TYPES)[number]>
type ExtraFill = Exclude<(typeof FILL_TYPES)[number], WidgetType>
const fillCoversWidgetType: [MissingFill, ExtraFill] extends [never, never] ? true : false = true

const EVERY_WIDGET_TYPE: WidgetType[] = [
  'aichat',
  'clock',
  'collectionlist',
  'ghheatmap',
  'habits',
  'pomodoro',
  'quicklinks',
  'reading',
  'search',
  'ssh',
  'sticky',
  'todo',
  'weather',
  'wordbook',
]

describe('FILL_TYPES', () => {
  it('covers every WidgetType', () => {
    expect(fillCoversWidgetType).toBe(true)
    expect([...FILL_TYPES].sort()).toEqual([...EVERY_WIDGET_TYPE].sort())
    expect(FILL_TYPES).toEqual(WIDGET_TYPES)
  })

  it('keeps collectionlist as fill, not a tool', () => {
    expect(FILL_TYPES).toContain('collectionlist')
    expect(TOOL_TYPES).not.toContain('collectionlist')
  })
})

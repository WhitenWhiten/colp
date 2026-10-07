import { describe, expect, it } from 'vitest'
import { displayTitleLength, isLongDisplayTitle, LONG_DISPLAY_TITLE_UNITS } from './displayTitle'

describe('displayTitle', () => {
  it('counts Latin characters once and CJK / fullwidth characters twice', () => {
    expect(displayTitleLength('LLM path')).toBe(8)
    expect(displayTitleLength('AI产业周报')).toBe(10)
    expect(displayTitleLength('路线：按')).toBe(8)
    expect(displayTitleLength('あア한')).toBe(6)
  })

  it('flags only string titles past the threshold', () => {
    expect(isLongDisplayTitle('a'.repeat(LONG_DISPLAY_TITLE_UNITS))).toBe(false)
    expect(isLongDisplayTitle('a'.repeat(LONG_DISPLAY_TITLE_UNITS + 1))).toBe(true)
    expect(isLongDisplayTitle('从神经网络直觉到对齐微调给工程师的公开学习路线')).toBe(false)
    expect(isLongDisplayTitle('从神经网络直觉到 Transformer 再到对齐微调：给工程师的公开学习路线')).toBe(true)
    expect(isLongDisplayTitle(null)).toBe(false)
  })
})

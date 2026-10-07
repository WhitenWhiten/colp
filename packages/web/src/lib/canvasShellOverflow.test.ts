import { describe, expect, it } from 'vitest'
import { canvasShellOverflows } from './canvasShellOverflow'

function shell(partial: { scrollWidth: number; clientWidth: number; scrollLeft?: number }) {
  return {
    scrollWidth: partial.scrollWidth,
    clientWidth: partial.clientWidth,
    scrollLeft: partial.scrollLeft ?? 0,
  }
}

describe('canvasShellOverflows', () => {
  it('is clear when the board fits the shell', () => {
    expect(canvasShellOverflows(shell({ scrollWidth: 900, clientWidth: 900 }))).toEqual({
      start: false,
      end: false,
    })
  })

  it('marks the end edge on a 1408px first-run board at 900px', () => {
    expect(canvasShellOverflows(shell({ scrollWidth: 1458, clientWidth: 900 }))).toEqual({
      start: false,
      end: true,
    })
  })

  it('marks both edges after scrolling into the middle', () => {
    expect(
      canvasShellOverflows(shell({ scrollWidth: 1458, clientWidth: 900, scrollLeft: 200 })),
    ).toEqual({ start: true, end: true })
  })

  it('marks only the start edge when scrolled to the end', () => {
    expect(
      canvasShellOverflows(shell({ scrollWidth: 1458, clientWidth: 900, scrollLeft: 558 })),
    ).toEqual({ start: true, end: false })
  })
})

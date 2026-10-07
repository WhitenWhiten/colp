export type CanvasShellOverflow = {
  start: boolean
  end: boolean
}

const SLACK_PX = 1

/** True when `.canvas-shell--custom` can scroll on that edge. */
export function canvasShellOverflows(
  el: Pick<HTMLElement, 'scrollWidth' | 'clientWidth' | 'scrollLeft'>,
): CanvasShellOverflow {
  const start = el.scrollLeft > SLACK_PX
  const end = el.scrollLeft + el.clientWidth < el.scrollWidth - SLACK_PX
  return { start, end }
}

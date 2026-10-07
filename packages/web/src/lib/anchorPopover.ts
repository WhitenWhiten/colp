export type AnchorAlign = 'start' | 'end'

export type AnchorPopoverPos = {
  top: number | 'auto'
  bottom: number | 'auto'
  left: number
  width: number
  maxHeight: number
  openUp: boolean
}

export type AnchorPopoverOptions = {
  /** Preferred panel width in CSS pixels. */
  width?: number
  /** Cap for maxHeight. Actual height never exceeds remaining viewport space. */
  maxHeight?: number
  /** Gap between the trigger and the panel. */
  gap?: number
  /** Viewport inset. */
  pad?: number
  /** Horizontal alignment against the trigger. */
  align?: AnchorAlign
}

const DEFAULTS = {
  width: 320,
  maxHeight: 380,
  gap: 6,
  pad: 10,
  align: 'start' as AnchorAlign,
}

/**
 * Viewport-clamped position for a `position: fixed` popover next to an anchor.
 * Flips above the trigger when there is more room there, and never reports a
 * maxHeight larger than the remaining space (so the panel can scroll inside).
 */
export function anchorPopover(
  anchor: DOMRect,
  opts: AnchorPopoverOptions = {},
): AnchorPopoverPos {
  const widthWanted = opts.width ?? DEFAULTS.width
  const maxHeightCap = opts.maxHeight ?? DEFAULTS.maxHeight
  const gap = opts.gap ?? DEFAULTS.gap
  const pad = opts.pad ?? DEFAULTS.pad
  const align = opts.align ?? DEFAULTS.align

  const vw = window.innerWidth
  const vh = window.innerHeight
  const width = Math.min(widthWanted, Math.max(0, vw - pad * 2))
  const spaceBelow = vh - anchor.bottom - pad
  const spaceAbove = anchor.top - pad
  const openUp = spaceBelow < Math.min(240, maxHeightCap) && spaceAbove > spaceBelow
  const available = Math.max(0, (openUp ? spaceAbove : spaceBelow) - gap)
  const maxHeight = Math.min(maxHeightCap, available)

  let left = align === 'end' ? anchor.right - width : anchor.left
  left = Math.max(pad, Math.min(left, vw - width - pad))

  if (openUp) {
    const bottom = Math.max(pad, vh - anchor.top + gap)
    return { top: 'auto', bottom, left, width, maxHeight, openUp: true }
  }

  const top = Math.min(vh - pad, anchor.bottom + gap)
  return { top, bottom: 'auto', left, width, maxHeight, openUp: false }
}

/** Inline style object for a portaled panel. */
export function popoverStyle(pos: AnchorPopoverPos): {
  position: 'fixed'
  top: number | 'auto'
  bottom: number | 'auto'
  left: number
  width: number
  maxHeight: number
  zIndex: string
} {
  return {
    position: 'fixed',
    top: pos.top,
    bottom: pos.bottom,
    left: pos.left,
    width: pos.width,
    maxHeight: pos.maxHeight,
    zIndex: 'var(--z-toast)',
  }
}

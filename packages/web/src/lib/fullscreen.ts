/** Vendor-prefixed Fullscreen API surface (Safari / older Edge). */
type FsDocument = Document & {
  webkitFullscreenElement?: Element | null
  msFullscreenElement?: Element | null
  webkitIsFullScreen?: boolean
}

/** Below this width the Dashboard uses a stacked module list, never fullscreen chrome-hide.
 *  This is the board-fit width, not a chrome track: the 1400px canvas plus
 *  both --gutter caps (2 × 2.35rem = 75.2px) needs 1475.2px, so the board
 *  only renders where it never clips. dashboard.css pairs max-width: 1475px
 *  with this cut. */
export const DESKTOP_DASHBOARD_MIN = 1476

/**
 * True when the page is in browser fullscreen:
 * - Fullscreen API (element.requestFullscreen / vendor prefixes)
 * - CSS display-mode: fullscreen (installed PWA / some shells)
 *
 * Phone and tablet layouts never count. A maximized desktop window is not
 * fullscreen — outer size ≈ screen used to hide TopNav on ordinary desks.
 */
export function getIsBrowserFullscreen(): boolean {
  if (typeof window !== 'undefined' && window.innerWidth < DESKTOP_DASHBOARD_MIN) {
    return false
  }

  const doc = document as FsDocument
  if (doc.fullscreenElement || doc.webkitFullscreenElement || doc.msFullscreenElement) {
    return true
  }
  if (doc.webkitIsFullScreen) return true

  try {
    if (window.matchMedia('(display-mode: fullscreen)').matches) return true
  } catch {
    /* ignore */
  }

  return false
}

const FS_EVENTS = [
  'fullscreenchange',
  'webkitfullscreenchange',
  'MSFullscreenChange',
] as const

/** Subscribe to fullscreen-related changes. Returns unsubscribe. */
export function subscribeBrowserFullscreen(onChange: () => void): () => void {
  for (const ev of FS_EVENTS) {
    document.addEventListener(ev, onChange)
  }
  window.addEventListener('resize', onChange)
  try {
    const mql = window.matchMedia('(display-mode: fullscreen)')
    mql.addEventListener?.('change', onChange)
    // Safari < 14
    mql.addListener?.(onChange)
    return () => {
      for (const ev of FS_EVENTS) {
        document.removeEventListener(ev, onChange)
      }
      window.removeEventListener('resize', onChange)
      mql.removeEventListener?.('change', onChange)
      mql.removeListener?.(onChange)
    }
  } catch {
    return () => {
      for (const ev of FS_EVENTS) {
        document.removeEventListener(ev, onChange)
      }
      window.removeEventListener('resize', onChange)
    }
  }
}

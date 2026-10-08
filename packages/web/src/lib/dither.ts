/**
 * Shared dither utilities: token reading for canvas paint code, and the
 * one-shot band texture used by the landing closing card (a static Bayer
 * field painted once, then handed to CSS as a masked background image).
 */

export type Rgb = [number, number, number]

/** Same lookup, parsed to an [r, g, b] tuple for ImageData paint loops. */
export function readTokenRgb(name: string, fallback: Rgb): Rgb {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name)
  const m = raw.match(/\d+(?:\.\d+)?/g)
  return m && m.length >= 3 ? [Number(m[0]), Number(m[1]), Number(m[2])] : fallback
}

const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
]

export const TOKEN_CHANGE_EVENT = 'known:tokens-change'

/** Re-paint canvas/CSS textures when document tokens or color-scheme change. */
export function subscribeTokenChange(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const scheme = window.matchMedia('(prefers-color-scheme: dark)')
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
  scheme.addEventListener('change', onChange)
  motion.addEventListener('change', onChange)
  const mo = new MutationObserver(onChange)
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] })
  window.addEventListener(TOKEN_CHANGE_EVENT, onChange)
  return () => {
    scheme.removeEventListener('change', onChange)
    motion.removeEventListener('change', onChange)
    mo.disconnect()
    window.removeEventListener(TOKEN_CHANGE_EVENT, onChange)
  }
}

/**
 * Paint a static ordered-dither wave and expose it as `--band-texture`
 * (a data URL) on the given element. Colors come from the same accent
 * tokens as the hero field, so the band stays in family. `seed` shifts the
 * wave so two collections do not share the same pattern.
 */
export function paintBandTexture(el: HTMLElement, seed = 0): void {
  const canvas = document.createElement('canvas')
  canvas.width = 560
  canvas.height = 200
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  /* Read from the element, not the document root: a scoped theme (the
     dark share-embed palette) redeclares these tokens below :root. */
  const fromEl = (name: string, fallback: string): string => {
    const value = getComputedStyle(el).getPropertyValue(name).trim()
    return value || fallback
  }
  const paper = fromEl('--accent-soft', '#ecf3fa')
  const mid = fromEl('--accent', '#386695')
  const ink = fromEl('--accent-ink', '#113a5f')

  const cell = 3
  const cols = Math.ceil(canvas.width / cell)
  const rows = Math.ceil(canvas.height / cell)
  const phase = ((seed % 1000) / 1000) * Math.PI * 2

  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const nx = gx / cols
      const ny = gy / rows
      const wave =
        0.5 +
        0.28 * Math.sin(nx * 6.5 + ny * 2.5 + phase) +
        0.18 * Math.sin(nx * 13 - ny * 5 + phase * 1.7) +
        0.1 * Math.sin((nx + ny) * 21 + phase * 0.4)
      const d = Math.min(1, Math.max(0, wave - ny * 0.22))
      const t = ((BAYER[gy % 4]?.[gx % 4] ?? 0) + 0.5) / 16
      const color = d > t + 0.18 ? ink : d > t - 0.12 ? mid : paper
      ctx.fillStyle = color
      ctx.fillRect(gx * cell, gy * cell, cell, cell)
    }
  }
  el.style.setProperty('--band-texture', `url(${canvas.toDataURL()})`)
}

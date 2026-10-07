import type { CSSProperties } from 'react'

/** Public embed contract: only these fields can affect presentation. */
export const appearanceChoices = {
  font: ['default', 'sans', 'serif', 'mono'],
  metaFont: ['default', 'sans', 'mono'],
  density: ['default', 'comfortable', 'tight'],
  divider: ['solid', 'dotted', 'dashed'],
  decoration: ['none', 'checker'],
} as const
export const appearanceColors = ['bg', 'text', 'muted', 'accent', 'line'] as const
export const appearanceNumbers = {
  fontSize: { min: 12, max: 18, fallback: 13 },
  padding: { min: 8, max: 28, fallback: 16 },
  radius: { min: 0, max: 24, fallback: 8 },
} as const
export type AppearanceKey = keyof typeof appearanceChoices | typeof appearanceColors[number] | keyof typeof appearanceNumbers
export type EmbedAppearance = Partial<Record<AppearanceKey, string>>

export function parseEmbedAppearance(params: URLSearchParams): EmbedAppearance {
  const result: EmbedAppearance = {}
  for (const [key, choices] of Object.entries(appearanceChoices)) {
    const value = params.get(key)
    if (value && (choices as readonly string[]).includes(value)) result[key as AppearanceKey] = value
  }
  for (const key of appearanceColors) {
    const value = params.get(key)
    if (value?.length === 7 && /^#[0-9a-f]{6}$/i.test(value)) result[key] = value.toLowerCase()
  }
  for (const [key, range] of Object.entries(appearanceNumbers)) {
    const value = params.get(key)
    if (value && value.length <= 2 && !/\D/.test(value) && Number(value) >= range.min && Number(value) <= range.max) {
      result[key as AppearanceKey] = String(Number(value))
    }
  }
  return result
}

export function appearanceQuery(appearance: EmbedAppearance): URLSearchParams {
  return new URLSearchParams(parseEmbedAppearance(new URLSearchParams(appearance)))
}

const fonts: Record<string, string> = {
  sans: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, "SFMono-Regular", Consolas, monospace',
}

export function embedAppearanceStyle(appearance: EmbedAppearance): CSSProperties {
  const a = parseEmbedAppearance(new URLSearchParams(appearance))
  const style: Record<string, string> = {}
  const colors = { bg: ['--paper', '--surface'], text: ['--ink'], muted: ['--ink-2', '--muted', '--faint'], accent: ['--accent', '--accent-ink'], line: ['--line'] }
  for (const key of appearanceColors) {
    if (a[key]) for (const variable of colors[key]) style[variable] = a[key]
  }
  const bodyFont = a.font ? fonts[a.font] : undefined
  const metaFont = a.metaFont ? fonts[a.metaFont] : undefined
  if (bodyFont) {
    style['--embed-font'] = bodyFont
    style['--embed-title-font'] = bodyFont
  }
  if (metaFont) style['--embed-meta-font'] = metaFont
  if (a.fontSize) {
    style['--embed-body-size'] = `${a.fontSize}px`
    style['--embed-title-size'] = `${Number(a.fontSize) + 4}px`
  }
  if (a.padding) style['--embed-padding'] = `${a.padding}px`
  if (a.density === 'tight') style['--embed-row-padding'] = '4px'
  if (a.density === 'comfortable') style['--embed-row-padding'] = '12px'
  if (a.divider) style['--embed-divider'] = a.divider
  // Keep attribution readable even when the chosen text/accent matches the background.
  if (a.bg) style['--embed-brand-ink'] = isDarkBackground(a.bg) ? '#ffffff' : '#000000'
  return style as CSSProperties
}

function isDarkBackground(hex: string): boolean {
  const luminance = [0.2126, 0.7152, 0.0722].reduce((sum, weight, index) => {
    const offset = 1 + index * 2
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255
    const linear = value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    return sum + linear * weight
  }, 0)
  return luminance <= 0.179
}

/** Whether the attribution sits on a dark ground: a custom `bg` decides (as
 * it does for --embed-brand-ink), otherwise the resolved theme. */
export function embedAttributionOnDark(appearance: EmbedAppearance, darkTheme: boolean): boolean {
  const { bg } = parseEmbedAppearance(new URLSearchParams(appearance))
  return bg ? isDarkBackground(bg) : darkTheme
}

/* The frame's border and radius belong on a host-side wrapper element, not on
   the iframe itself: a border painted on the iframe's own box can lose to the
   embedded document's composited layer at fractional device pixels — the
   "bottom border vanishes at 100% zoom" failure. The wrapper owns the chrome
   and clips the frame's corners to its radius. */
export function embedFrameStyle(appearance: EmbedAppearance): CSSProperties {
  const a = parseEmbedAppearance(new URLSearchParams(appearance))
  return {
    border: `1px solid ${a.line ?? 'rgba(128 128 128 / 0.35)'}`,
    borderRadius: `${a.radius ?? 8}px`,
    overflow: 'hidden',
  }
}

export function embedFrameCss(appearance: EmbedAppearance): string {
  const style = embedFrameStyle(appearance)
  return `border:${style.border};border-radius:${style.borderRadius};overflow:${style.overflow}`
}

/* The iframe inside the wrapper fills it edge to edge and carries no chrome of
   its own: block display kills the inline baseline gap, zero border defers to
   the wrapper. Keep the string and object forms in sync — the snippet emits
   one, the live preview renders the other. */
export const embedIframeCss = 'display:block;border:0;width:100%'
export const embedIframeStyle: CSSProperties = { display: 'block', border: 0, width: '100%' }

export function embedHeightAllowance(appearance: EmbedAppearance, rows: number): number {
  const a = parseEmbedAppearance(new URLSearchParams(appearance))
  return Math.max(0, Number(a.fontSize ?? 13) - 13) * (rows * 2 + 5)
    + (a.density === 'comfortable' ? rows * 16 : 0)
    + Math.max(0, Number(a.padding ?? 16) - 16) * 2
}

/* Suggested frame height, shared by the composer snippet and the card's own
   known:embed-resize report. Row pitch ≈33px plus the main/foot chrome
   (~200px default, ~140 compact — compact hides summary and curator), capped
   at a four/three-row preview, plus one row for the "+N more" link when the
   preview truncates. The card scrolls its list inside whatever height the
   frame gives it, so a generous suggestion just means more rows visible at
   once; a tight one still pins the footer. */
export function suggestEmbedHeight({ compact, rowCount, detailHeight = 0, appearance = {} }: {
  compact: boolean
  rowCount: number
  detailHeight?: number
  appearance?: EmbedAppearance
}): number {
  const shown = Math.min(compact ? 3 : 4, rowCount)
  const rows = shown + (rowCount > shown ? 1 : 0)
  return (compact ? 140 : 200) + detailHeight + rows * 33 + embedHeightAllowance(appearance, rows)
}

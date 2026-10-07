import type { SourceType } from '../types/catalog'

export type DeskThemeId = 'paper' | 'ink' | 'mist'

/** R10-26: registered tile skins that are never user-selectable — the
    widget-intrinsic looks (hero gradients, terminal chrome). A picked
    DeskThemeId always replaces them. */
export type TileSkinId = DeskThemeId | 'wash' | 'terminal'

export type DeskTheme = {
  id: DeskThemeId
  label: string
  /** Three preview dots: surface / accent / ink */
  swatches: [string, string, string]
}

/** Curated palettes — cool, low-contrast editorial base only.
 *  Swatches are [surface / accent / ink] and must mirror the actual
 *  token values in src/styles/desk-themes.css for the same theme. */
export const DESK_THEMES: DeskTheme[] = [
  {
    id: 'paper',
    label: 'Paper',
    swatches: ['rgb(253 254 254)', 'rgb(56 102 149)', 'rgb(6 7 10)'],
  },
  {
    id: 'ink',
    label: 'Ink',
    swatches: ['rgb(12 13 16)', 'rgb(109 157 206)', 'rgb(233 235 238)'],
  },
  {
    id: 'mist',
    label: 'Mist',
    swatches: ['rgb(245 251 255)', 'rgb(49 111 151)', 'rgb(13 28 39)'],
  },
]

const THEME_MAP = Object.fromEntries(DESK_THEMES.map((t) => [t.id, t])) as Record<
  DeskThemeId,
  DeskTheme
>

const DEFAULT_IDS: DeskThemeId[] = ['paper', 'ink', 'mist']

/** Per-widget recommended palettes (always a subset of DESK_THEMES). */
const BY_TYPE: Partial<Record<SourceType, DeskThemeId[]>> = {
  search: ['paper', 'mist', 'ink'],
  sticky: ['paper', 'mist', 'ink'],
  todo: ['paper', 'mist', 'ink'],
  weather: ['paper', 'mist', 'ink'],
  pomodoro: ['paper', 'mist', 'ink'],
  clock: ['paper', 'mist', 'ink'],
  quicklinks: ['paper', 'mist', 'ink'],
  habits: ['paper', 'mist', 'ink'],
  reading: ['paper', 'mist', 'ink'],
  ssh: ['ink', 'paper', 'mist'],
  ghheatmap: ['paper', 'ink', 'mist'],
  aichat: ['paper', 'ink', 'mist'],
  wordbook: ['paper', 'mist', 'ink'],
  collectionlist: ['paper', 'mist', 'ink'],
  github: ['ink', 'paper', 'mist'],
  path: ['paper', 'mist', 'ink'],
}

export function isDeskThemeId(v: string): v is DeskThemeId {
  return v in THEME_MAP
}

export function isTileSkinId(v: string): v is TileSkinId {
  return isDeskThemeId(v) || v === 'wash' || v === 'terminal'
}

export function getDeskTheme(id: DeskThemeId): DeskTheme {
  return THEME_MAP[id] ?? THEME_MAP.paper
}

/** User-facing name for a tile skin. Wash/terminal are widget defaults, not picker rows. */
export function tileSkinLabel(id: TileSkinId): string {
  if (id === 'wash') return 'Wash'
  if (id === 'terminal') return 'Terminal'
  return getDeskTheme(id).label
}

export function themesForType(type: SourceType): DeskTheme[] {
  const ids = BY_TYPE[type] ?? DEFAULT_IDS
  return ids.map((id) => THEME_MAP[id]).filter(Boolean)
}

/** Widget-intrinsic default skins (R10-26): weather/sticky ship the shared
    hero-gradient wash, ssh ships the terminal skin — all overridable. */
const DEFAULT_SKIN: Partial<Record<SourceType, TileSkinId>> = {
  weather: 'wash',
  sticky: 'wash',
  ssh: 'terminal',
}

export function defaultThemeForType(type: SourceType): TileSkinId {
  return DEFAULT_SKIN[type] ?? themesForType(type)[0]?.id ?? 'paper'
}

export type ThemeMap = Record<string, DeskThemeId>

export function loadThemeMap(storageKey: string): ThemeMap {
  try {
    const raw = localStorage.getItem(`${storageKey}:themes`)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, string>
    if (!parsed || typeof parsed !== 'object') return {}
    const out: ThemeMap = {}
    for (const [id, theme] of Object.entries(parsed)) {
      if (typeof theme === 'string' && isDeskThemeId(theme)) out[id] = theme
    }
    return out
  } catch {
    return {}
  }
}

export function persistThemeMap(storageKey: string, map: ThemeMap) {
  try {
    localStorage.setItem(`${storageKey}:themes`, JSON.stringify(map))
  } catch {
    /* ignore */
  }
}

export function themeClass(id: TileSkinId | undefined) {
  return id ? `tile-theme-${id}` : 'tile-theme-paper'
}

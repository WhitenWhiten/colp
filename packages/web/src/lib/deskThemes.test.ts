/**
 * P01 contract — desk themes stay on the cool, low-contrast palette.
 * DESK_THEMES must not expose sand / rose / forest / aurora / terminal as
 * normal themes; legacy stored theme ids must fall back to cool defaults.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { BOOKMARK_TYPES, WIDGET_TYPES } from '../types/catalog'
import {
  defaultThemeForType,
  DESK_THEMES,
  getDeskTheme,
  isDeskThemeId,
  loadThemeMap,
  themeClass,
  tileSkinLabel,
  themesForType,
  type DeskThemeId,
} from './deskThemes'

/** The only themes allowed as normal, selectable desk themes. */
const COOL_WHITELIST = ['paper', 'ink', 'mist']
/** Warm / exotic skins that must never appear as normal themes. */
const BANNED_IDS = ['sand', 'rose', 'forest', 'aurora', 'terminal']

/**
 * Canonical [surface / accent / ink] swatches — must mirror the token values
 * declared in src/styles/desk-themes.css for the same theme id.
 */
const SWATCH_FIXTURES: Record<DeskThemeId, [string, string, string]> = {
  paper: ['rgb(253 254 254)', 'rgb(56 102 149)', 'rgb(6 7 10)'],
  ink: ['rgb(12 13 16)', 'rgb(109 157 206)', 'rgb(233 235 238)'],
  mist: ['rgb(245 251 255)', 'rgb(49 111 151)', 'rgb(13 28 39)'],
}

/** Every SourceType value (bookmark ∪ widget lists in types/catalog). */
const ALL_SOURCE_TYPES = [...BOOKMARK_TYPES, ...WIDGET_TYPES]

/** Minimal Storage used to exercise loadThemeMap in the node test env. */
function installLocalStorage(initial: Record<string, string>): () => void {
  const store = new Map(Object.entries(initial))
  const g = globalThis as typeof globalThis & { localStorage?: Storage }
  const previous = g.localStorage
  Object.defineProperty(g, 'localStorage', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: {
      get length() {
        return store.size
      },
      clear: () => {
        store.clear()
      },
      getItem: (key: string) => store.get(key) ?? null,
      key: (index: number) => [...store.keys()][index] ?? null,
      removeItem: (key: string) => {
        store.delete(key)
      },
      setItem: (key: string, value: string) => {
        store.set(String(key), String(value))
      },
    } satisfies Storage,
  })
  return () => {
    if (previous === undefined) {
      Object.defineProperty(g, 'localStorage', {
        configurable: true,
        value: undefined,
      })
    } else {
      g.localStorage = previous
    }
  }
}

describe('deskThemes contract', () => {
  it('exposes only the cool whitelist as normal themes', () => {
    const ids = DESK_THEMES.map((t) => t.id)
    expect(ids).toEqual(COOL_WHITELIST)
    for (const id of BANNED_IDS) {
      expect(ids).not.toContain(id)
    }
  })

  it('keeps one low-contrast cool dark theme (ink)', () => {
    expect(DESK_THEMES.find((t) => t.id === 'ink')).toBeDefined()
  })

  it('preview swatches mirror the desk-themes.css token values', () => {
    for (const theme of DESK_THEMES) {
      expect(theme.swatches).toHaveLength(3)
      expect(theme.swatches).toEqual(SWATCH_FIXTURES[theme.id])
      for (const color of theme.swatches) {
        // Swatches must express the same rgb() colors as the CSS themes —
        // no oklch previews that disagree with the actual theme tokens.
        expect(color).toMatch(/^rgb\(/u)
      }
    }
  })

  it('accepts cool ids and rejects warm/exotic ids', () => {
    for (const id of COOL_WHITELIST) {
      expect(isDeskThemeId(id)).toBe(true)
    }
    for (const id of [...BANNED_IDS, 'bogus', '']) {
      expect(isDeskThemeId(id)).toBe(false)
    }
  })

  it('falls back to paper for unknown theme ids', () => {
    expect(getDeskTheme('paper').id).toBe('paper')
    expect(getDeskTheme('sand' as unknown as DeskThemeId).id).toBe('paper')
    expect(getDeskTheme('bogus' as unknown as DeskThemeId).id).toBe('paper')
  })

  it('recommends only cool themes for every source type', () => {
    expect(ALL_SOURCE_TYPES.length).toBeGreaterThan(0)
    for (const type of ALL_SOURCE_TYPES) {
      const palettes = themesForType(type)
      expect(palettes.length).toBeGreaterThan(0)
      for (const theme of palettes) {
        expect(COOL_WHITELIST).toContain(theme.id)
      }
    }
  })

  /* R10-26: the widget-intrinsic skins are registered tile themes —
     weather/sticky default to the shared hero-gradient wash, ssh to the
     terminal skin. They are defaults, not picker options: a user-picked
     cool theme always replaces them. */
  it('defaults skinned widgets to their registered skin and everything else to a cool theme', () => {
    expect(defaultThemeForType('weather')).toBe('wash')
    expect(defaultThemeForType('sticky')).toBe('wash')
    expect(defaultThemeForType('ssh')).toBe('terminal')
    for (const type of ALL_SOURCE_TYPES) {
      if (type === 'weather' || type === 'sticky' || type === 'ssh') continue
      expect(COOL_WHITELIST).toContain(defaultThemeForType(type))
    }
  })

  it('never exposes widget skins as selectable themes', () => {
    for (const id of ['wash', 'terminal']) {
      expect(isDeskThemeId(id)).toBe(false)
    }
    for (const type of ALL_SOURCE_TYPES) {
      expect(themesForType(type).map((t) => t.id)).not.toContain('wash')
      expect(themesForType(type).map((t) => t.id)).not.toContain('terminal')
    }
  })

  describe('loadThemeMap legacy fallback', () => {
    afterEach(() => {
      // localStorage is restored per test inside each assertion block
    })

    it('returns an empty map when nothing is stored', () => {
      const restore = installLocalStorage({})
      expect(loadThemeMap('known.dashboard.v12')).toEqual({})
      restore()
    })

    it('drops legacy warm theme ids and keeps cool ones', () => {
      const restore = installLocalStorage({
        'known.dashboard.v12:themes': JSON.stringify({
          a: 'sand',
          b: 'terminal',
          c: 'rose',
          d: 'mist',
          e: 'bogus',
        }),
      })
      expect(loadThemeMap('known.dashboard.v12')).toEqual({ d: 'mist' })
      restore()
    })

    it('returns an empty map for invalid JSON', () => {
      const restore = installLocalStorage({
        'known.dashboard.v12:themes': '{not json',
      })
      expect(loadThemeMap('known.dashboard.v12')).toEqual({})
      restore()
    })

    it('returns an empty map for non-object payloads', () => {
      for (const payload of ['null', '"paper"', '[{"id":"paper"}]', '42']) {
        const restore = installLocalStorage({
          'known.dashboard.v12:themes': payload,
        })
        expect(loadThemeMap('known.dashboard.v12')).toEqual({})
        restore()
      }
    })
  })

  it('maps theme ids to tile classes with a paper fallback', () => {
    expect(themeClass('mist')).toBe('tile-theme-mist')
    expect(themeClass(undefined)).toBe('tile-theme-paper')
    expect(themeClass('wash')).toBe('tile-theme-wash')
    expect(themeClass('terminal')).toBe('tile-theme-terminal')
  })

  it('labels intrinsic skins without treating them as picker themes', () => {
    expect(tileSkinLabel('paper')).toBe('Paper')
    expect(tileSkinLabel('wash')).toBe('Wash')
    expect(tileSkinLabel('terminal')).toBe('Terminal')
  })
})

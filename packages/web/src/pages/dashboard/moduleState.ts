import { dashboardModules, type Resource } from '../../api/mock-data'

/** Visible module ids (order preserved). v12 first-run is collection/reading only. */
const MODULES_KEY = 'known.dashboard.module-ids.v12'
const MODULES_LEGACY_KEYS = [
  'known.dashboard.module-ids.v11',
  'known.dashboard.module-ids.v10',
]
/** First-run board: collection/reading work, not startpage toys. */
const DEFAULT_MODULE_TYPES = new Set(['search', 'reading', 'collectionlist', 'quicklinks'])

export function moduleById(id: string): Resource | undefined {
  return dashboardModules.find((m) => m.id === id)
}

function allSeedIds() {
  return dashboardModules.map((m) => m.id)
}

function defaultModuleIds() {
  return dashboardModules.filter((m) => DEFAULT_MODULE_TYPES.has(m.type)).map((m) => m.id)
}

/**
 * Load visible module ids.
 * - No save → collection/reading defaults (toys stay in the add-module catalog)
 * - Saved v12 list → keep order, drop unknown, do NOT re-add removed ids
 * - Missing or empty seen-seeds with a saved v12 list → keep that list and mark
 *   every current seed as already offered (do not treat catalog toys as new)
 * - Non-empty seen-seeds → append seeds that are neither seen nor present
 *   (modules added to the catalog in a later version)
 * - v11/v10 save → migrate as-is so existing layouts that include toys are kept
 */
const SEEN_SEEDS_KEY = 'known.dashboard.seen-seeds.v1'

function markSeedsSeen(ids: string[]) {
  try {
    localStorage.setItem(SEEN_SEEDS_KEY, JSON.stringify(ids))
  } catch {
    /* ignore */
  }
}

export function loadModuleIds(): string[] {
  const seeds = allSeedIds()
  const seedSet = new Set(seeds)
  const defaults = defaultModuleIds()

  try {
    let raw = localStorage.getItem(MODULES_KEY)
    let migratedFromLegacy = false
    if (!raw) {
      for (const key of MODULES_LEGACY_KEYS) {
        const legacy = localStorage.getItem(key)
        if (legacy) {
          raw = legacy
          localStorage.setItem(MODULES_KEY, legacy)
          migratedFromLegacy = true
          break
        }
      }
    }

    if (!raw) {
      markSeedsSeen(seeds)
      return defaults
    }

    const parsed = JSON.parse(raw) as string[]
    if (!Array.isArray(parsed)) return defaults

    const ids = parsed.filter((id) => typeof id === 'string' && seedSet.has(id))

    if (migratedFromLegacy) {
      markSeedsSeen(seeds)
      return ids
    }

    let seen: string[] = []
    try {
      const sraw = localStorage.getItem(SEEN_SEEDS_KEY)
      if (sraw) {
        const sp = JSON.parse(sraw) as string[]
        if (Array.isArray(sp)) seen = sp.filter((x) => typeof x === 'string')
      }
    } catch {
      /* ignore */
    }
    if (seen.length === 0) {
      markSeedsSeen(seeds)
      return ids
    }
    const seenSet = new Set(seen)
    const present = new Set(ids)
    for (const id of seeds) {
      if (!seenSet.has(id) && !present.has(id)) {
        ids.push(id)
        present.add(id)
      }
      seenSet.add(id)
    }
    markSeedsSeen([...seenSet])

    return ids
  } catch {
    return defaults
  }
}

export function persistModuleIds(ids: string[]) {
  try {
    localStorage.setItem(MODULES_KEY, JSON.stringify(ids))
  } catch {
    /* ignore */
  }
}

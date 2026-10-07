/** Persist read marks, save-to-folder, and note/TL;DR for collection resources.
 * Shared across board cards, list/compact rows, and dashboard collection embeds.
 */

const READ_KEY = 'known.resource.read.v1'
const SAVE_KEY = 'known.resource.saved.v1'
const META_KEY = 'known.resource.meta.v1'
const SEED_KEY = 'known.resource.meta.seeded.v1'

export type SavedMap = Record<string, string> // resourceId -> folder name

export type TldrSource = 'ai' | 'user' | 'empty'

export type ResourceMeta = {
  note: string
  tldr: string
  tldrSource: TldrSource
  noteFormat?: 'plain' | 'markdown'
  tldrFormat?: 'plain' | 'markdown'
}

export type ResourceMetaMap = Record<string, ResourceMeta>

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* ignore quota / private mode */
  }
}

function notifyMarksChanged() {
  try {
    window.dispatchEvent(new Event('known-resource-marks'))
  } catch {
    /* ignore */
  }
}

export function emptyMeta(): ResourceMeta {
  return { note: '', tldr: '', tldrSource: 'empty', noteFormat: 'plain', tldrFormat: 'plain' }
}

export function loadReadIds(): Set<string> {
  const arr = readJson<string[]>(READ_KEY, [])
  return new Set(Array.isArray(arr) ? arr : [])
}

export function persistReadIds(ids: Set<string>) {
  writeJson(READ_KEY, [...ids])
  notifyMarksChanged()
}

export function loadSavedMap(): SavedMap {
  const map = readJson<SavedMap>(SAVE_KEY, {})
  return map && typeof map === 'object' ? map : {}
}

export function persistSavedMap(map: SavedMap) {
  writeJson(SAVE_KEY, map)
  notifyMarksChanged()
}

export function toggleReadId(ids: Set<string>, id: string): Set<string> {
  const next = new Set(ids)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  persistReadIds(next)
  return next
}

export function setSavedFolder(map: SavedMap, id: string, folder: string | null): SavedMap {
  const next = { ...map }
  if (folder == null) delete next[id]
  else next[id] = folder
  persistSavedMap(next)
  return next
}

export function loadMetaMap(): ResourceMetaMap {
  const map = readJson<ResourceMetaMap>(META_KEY, {})
  if (!map || typeof map !== 'object') return {}
  let changed = false
  const normalized: ResourceMetaMap = {}
  for (const [id, raw] of Object.entries(map)) {
    const value = raw && typeof raw === 'object' ? raw : {} as ResourceMeta
    const next = {
      ...emptyMeta(),
      ...value,
      noteFormat: value.noteFormat === 'markdown' ? 'markdown' : 'plain',
      tldrFormat: value.tldrFormat === 'markdown' ? 'markdown' : 'plain',
    } as ResourceMeta
    if (JSON.stringify(next) !== JSON.stringify(raw)) changed = true
    normalized[id] = next
  }
  if (changed) writeJson(META_KEY, normalized)
  return normalized
}

export function getResourceMeta(id: string): ResourceMeta {
  return { ...emptyMeta(), ...loadMetaMap()[id] }
}

export function setResourceMeta(id: string, patch: Partial<ResourceMeta>): ResourceMeta {
  const map = loadMetaMap()
  const previous = map[id]
  const next: ResourceMeta = { ...emptyMeta(), ...map[id], ...patch }
  if (patch.note !== undefined && patch.noteFormat === undefined) {
    next.noteFormat = previous?.noteFormat ?? (previous?.note ? 'plain' : (next.note ? 'markdown' : 'plain'))
  }
  if (patch.tldr !== undefined && patch.tldrFormat === undefined) {
    next.tldrFormat = previous?.tldrFormat ?? (previous?.tldr ? 'plain' : (next.tldr ? 'markdown' : 'plain'))
  }
  if (patch.noteFormat !== undefined && patch.noteFormat !== 'plain' && patch.noteFormat !== 'markdown') {
    next.noteFormat = previous?.noteFormat ?? (next.note ? 'markdown' : 'plain')
  }
  if (patch.tldrFormat !== undefined && patch.tldrFormat !== 'plain' && patch.tldrFormat !== 'markdown') {
    next.tldrFormat = previous?.tldrFormat ?? (next.tldr ? 'markdown' : 'plain')
  }
  if (!next.note && !next.tldr) {
    delete map[id]
  } else {
    if (!next.tldr) next.tldrSource = 'empty'
    map[id] = next
  }
  writeJson(META_KEY, map)
  notifyMarksChanged()
  return next
}

/** Seed demo notes/TL;DRs for featured resources once. */
export function applyResourceMetaSeedsOnce(
  seeds: Array<{ id: string; note?: string; tldr?: string }>,
) {
  const version = '1'
  try {
    if (localStorage.getItem(SEED_KEY) === version) return
  } catch {
    return
  }
  const map = loadMetaMap()
  let changed = false
  for (const s of seeds) {
    if (!s.note && !s.tldr) continue
    const cur = map[s.id]
    if (!cur) {
      map[s.id] = {
        note: s.note ?? '',
        tldr: s.tldr ?? '',
        tldrSource: s.tldr ? 'ai' : 'empty',
      }
      changed = true
      continue
    }
    const next = { ...cur }
    if (s.note && !next.note?.trim()) {
      next.note = s.note
      changed = true
    }
    if (s.tldr && !next.tldr?.trim()) {
      next.tldr = s.tldr
      next.tldrSource = next.tldrSource === 'user' ? 'user' : 'ai'
      changed = true
    }
    map[s.id] = next
  }
  if (changed) writeJson(META_KEY, map)
  try {
    localStorage.setItem(SEED_KEY, version)
  } catch {
    /* ignore */
  }
  if (changed) notifyMarksChanged()
}

export function generateTldrDraft(title: string, host: string): string {
  const t = title.trim()
  const h = host.trim()
  const lower = t.toLowerCase()

  if (lower.includes('layout') || lower.includes('typography') || lower.includes('primitive')) {
    return `Practical interface craft from ${h}: strong defaults for spacing, type scale, and resilient layout — skim for patterns you can reuse.`
  }
  if (lower.includes('sqlite') || lower.includes('api') || lower.includes('satori')) {
    return `Technical deep-dive (${h}). Keep as a reference when you hit edge cases or performance trade-offs.`
  }
  if (lower.includes('principle') || lower.includes('inventing')) {
    return `On tools and immediate feedback — the medium shapes what you can invent. Worth a full watch, not a skim.`
  }

  return `Summary of “${t}” (${h}): a short takeaway for later recall. Edit this draft to match what mattered to you.`
}

export function simulateAiTldr(
  title: string,
  host: string,
  delayMs = 720,
): Promise<string> {
  return new Promise((resolve) => {
    window.setTimeout(() => {
      resolve(generateTldrDraft(title, host))
    }, delayMs)
  })
}

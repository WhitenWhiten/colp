/** Persist Library link annotations: read, notes, TL;DR. */

const READ_KEY = 'known.library.read.v1'
const META_KEY = 'known.library.meta.v1'
const SEED_KEY = 'known.library.seeded.v2'

export type TldrSource = 'ai' | 'user' | 'empty'
export type AnnotationFormat = 'plain' | 'markdown'

export type LinkMeta = {
  note: string
  tldr: string
  /** Who last wrote the TL;DR — AI draft or manual edit. */
  tldrSource: TldrSource
  noteFormat?: AnnotationFormat
  tldrFormat?: AnnotationFormat
}

export type LinkMetaMap = Record<string, LinkMeta>

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
    /* ignore */
  }
}

function notify() {
  try {
    window.dispatchEvent(new Event('known-library-marks'))
  } catch {
    /* ignore */
  }
}

export function emptyMeta(): LinkMeta {
  return { note: '', tldr: '', tldrSource: 'empty', noteFormat: 'plain', tldrFormat: 'plain' }
}

export function loadReadIds(): Set<string> {
  const arr = readJson<string[]>(READ_KEY, [])
  return new Set(Array.isArray(arr) ? arr : [])
}

export function persistReadIds(ids: Set<string>) {
  writeJson(READ_KEY, [...ids])
  notify()
}

export function toggleReadId(id: string): Set<string> {
  const next = new Set(loadReadIds())
  if (next.has(id)) next.delete(id)
  else next.add(id)
  persistReadIds(next)
  return next
}

export function loadMetaMap(): LinkMetaMap {
  const map = readJson<LinkMetaMap>(META_KEY, {})
  if (!map || typeof map !== 'object') return {}
  let changed = false
  const out: LinkMetaMap = {}
  for (const [id, value] of Object.entries(map)) {
    if (!value || typeof value !== 'object') continue
    const next: LinkMeta = {
      ...emptyMeta(),
      ...value,
      tldrSource: value.tldrSource === 'ai' || value.tldrSource === 'user' ? value.tldrSource : 'empty',
      noteFormat: value.noteFormat === 'markdown' ? 'markdown' : 'plain',
      tldrFormat: value.tldrFormat === 'markdown' ? 'markdown' : 'plain',
    }
    if (value.tldrSource !== next.tldrSource) changed = true
    if (value.noteFormat !== next.noteFormat) changed = true
    if (value.tldrFormat !== next.tldrFormat) changed = true
    out[id] = next
  }
  if (changed) writeJson(META_KEY, out)
  return out
}

export function getLinkMeta(id: string): LinkMeta {
  return { ...emptyMeta(), ...loadMetaMap()[id] }
}

export function setLinkMeta(id: string, patch: Partial<LinkMeta>): LinkMeta {
  const map = loadMetaMap()
  const previous = map[id]
  const next: LinkMeta = { ...emptyMeta(), ...previous, ...patch }
  // Store-level format policy: legacy/plain content keeps its format; newly
  // authored non-empty text defaults to Markdown; clearing a field is plain.
  if ('note' in patch) {
    next.noteFormat = next.note.trim()
      ? (patch.noteFormat === 'markdown' || patch.noteFormat === 'plain'
          ? patch.noteFormat
          : previous?.noteFormat ?? (previous?.note?.trim() ? 'plain' : 'markdown'))
      : 'plain'
  } else if ('noteFormat' in patch) {
    next.noteFormat = patch.noteFormat === 'markdown' || patch.noteFormat === 'plain'
      ? patch.noteFormat
      : previous?.noteFormat ?? 'plain'
  }
  if ('tldr' in patch) {
    next.tldrFormat = next.tldr.trim()
      ? (patch.tldrFormat === 'markdown' || patch.tldrFormat === 'plain'
          ? patch.tldrFormat
          : previous?.tldrFormat ?? (previous?.tldr?.trim() ? 'plain' : 'markdown'))
      : 'plain'
  } else if ('tldrFormat' in patch) {
    next.tldrFormat = patch.tldrFormat === 'markdown' || patch.tldrFormat === 'plain'
      ? patch.tldrFormat
      : previous?.tldrFormat ?? 'plain'
  }
  if (next.tldrSource !== 'ai' && next.tldrSource !== 'user' && next.tldrSource !== 'empty') {
    next.tldrSource = next.tldr ? 'user' : 'empty'
  }
  // Drop empty records to keep storage small
  if (!next.note && !next.tldr) {
    delete map[id]
  } else {
    if (!next.tldr) next.tldrSource = 'empty'
    map[id] = next
  }
  writeJson(META_KEY, map)
  notify()
  return next
}

/** Apply demo seed note/tldr once per seed version; fill empty fields only. */
export function applyLibrarySeedsOnce(
  seeds: Array<{ id: string; note?: string; tldr?: string }>,
) {
  const version = '2'
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
        noteFormat: 'plain',
        tldrFormat: 'plain',
      }
      changed = true
      continue
    }
    // Upgrade path: fill empty fields so dual Note+TL;DR demos appear without wiping edits
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
  if (changed) notify()
}

/** Demo AI TL;DR — no API key; grounded on title/host. */
export function generateTldrDraft(title: string, host: string): string {
  const t = title.trim()
  const h = host.trim()
  const lower = t.toLowerCase()

  if (lower.includes('layout') || lower.includes('typography')) {
    return `Practical interface craft from ${h}: strong defaults for spacing, type scale, and resilient layout — skim for patterns you can reuse in components.`
  }
  if (lower.includes('api') || lower.includes('sqlite') || lower.includes('satori')) {
    return `Technical deep-dive (${h}). Captures how the system works under the hood — keep as a reference when you hit edge cases or performance trade-offs.`
  }
  if (lower.includes('书单') || lower.includes('分布式')) {
    return `Curated reading list on distributed systems. Prioritize 1–2 foundations first; park the rest under “later” so the path stays finishable.`
  }
  if (lower.includes('design') || h.includes('increment') || h.includes('practical')) {
    return `Editorial take on design/engineering practice. TL;DR: one clear principle plus examples — note what you’d adopt vs. skip.`
  }

  return `Summary of “${t}” (${h}): a short takeaway for later recall. Edit this draft to match what actually mattered to you.`
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

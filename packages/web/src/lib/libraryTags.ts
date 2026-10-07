/* Library tag vocabulary and tag filtering. Tags compare case-insensitively
   (the extension store does the same), and a tag shown in a list takes the
   spelling most bookmarks use. */

export type TagCount = { tag: string; count: number }
export type TagMatch = 'all' | 'any'

export const tagKey = (tag: string) => tag.toLowerCase()

/** Every tag on these bookmarks, most used first, then alphabetical. */
export function countTags(nodes: ReadonlyArray<{ tags?: readonly string[] }>): TagCount[] {
  const counts = new Map<string, { count: number; spellings: Map<string, number> }>()
  for (const node of nodes) {
    const seen = new Set<string>()
    for (const tag of node.tags ?? []) {
      const key = tagKey(tag)
      if (!tag.trim() || seen.has(key)) continue
      seen.add(key)
      const entry = counts.get(key) ?? { count: 0, spellings: new Map<string, number>() }
      entry.count += 1
      entry.spellings.set(tag, (entry.spellings.get(tag) ?? 0) + 1)
      counts.set(key, entry)
    }
  }
  return [...counts.values()]
    .map(({ count, spellings }) => ({
      tag: [...spellings].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0],
      count,
    }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
}

/** True when the bookmark carries every (or, for 'any', at least one) selected tag. */
export function matchesTags(tags: readonly string[] | undefined, selected: readonly string[], match: TagMatch): boolean {
  if (selected.length === 0) return true
  const own = new Set((tags ?? []).map(tagKey))
  return match === 'any'
    ? selected.some((tag) => own.has(tagKey(tag)))
    : selected.every((tag) => own.has(tagKey(tag)))
}

/** Adds the tag, or removes it when already selected. */
export function toggleTag(selected: readonly string[], tag: string): string[] {
  const key = tagKey(tag)
  return selected.some((value) => tagKey(value) === key)
    ? selected.filter((value) => tagKey(value) !== key)
    : [...selected, tag]
}

/* URL state: one `tag` parameter per selected tag (tags may contain commas)
   and `tagmatch=any` when any tag may match; all-tags is the default. */
export function readTagParams(params: URLSearchParams): { tags: string[]; match: TagMatch } {
  const tags: string[] = []
  for (const tag of params.getAll('tag')) {
    if (tag.trim() && !tags.some((value) => tagKey(value) === tagKey(tag))) tags.push(tag)
  }
  return { tags, match: params.get('tagmatch') === 'any' ? 'any' : 'all' }
}

export function writeTagParams(params: URLSearchParams, tags: readonly string[], match: TagMatch): URLSearchParams {
  const next = new URLSearchParams(params)
  next.delete('tag')
  next.delete('tagmatch')
  for (const tag of tags) next.append('tag', tag)
  if (match === 'any' && tags.length > 1) next.set('tagmatch', 'any')
  return next
}

/**
 * A bookmark's tags after a bulk change: `remove` drops tags case-insensitively,
 * then each `add` tag is appended unless the bookmark already has it in some
 * spelling. Untouched tags keep their place and spelling.
 */
export function retag(tags: readonly string[], add: readonly string[], remove: readonly string[], limit = 64): string[] {
  const drop = new Set(remove.map(tagKey))
  const next = tags.filter((tag) => !drop.has(tagKey(tag)))
  for (const tag of add) {
    if (next.length >= limit) break
    if (!next.some((value) => tagKey(value) === tagKey(tag))) next.push(tag)
  }
  return next
}

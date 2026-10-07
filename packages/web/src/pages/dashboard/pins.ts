export type PinnedPath = { slug: string; title: string }

function isPublicSlug(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.length > 0
}

export function publicOwnedPins(
  items: readonly { collection: { publicationSlug: string | null; title: string } }[],
): PinnedPath[] {
  const pins: PinnedPath[] = []
  for (const item of items) {
    const slug = item.collection.publicationSlug
    if (!isPublicSlug(slug)) continue
    pins.push({ slug, title: item.collection.title })
    if (pins.length === 2) break
  }
  return pins
}

export function fillPinsFromExplore(
  ownedPins: readonly PinnedPath[],
  exploreItems: readonly { publicationSlug: string | null; title: string }[],
): PinnedPath[] {
  const pins = [...ownedPins]
  const seen = new Set(ownedPins.map((pin) => pin.slug))
  for (const item of exploreItems) {
    if (pins.length >= 2) break
    const slug = item.publicationSlug
    if (!isPublicSlug(slug) || seen.has(slug)) continue
    seen.add(slug)
    pins.push({ slug, title: item.title })
  }
  return pins
}

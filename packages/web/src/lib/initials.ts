/** Two-letter monogram for a person/curator: first letters of the first two
    words of the display name, or the first two characters of a single-word
    name — falling back to the handle. Shared by profile pages, hover cards
    and collection curator chips. */
export function profileInitials(displayName: string, handle: string): string {
  const source = displayName.trim() || handle
  const words = source.split(/\s+/u).filter(Boolean)
  const initials = words.length > 1
    ? `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}`
    : source.slice(0, 2)
  return initials.toLocaleUpperCase().slice(0, 2)
}

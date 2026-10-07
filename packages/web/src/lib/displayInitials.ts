/** First letters of each space-separated name part (max 2), used only as the
   fallback inside an avatar when no custom avatar image exists. */
export function displayInitials(displayName: string): string {
  return displayName
    .trim()
    .split(/\s+/u)
    .map((part) => part[0] ?? '')
    .join('')
    .slice(0, 2)
}

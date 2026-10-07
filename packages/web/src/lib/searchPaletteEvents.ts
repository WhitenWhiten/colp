export const OPEN_SEARCH_PALETTE_EVENT = 'known:open-search-palette'

export function openSearchPalette(): void {
  window.dispatchEvent(new Event(OPEN_SEARCH_PALETTE_EVENT))
}

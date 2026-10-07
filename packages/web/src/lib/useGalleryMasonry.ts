import { useCallback, useRef } from 'react'

/**
 * LP-06 Gallery masonry. The board is a CSS grid with tiny implicit rows
 * (`grid-auto-rows` = GALLERY_ROW_UNIT_PX in cards-ui.css); each card spans
 * as many rows as its own height plus one column gap. Cards stay in DOM
 * order, so keyboard and screen-reader order is the curator's order (CSS
 * columns would read column by column).
 *
 * One ResizeObserver measures every card; a MutationObserver picks up cards
 * appended by "load more". R15-28: each callback reads every size from the
 * observer entries and the gap once, then writes all spans, so a batch of
 * n cards costs one layout instead of n (it was O(n²) on large boards). Covers carry width/height attributes, so the
 * first measurement already includes their reserved box and images loading
 * later never shift the layout. Without ResizeObserver (tests, old
 * browsers) cards keep the CSS fallback span.
 */
export const GALLERY_ROW_UNIT_PX = 4
const CARD_SELECTOR = ':scope > [data-gallery-card]'

export function useGalleryMasonry(): (board: HTMLElement | null) => void {
  const cleanup = useRef<(() => void) | null>(null)
  return useCallback((board: HTMLElement | null) => {
    cleanup.current?.()
    cleanup.current = null
    if (board === null || typeof ResizeObserver === 'undefined') return
    const resize = new ResizeObserver((entries) => {
      const gap = Number.parseFloat(getComputedStyle(board).columnGap) || 0
      const spans: Array<[HTMLElement, number]> = []
      for (const entry of entries) {
        const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height
        spans.push([entry.target as HTMLElement, Math.max(1, Math.ceil((height + gap) / GALLERY_ROW_UNIT_PX))])
      }
      for (const [card, rows] of spans) card.style.setProperty('--gallery-span', String(rows))
    })
    for (const card of board.querySelectorAll<HTMLElement>(CARD_SELECTOR)) resize.observe(card)
    const mutations = typeof MutationObserver === 'undefined'
      ? null
      : new MutationObserver((records) => {
          for (const record of records) {
            for (const node of record.addedNodes) {
              if (node instanceof HTMLElement && node.matches('[data-gallery-card]')) resize.observe(node)
            }
          }
        })
    mutations?.observe(board, { childList: true })
    cleanup.current = () => {
      resize.disconnect()
      mutations?.disconnect()
    }
  }, [])
}

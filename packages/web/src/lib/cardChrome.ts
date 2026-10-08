/**
 * Edit-mode drag chrome (lock / color / remove / grip).
 * Layout x/y/w/h always describe the **content** box; chrome is rendered
 * above that box only while layout is editable.
 */
export const CARD_CHROME_H = 40

/** Shell rect drawn on the board (content + optional chrome). */
export function shellFromContent(
  layout: { x: number; y: number; w: number; h: number },
  editable: boolean,
  chromeH: number = CARD_CHROME_H,
): { x: number; y: number; w: number; h: number } {
  if (!editable) {
    return { x: layout.x, y: layout.y, w: layout.w, h: layout.h }
  }
  return {
    x: layout.x,
    y: layout.y - chromeH,
    w: layout.w,
    h: layout.h + chromeH,
  }
}

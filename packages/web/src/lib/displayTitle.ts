/** Wide (CJK / fullwidth) code points take about two Latin columns. */
const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]/u

/** Visual length of a headline, in Latin-column units. */
export function displayTitleLength(text: string): number {
  let units = 0
  for (const char of text) units += WIDE.test(char) ? 2 : 1
  return units
}

/** Above this, a user title set at a display rung stacks into a tower
 *  (R12-04): about 48 Latin characters or 24 Han characters. */
export const LONG_DISPLAY_TITLE_UNITS = 48

export function isLongDisplayTitle(title: unknown): boolean {
  return typeof title === 'string' && displayTitleLength(title) > LONG_DISPLAY_TITLE_UNITS
}

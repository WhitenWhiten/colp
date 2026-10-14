/**
 * chrome.action badge colors. setBadgeBackgroundColor needs a CSS color
 * string, so these mirror design/tokens.css by hand:
 * BADGE_ACCENT is --accent, BADGE_DANGER is --danger, BADGE_MUTED is --muted.
 * tests/badge-colors.contract.test.ts pins both against the token source.
 */
export const BADGE_ACCENT = '#386695';
export const BADGE_DANGER = '#9d3533';
export const BADGE_MUTED = '#616367';

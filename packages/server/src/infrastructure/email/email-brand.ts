/**
 * Email-safe Know-N brand constants.
 *
 * The chrome header lockup is plain text ("Know-N" in the shared sans stack,
 * inlined in unified-email-chrome.ts): hosted images get blocked by default in
 * most clients, and a text lockup never renders broken.
 */

/**
 * Single source for the email sans stack (tokens.css uses "Instrument Sans",
 * which is a hosted web font — email clients fall back to this system stack).
 * CJK fallbacks mirror the web font stack ('PingFang SC' / 'Microsoft YaHei' /
 * 'Noto Sans SC') so mixed-script copy renders consistently.
 */
export const EMAIL_FONT_SANS =
  "'Segoe UI', 'Helvetica Neue', Arial, 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', sans-serif";

/** Plain-text product signature shared by chrome and purpose inner templates. */
export const EMAIL_SIGNATURE = '— Know-N';

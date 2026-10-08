const CONTROL_OR_NEWLINE = /[\u0000-\u001F\u007F]/gu;

export const PUBLIC_SHELL_TITLE_MAX = 300;
export const PUBLIC_SHELL_DESCRIPTION_MAX = 500;
/**
 * Search-snippet / social-card bound for `<meta name="description">` and
 * `og:description`. Longer text is rewritten by Google and hard-cut on cards;
 * the no-JS body keeps the full PUBLIC_SHELL_DESCRIPTION_MAX text instead.
 */
export const PUBLIC_SHELL_META_DESCRIPTION_MAX = 160;

export function sanitizePublicShellText(value: string, maxLength: number): string {
  const stripped = value.replace(CONTROL_OR_NEWLINE, '').replace(/\s+/gu, ' ').trim();
  return stripped.length <= maxLength ? stripped : stripped.slice(0, maxLength);
}

/**
 * Mirror of the generator's `truncateMetaDescription`: cut at the last
 * sentence boundary inside the window, else at the last space (when it keeps
 * at least 40 characters), else hard-cut. Never pads or invents an ellipsis.
 */
export function truncatePublicShellDescription(
  text: string,
  maxLength: number = PUBLIC_SHELL_META_DESCRIPTION_MAX,
): string {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  const window = normalized.slice(0, maxLength);
  const boundary = /(?:[.!?](?=\s|$)|[。！？])/gu;
  let last = -1;
  for (const match of window.matchAll(boundary)) last = (match.index ?? 0) + match[0].length;
  if (last > 0) return window.slice(0, last).trim();
  const lastSpace = window.lastIndexOf(' ');
  return (lastSpace >= 40 ? window.slice(0, lastSpace) : window).trim();
}

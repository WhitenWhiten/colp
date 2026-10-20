// Generated from packages/node/src/sync/browser-ingress-title.ts; do not edit.
/** Known browser-ingress storage profile; the wider COLP schema remains unchanged. */
export const BROWSER_INGRESS_TITLE_MAX_CODE_UNITS = 512;
export const BROWSER_INGRESS_TITLE_MAX_UTF8_BYTES = 1024;
export type BrowserIngressTitleIssue = 'length' | 'whitespace' | 'bytes';

/** Validate without truncating or normalizing native content. */
export function browserIngressTitleIssue(
  title: unknown,
  kind: 'bookmark' | 'folder',
): BrowserIngressTitleIssue | null {
  if (typeof title !== 'string' || title.length > BROWSER_INGRESS_TITLE_MAX_CODE_UNITS
    || (kind === 'folder' && title.length === 0)) return 'length';
  if (title !== '' && title.trim().length === 0) return 'whitespace';
  if (new TextEncoder().encode(title).byteLength > BROWSER_INGRESS_TITLE_MAX_UTF8_BYTES) return 'bytes';
  return null;
}

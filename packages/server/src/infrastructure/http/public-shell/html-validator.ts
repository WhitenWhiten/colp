import { createHash } from 'node:crypto';

/** Validate the complete injected document, including its build's asset URLs. */
export function publicHtmlEtag(body: Uint8Array): string {
  // Compression at nginx/the CDN can change bytes without changing the document.
  return `W/"html-${createHash('sha256').update(body).digest('hex')}"`;
}

/** GET/HEAD use weak comparison. Malformed conditions fall back to a full 200. */
export function publicHtmlMatches(value: string | undefined, etag: string): boolean {
  if (value === undefined) return false;
  if (value.trim() === '*') return true;
  // A comma inside an opaque tag is legal; do not split the field on commas.
  const tag = '(?:W/)?"[\\x21\\x23-\\x7e\\x80-\\xff]*"';
  if (!new RegExp(`^[\\t ]*${tag}(?:[\\t ]*,[\\t ]*${tag})*[\\t ]*$`, 'u').test(value)) return false;
  const current = etag.replace(/^W\//u, '');
  return [...value.matchAll(/(?:W\/)?"[^"]*"/gu)]
    .some(([candidate]) => candidate.replace(/^W\//u, '') === current);
}

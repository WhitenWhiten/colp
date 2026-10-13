import { createHash } from 'node:crypto';

/**
 * Frozen copy of `automationDigest` (colp.automation.digest/v1) for migrations, so a later runtime
 * change cannot alter what an already-written migration computes. JSON Canonicalization (RFC 8785)
 * of plain JSON is sorted-key JSON with ECMAScript number and string serialization.
 */
export function automationDigestV1(value: unknown): string {
  return createHash('sha256').update(canonical({ version: 'colp.automation.digest/v1', value }), 'utf8').digest('hex');
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('Digest requires finite numbers.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

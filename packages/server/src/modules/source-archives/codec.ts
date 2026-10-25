import { createHash } from 'node:crypto';
export class SourceArchiveError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); }
}
export function sourceHash(value: unknown): string {
  const normalize = (v: unknown): unknown => Array.isArray(v) ? v.map(normalize) : v && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, val]) => [k, normalize(val)])) : v;
  return `sha256:${createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex')}`;
}
export function object(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) throw new SourceArchiveError('invalid_source_document', 422);
  return v as Record<string, unknown>;
}
export function text(v: unknown, max = 256): string {
  if (typeof v !== 'string' || !v.length || v.length > max || /[\u0000-\u001f]/u.test(v)) throw new SourceArchiveError('invalid_source_document', 422);
  return v;
}
export function integer(v: unknown, min = 1): number {
  if (!Number.isSafeInteger(v) || Number(v) < min) throw new SourceArchiveError('invalid_source_document', 422); return Number(v);
}
export function digest(v: unknown): string { const s = text(v); if (!/^sha256:[a-f0-9]{64}$/.test(s)) throw new SourceArchiveError('invalid_source_digest', 422); return s; }

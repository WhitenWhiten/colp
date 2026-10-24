/** Small closed JSON schema algebra. No generated code/eval in privileged worlds. */
export type Check = (value: unknown) => boolean;
export const str = (max: number, min = 1): Check => v => typeof v === 'string' && v.length >= min && v.length <= max;
export const literal = (...values: readonly unknown[]): Check => v => values.includes(v);
export const integer: Check = v => Number.isSafeInteger(v) && (v as number) >= 0;
export const optional = (check: Check): Check => v => v === undefined || check(v);
export const union = (...checks: readonly Check[]): Check => v => checks.some(c => c(v));
export const array = (check: Check, max: number, min = 0, key?: (v: unknown) => unknown): Check => v =>
  Array.isArray(v) && v.length >= min && v.length <= max && v.every(check)
  && (!key || new Set(v.map(key)).size === v.length);
export const object = (fields: Readonly<Record<string, Check>>, refine?: Check): Check => v => {
  if (!v || typeof v !== 'object' || Array.isArray(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return false;
  const data = v as Record<string, unknown>;
  return Object.keys(data).every(k => Object.hasOwn(fields, k))
    && Object.entries(fields).every(([k, c]) => c(data[k])) && (!refine || refine(v));
};
/** Validate JSON before stringify, including depth, nonfinite values and unsafe keys. */
export function jsonBytes(value: unknown, max: number): boolean {
  let nodes = 0;
  const walk = (v: unknown, depth: number): boolean => {
    if (++nodes > 100_000 || depth > 32) return false;
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return true;
    if (typeof v === 'number') return Number.isFinite(v);
    if (Array.isArray(v)) return v.every(x => walk(x, depth + 1));
    if (!v || typeof v !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return false;
    return Object.entries(Object.getOwnPropertyDescriptors(v)).every(([k, d]) =>
      !['__proto__', 'prototype', 'constructor'].includes(k) && 'value' in d && walk(d.value, depth + 1));
  };
  try { return walk(value, 0) && new TextEncoder().encode(JSON.stringify(value)).byteLength <= max; } catch { return false; }
}

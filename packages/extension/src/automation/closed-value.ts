/**
 * Reading stored and imported JSON the closed way (doc 17 §4, §5): a value is an object, has every key
 * it must have and no key outside the format. Anything else is dropped or refused, never guessed at.
 */
export const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Every required key is there and no other key is. */
export function closed(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every((key) => key in value) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

/** The `format` a file says it has, to tell a later format (`unsupported`) from a broken file (`invalid`). */
export function formatOf(text: string): unknown {
  try { const value: unknown = JSON.parse(text); return record(value) ? value.format : undefined; } catch { return undefined; }
}

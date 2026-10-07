/**
 * Minimal structural type guards shared by the cache contract module.
 *
 * The repository defines local `isRecord` guards per surface (for example
 * src/infrastructure/outbox/envelope.ts) and exposes no shared exported guard,
 * so this module keeps one copy for the cache surfaces instead of duplicating
 * the predicate in every cache file.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

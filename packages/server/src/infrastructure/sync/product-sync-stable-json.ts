/**
 * Deterministic JSON for Product Sync idempotent response bodies and cursor
 * payloads.
 *
 * Product command receipts persist the exact bytes produced here and cursor
 * HMACs sign them, so legal values keep their historical encoding (UTF-16
 * sorted keys, no whitespace). `undefined` used to be interpolated as the
 * literal `undefined` (`{"a":undefined}`, `[1,,3]`), which is not JSON.
 * Callers choose the boundary policy explicitly:
 *
 * - `omit` (response bodies): object members with `undefined` are omitted and
 *   array entries (including holes) become `null`, matching `JSON.stringify` semantics.
 * - `reject` (signed cursors): any `undefined` in the payload fails closed,
 *   because silently dropping a field would change the signed payload.
 *
 * A top-level `undefined` is never encodable and always throws.
 */
export {
  encodeProductStableJson as stableJson,
  type ProductStableJsonUndefinedPolicy as StableJsonUndefinedPolicy,
} from '../../modules/canonical-json/index.js';

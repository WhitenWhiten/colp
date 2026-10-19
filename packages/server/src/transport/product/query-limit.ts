/**
 * Product route page limits are one positive decimal string with a route-owned
 * maximum. Routes still own their problem code and messages; this helper only
 * classifies the value so eleven copies cannot drift on leading zeroes,
 * whitespace, Number() coercions or the upper bound.
 */
export type ProductLimit =
  | { readonly ok: true; readonly value: number | undefined }
  | { readonly ok: false };

export function parseProductLimit(raw: unknown, max: number): ProductLimit {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'string' || !/^[1-9][0-9]*$/u.test(raw)) return { ok: false };
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) return { ok: false };
  return { ok: true, value };
}

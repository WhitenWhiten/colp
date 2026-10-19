/**
 * Deterministic JSON for digests and signed wire bodies: object keys are
 * sorted, arrays keep order and there is no whitespace. The callback owns the
 * caller's failure vocabulary because Pull, Ack and import previews each turn
 * an unencodable value into a different stable error code.
 */
export function canonicalJson(value: unknown, onInvalid: () => never): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, onInvalid)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], onInvalid)}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) onInvalid();
  return encoded as string;
}

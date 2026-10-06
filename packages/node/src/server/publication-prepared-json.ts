/**
 * Internal cache for final, deeply immutable, validated wire representations.
 * Never register caller-owned data or bytes before the receive/produce gate.
 * Neither registration nor lookup is exported by a public package entry.
 */
const preparedBytes = new WeakMap<object, Uint8Array>();

export function rememberPublicationJsonBytes(value: object, bytes: Uint8Array): void {
  if (!Object.isFrozen(value)) throw new TypeError('Prepared publication data must be immutable.');
  preparedBytes.set(value, bytes.slice());
}

/** Return detached bytes; no caller can mutate another response's representation. */
export function preparedPublicationJsonBytes(value: unknown): Uint8Array | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  return preparedBytes.get(value)?.slice();
}

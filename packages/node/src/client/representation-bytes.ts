import { utf8ByteLength } from '../shared/utf8-length.js';

const ownedByteCounts = new WeakMap<object, number>();

export const representationByteDiagnostics = {
  measures: 0,
  reuses: 0,
  reset(): void {
    this.measures = 0;
    this.reuses = 0;
  },
};

export function measureJsonUtf8Bytes(value: unknown): number {
  representationByteDiagnostics.measures += 1;
  const source = JSON.stringify(value);
  if (source === undefined) {
    throw new TypeError('Cached representation is not JSON serializable.');
  }
  return utf8ByteLength(source);
}

/** Remember a count for an object this client isolated. External cache entries are not recorded. */
export function rememberOwnedJsonUtf8Bytes(value: object, bytes: number): void {
  ownedByteCounts.set(value, bytes);
}

export function ownedJsonUtf8Bytes(value: object): number | undefined {
  return ownedByteCounts.get(value);
}

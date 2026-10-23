/** Browser-safe provenance shared by the two strict JSON snapshot factories. */
export interface JsonSnapshotProof {
  readonly maxDepth: number;
  readonly maxMembers: number;
  readonly maxBytes: number;
  readonly observedDepth: number;
  /** Own keys, including each array's length slot. */
  readonly observedMembers: number;
  /** JSON members, excluding array length metadata. */
  readonly observedJsonMembers: number;
  readonly observedBytes: number;
  /** Sanitizing undefined fields may leave conservative input charges. */
  readonly exact: boolean;
}

const proofs = new WeakMap<object, JsonSnapshotProof>();

export function readJsonSnapshotProof(value: object): JsonSnapshotProof | undefined {
  return proofs.get(value);
}

/** Internal factory capability. This module is absent from public package exports. */
export function recordJsonSnapshotProof(value: object, proof: JsonSnapshotProof): void {
  if (!Object.isFrozen(value) || proofs.has(value)) throw new TypeError('Snapshot proof requires a fresh frozen value.');
  proofs.set(value, Object.freeze(proof));
}

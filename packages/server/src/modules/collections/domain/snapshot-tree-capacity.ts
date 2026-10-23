/** Same numbers T-01 froze on the extension Snapshot 0.2 support surface. */
export const SNAPSHOT_TREE_CAPACITY = Object.freeze({
  maxNodes: 10_000,
  maxAggregateBytes: 2 * 1024 * 1024,
});

/** Website/import must refuse before accepting data that cannot be snapshotted. */
export class SnapshotTreeCapacityError extends Error {
  readonly code = 'payload_too_large' as const;

  constructor(message = 'The collection would exceed the supported Snapshot tree capacity.') {
    super(message);
    this.name = 'SnapshotTreeCapacityError';
  }
}

/** Explicit sort-algorithm version; included in Snapshot identity so old rows stay frozen. */
export const SNAPSHOT_MATERIALIZATION_SORT_VERSION = 'parent-first-v1';

export const SNAPSHOT_MATERIALIZATION_EXTENSION =
  'https://known.example/extensions/sync-snapshot-materialization';

export function snapshotMaterializationExtensionValue(): { readonly sortAlgorithm: string } {
  return { sortAlgorithm: SNAPSHOT_MATERIALIZATION_SORT_VERSION };
}

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

export function admitSnapshotTreeGrowth(input: {
  readonly liveNodeCount: number;
  readonly extraNodes: number;
  readonly liveEstimatedBytes: number;
  readonly extraBytes: number;
  readonly maxNodes?: number;
  readonly maxAggregateBytes?: number;
}): void {
  const maxNodes = input.maxNodes ?? SNAPSHOT_TREE_CAPACITY.maxNodes;
  const maxAggregateBytes = input.maxAggregateBytes ?? SNAPSHOT_TREE_CAPACITY.maxAggregateBytes;
  if (!Number.isSafeInteger(input.liveNodeCount) || input.liveNodeCount < 0
      || !Number.isSafeInteger(input.extraNodes) || input.extraNodes < 0
      || !Number.isSafeInteger(input.liveEstimatedBytes) || input.liveEstimatedBytes < 0
      || !Number.isSafeInteger(input.extraBytes) || input.extraBytes < 0) {
    throw new SnapshotTreeCapacityError('Snapshot tree capacity inputs are invalid.');
  }
  if (input.liveNodeCount + input.extraNodes > maxNodes) {
    throw new SnapshotTreeCapacityError(
      `The collection would exceed the ${maxNodes}-node Snapshot support limit.`,
    );
  }
  if (input.liveEstimatedBytes + input.extraBytes > maxAggregateBytes) {
    throw new SnapshotTreeCapacityError(
      `The collection would exceed the ${maxAggregateBytes}-byte Snapshot aggregate limit.`,
    );
  }
}

export function estimateSnapshotNodeBytes(input: {
  readonly id: string;
  readonly title: string;
  readonly url: string | null;
  readonly description: string | null;
  readonly tags: readonly string[];
}): number {
  return Buffer.byteLength(JSON.stringify({
    id: input.id, title: input.title, url: input.url, description: input.description, tags: input.tags,
  }), 'utf8') + 192;
}

/** Explicit sort-algorithm version; included in Snapshot identity so old rows stay frozen. */
export const SNAPSHOT_MATERIALIZATION_SORT_VERSION = 'parent-first-v1';

export const SNAPSHOT_MATERIALIZATION_EXTENSION =
  'https://known.example/extensions/sync-snapshot-materialization';

export function snapshotMaterializationExtensionValue(): { readonly sortAlgorithm: string } {
  return { sortAlgorithm: SNAPSHOT_MATERIALIZATION_SORT_VERSION };
}

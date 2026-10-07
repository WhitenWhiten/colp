import canonicalize from 'canonicalize';

import type { Snapshot } from '../types/index.js';
import {
  preserveExtensionCarrier,
  type ExtensionRemovalAudit,
  type ExtensionSecurityPolicy,
} from '../schema/extensions.js';
import type { SemanticIssue } from './index.js';

function issue(code: string, path: string, message: string): SemanticIssue {
  return { code, path, message };
}

// ---------------------------------------------------------------------------
// Pure edge / identity helpers (stateless; safe to share with validation)
// ---------------------------------------------------------------------------

export type LiveResourceType = 'collection' | 'node' | 'annotation' | 'attachment' | 'relation';

export interface LiveResourceIdentity {
  readonly resourceType: LiveResourceType;
  readonly resource: { readonly id: string; readonly collectionId?: string };
  readonly path: string;
}

/** Enumerates live Snapshot resources with JSON Pointer paths (optional page prefix). */
export function liveResourceIdentities(snapshot: Snapshot, prefix = ''): LiveResourceIdentity[] {
  return [
    { resourceType: 'collection', resource: snapshot.collection, path: `${prefix}/collection` },
    ...snapshot.nodes.map((resource, index) => ({
      resourceType: 'node' as const,
      resource,
      path: `${prefix}/nodes/${index}`,
    })),
    ...snapshot.annotations.map((resource, index) => ({
      resourceType: 'annotation' as const,
      resource,
      path: `${prefix}/annotations/${index}`,
    })),
    ...snapshot.attachments.map((resource, index) => ({
      resourceType: 'attachment' as const,
      resource,
      path: `${prefix}/attachments/${index}`,
    })),
    ...snapshot.relations.map((resource, index) => ({
      resourceType: 'relation' as const,
      resource,
      path: `${prefix}/relations/${index}`,
    })),
  ];
}

export interface GraphEdge {
  readonly targetId: string;
  readonly path: string;
}

/** Detects directed cycles in a single-out-edge map (Parent or Alias chains). */
export function findCycles(
  edges: ReadonlyMap<string, GraphEdge>,
  code: 'parent_cycle' | 'alias_cycle',
  label: 'Parent' | 'Alias',
): SemanticIssue[] {
  const issues: SemanticIssue[] = [];
  const state = new Map<string, 0 | 1 | 2>();
  for (const startId of edges.keys()) {
    if ((state.get(startId) ?? 0) !== 0) continue;

    const path: string[] = [];
    const pathIndex = new Map<string, number>();
    let id: string | undefined = startId;
    while (id !== undefined && (state.get(id) ?? 0) === 0) {
      state.set(id, 1);
      pathIndex.set(id, path.length);
      path.push(id);
      const targetId: string | undefined = edges.get(id)?.targetId;
      id = targetId !== undefined && edges.has(targetId) ? targetId : undefined;
    }

    if (id !== undefined && state.get(id) === 1) {
      const cycleStart = pathIndex.get(id);
      if (cycleStart !== undefined) {
        const cycle = [...path.slice(cycleStart), id];
        const sourceId = cycle.at(-2) as string;
        const edge = edges.get(sourceId) as GraphEdge;
        issues.push(issue(code, edge.path, `${label} cycle detected: ${cycle.join(' -> ')}.`));
      }
    }

    for (const pathId of path) {
      state.set(pathId, 2);
    }
  }
  return issues;
}

/**
 * Canonical visibility strictness ranks.
 * Higher means more restricted; widening is a semantic error.
 */
export const visibilityRank = {
  public: 0,
  unlisted: 0,
  inherit: 0,
  protected: 1,
  private: 2,
} as const;

// ---------------------------------------------------------------------------
// Page assembly (sequence, metadata stability, identity; no graph validation)
// ---------------------------------------------------------------------------

export type AssembledSnapshotPages =
  | {
      readonly valid: true;
      readonly issues: readonly [];
      readonly snapshot: Snapshot;
      readonly extensionRemovals: readonly ExtensionRemovalAudit[];
    }
  | { readonly valid: false; readonly issues: readonly SemanticIssue[] };

/**
 * Resource budgets used while merging a paginated Snapshot. `maxMembers`
 * counts entries copied from the page resource arrays (including Tombstones),
 * while `maxObjects` also accounts for the one shared Collection object.
 * Keeping these limits at the assembly boundary prevents a caller that has
 * already fetched several individually valid pages from multiplying its
 * memory allowance during the final `flatMap` operations.
 */
export interface SnapshotAssemblyBudget {
  readonly maxMembers?: number;
  readonly maxObjects?: number;
}

function resolveBudget(name: keyof SnapshotAssemblyBudget, value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`Snapshot assembly ${name} must be a positive safe integer.`);
  }
  return value;
}

function snapshotPageMemberCount(page: Snapshot): number {
  return page.nodes.length
    + page.annotations.length
    + page.attachments.length
    + page.relations.length
    + page.tombstones.length;
}

/**
 * Validates multi-page Snapshot framing and merges pages into one logical Snapshot.
 * Full graph/reference/visibility semantics are applied by the caller via
 * `validateSnapshotSemantics` after assembly.
 */
export function assembleSnapshotPagePayload(
  pages: readonly Snapshot[],
  options: {
    readonly extensionSecurityPolicy?: ExtensionSecurityPolicy;
    readonly maxMembers?: number;
    readonly maxObjects?: number;
  } = {},
): AssembledSnapshotPages {
  if (pages.length === 0) {
    return { valid: false, issues: [issue('empty_snapshot_assembly', '/', 'No pages supplied.')] };
  }
  const maxMembers = resolveBudget('maxMembers', options.maxMembers);
  const maxObjects = resolveBudget('maxObjects', options.maxObjects);
  const memberCount = pages.reduce((total, page) => total + snapshotPageMemberCount(page), 0);
  const objectCount = memberCount + 1;
  if (maxMembers !== undefined && memberCount > maxMembers) {
    return {
      valid: false,
      issues: [issue(
        'snapshot_assembly_member_budget',
        '/pages',
        `Snapshot page assembly contains ${memberCount} members, exceeding the limit of ${maxMembers}.`,
      )],
    };
  }
  if (maxObjects !== undefined && objectCount > maxObjects) {
    return {
      valid: false,
      issues: [issue(
        'snapshot_assembly_object_budget',
        '/pages',
        `Snapshot page assembly contains ${objectCount} objects, exceeding the limit of ${maxObjects}.`,
      )],
    };
  }
  const first = pages[0] as Snapshot;
  const firstCollectionDigest = canonicalize(first.collection);
  const issues: SemanticIssue[] = [];
  const seenIds = new Map<string, LiveResourceIdentity>();
  const tombstoneIds = new Map<string, string>();

  seenIds.set(first.collection.id, {
    resourceType: 'collection',
    resource: first.collection,
    path: '/pages/0/collection',
  });

  pages.forEach((page, index) => {
    const sequence = index + 1;
    const metadataComparisons: ReadonlyArray<readonly [string, boolean]> = [
      ['protocolVersion', page.protocolVersion === first.protocolVersion],
      ['snapshotId', page.snapshotId === first.snapshotId],
      ['revision', page.revision === first.revision],
      ['mode', page.mode === first.mode],
      ['complete', page.complete === first.complete],
      ['generatedAt', page.generatedAt === first.generatedAt],
      ['syncCursor', page.syncCursor === first.syncCursor],
      ['collection', canonicalize(page.collection) === firstCollectionDigest],
    ];
    const changedMetadata = metadataComparisons
      .filter(([, matches]) => !matches)
      .map(([field]) => field);
    if (changedMetadata.length > 0) {
      issues.push(
        issue(
          'snapshot_page_context_changed',
          `/pages/${index}`,
          `Snapshot page changed logical metadata: ${changedMetadata.join(', ')}.`,
        ),
      );
    }
    const expectedHasMore = sequence < pages.length;
    if (
      page.page.sequence !== sequence
      || page.page.hasMore !== expectedHasMore
      || (expectedHasMore ? page.page.nextCursor === null : page.page.nextCursor !== null)
    ) {
      issues.push(issue('invalid_snapshot_page_sequence', `/pages/${index}/page`, 'Page sequence, cursor, or boundary is invalid.'));
    }
    if (pages.length > 1 && page.contentDigest !== undefined) {
      issues.push(
        issue(
          'invalid_snapshot_content_digest_scope',
          `/pages/${index}/contentDigest`,
          'Paginated Snapshots cannot carry a body contentDigest.',
        ),
      );
    }

    for (const identity of liveResourceIdentities(page, `/pages/${index}`).slice(1)) {
      const previous = seenIds.get(identity.resource.id);
      if (previous !== undefined) {
        issues.push(
          issue(
            'duplicate_snapshot_page_id',
            `${identity.path}/id`,
            `Live ID ${identity.resource.id} is already used by ${previous.resourceType} at ${previous.path}/id.`,
          ),
        );
      } else {
        seenIds.set(identity.resource.id, identity);
      }
      const tombstonePath = tombstoneIds.get(identity.resource.id);
      if (tombstonePath !== undefined) {
        issues.push(
          issue(
            'live_tombstone_overlap',
            `${identity.path}/id`,
            `Live ID ${identity.resource.id} overlaps Tombstone target at ${tombstonePath}.`,
          ),
        );
      }
    }

    page.tombstones.forEach((tombstone, tombstoneIndex) => {
      const path = `/pages/${index}/tombstones/${tombstoneIndex}/targetId`;
      const previousTombstonePath = tombstoneIds.get(tombstone.targetId);
      if (previousTombstonePath !== undefined) {
        issues.push(
          issue(
            'duplicate_tombstone',
            path,
            `Tombstone target ${tombstone.targetId} is already used at ${previousTombstonePath}.`,
          ),
        );
      }
      const live = seenIds.get(tombstone.targetId);
      if (live !== undefined) {
        issues.push(
          issue(
            'live_tombstone_overlap',
            path,
            `Tombstone target ${tombstone.targetId} is still live as ${live.resourceType} at ${live.path}/id.`,
          ),
        );
      }
      if (previousTombstonePath === undefined) tombstoneIds.set(tombstone.targetId, path);
    });
  });
  if (issues.length > 0) {
    return { valid: false, issues: Object.freeze(issues) };
  }

  const extensionRemovals: ExtensionRemovalAudit[] = [];
  const preserveCarrier = <Value extends { readonly extensions?: Readonly<Record<string, unknown>> }>(
    value: Value,
    path: string,
  ): Value => {
    const preserved = preserveExtensionCarrier(value, value, {
      surface: 'page-assembly',
      path,
      ...(options.extensionSecurityPolicy === undefined
        ? {}
        : { securityPolicy: options.extensionSecurityPolicy }),
    });
    extensionRemovals.push(...preserved.removals);
    return preserved.value as Value;
  };
  const snapshot: Snapshot = {
    ...first,
    collection: preserveCarrier(first.collection, '/collection'),
    nodes: pages
      .flatMap((page) => page.nodes)
      .map((value, index) => preserveCarrier(value, `/nodes/${index}`)),
    annotations: pages
      .flatMap((page) => page.annotations)
      .map((value, index) => preserveCarrier(value, `/annotations/${index}`)),
    attachments: pages
      .flatMap((page) => page.attachments)
      .map((value, index) => preserveCarrier(value, `/attachments/${index}`)),
    relations: pages
      .flatMap((page) => page.relations)
      .map((value, index) => preserveCarrier(value, `/relations/${index}`)),
    tombstones: pages.flatMap((page) => page.tombstones),
    page: { nextCursor: null, hasMore: false, sequence: 1 },
  };

  return {
    valid: true,
    issues: [],
    snapshot,
    extensionRemovals: Object.freeze(extensionRemovals),
  };
}

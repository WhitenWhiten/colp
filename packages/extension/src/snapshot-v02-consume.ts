import type { SnapshotNode } from '@know-n/colp/types';
import type { DurableSyncSnapshot } from './durable-sync-engine-types.js';
import {
  accumulateSnapshotV02Pages,
  SNAPSHOT_MATERIALIZATION_SORT_VERSION,
  type SnapshotV02Accumulation,
  type SnapshotV02Page,
} from './snapshot-v02-pages.js';

export const SNAPSHOT_MATERIALIZATION_EXTENSION =
  'https://known.example/extensions/sync-snapshot-materialization';
export const LEGACY_SNAPSHOT_MATERIALIZATION_VERSION = 'parent-id-v0';

export { SNAPSHOT_MATERIALIZATION_SORT_VERSION };

export function readSnapshotMaterializationVersion(page: {
  readonly collection: { readonly extensions?: Readonly<Record<string, unknown>> };
}): string {
  const extension = page.collection.extensions?.[SNAPSHOT_MATERIALIZATION_EXTENSION];
  if (!extension || typeof extension !== 'object' || Array.isArray(extension)) {
    return LEGACY_SNAPSHOT_MATERIALIZATION_VERSION;
  }
  const version = (extension as { readonly sortAlgorithm?: unknown }).sortAlgorithm;
  return typeof version === 'string' && version.length > 0
    ? version : LEGACY_SNAPSHOT_MATERIALIZATION_VERSION;
}

/** Body stored on a recovery mapping. Live pages and staged restarts budget the same object. */
export function snapshotProjectionContent(node: SnapshotNode): Readonly<Record<string, unknown>> {
  return JSON.parse(JSON.stringify({
    title: node.title ?? '',
    ...(node.url ? { url: node.url } : {}),
    ...(node.description ? { description: node.description } : {}),
    ...(node.tags ? { tags: [...node.tags] } : {}),
    visibility: node.visibility ?? 'private',
    extensions: node.extensions ?? {},
    ...('folderRole' in node && node.folderRole ? { folderRole: node.folderRole } : {}),
  })) as Readonly<Record<string, unknown>>;
}

export function toSnapshotV02Page(page: DurableSyncSnapshot): SnapshotV02Page {
  return {
    snapshotId: page.snapshotId,
    revision: page.revision,
    collectionId: page.collection.id,
    syncCursor: page.syncCursor,
    pageSequence: page.page.sequence,
    parentRevisions: page.parentRevisions,
    nodes: page.nodes.map((node) => ({
      id: node.id, parentId: node.parentId,
      kind: node.kind === 'alias' ? 'folder' : node.kind,
      content: snapshotProjectionContent(node),
    })),
    hasMore: page.page.hasMore,
    nextCursor: page.page.nextCursor,
    materializationVersion: readSnapshotMaterializationVersion(page),
  };
}

export function consumeSnapshotV02Pages(pages: readonly DurableSyncSnapshot[]): SnapshotV02Accumulation {
  return accumulateSnapshotV02Pages(pages.map(toSnapshotV02Page));
}

export function snapshotV02RejectMessage(code: Exclude<SnapshotV02Accumulation, { ok: true }>['code']): string {
  switch (code) {
    case 'identity_conflict': return 'snapshot_identity_conflict';
    case 'parent_revision_conflict': return 'snapshot_parent_authority_invalid';
    case 'missing_children_revision': return 'snapshot_parent_authority_missing';
    case 'page_mutation': return 'snapshot_node_duplicate';
    case 'sequence_gap': return 'snapshot_chain_invalid';
    case 'graph_invalid': return 'snapshot_graph_incomplete';
    case 'budget_exceeded': return 'payload_too_large';
    default: {
      const _exhaustive: never = code;
      return _exhaustive;
    }
  }
}

export function snapshotV02PagesFromStaging(input: {
  readonly collectionId: string;
  readonly header: {
    readonly snapshotId: string; readonly revision: string; readonly syncCursor: string;
    readonly lastPage: number; readonly nextCursor: string | null; readonly complete: boolean;
    readonly materializationVersion?: string;
  };
  readonly nodes: ReadonlyArray<{
    readonly page: number; readonly colpId: string; readonly parentId: string | null;
    readonly kind: 'Folder' | 'Bookmark' | 'Separator'; readonly snapshotChildrenRevision?: string;
    readonly mapping: { readonly projection: {
      readonly childrenRevision?: string | null;
      readonly content?: Readonly<Record<string, unknown>>;
    } };
  }>;
}): SnapshotV02Page[] {
  const grouped = new Map<number, Array<(typeof input.nodes)[number]>>();
  for (const node of input.nodes) {
    const bucket = grouped.get(node.page);
    if (bucket) bucket.push(node); else grouped.set(node.page, [node]);
  }
  return [...grouped.keys()].sort((left, right) => left - right).map((page) => {
    const nodes = grouped.get(page)!;
    const last = page === input.header.lastPage;
    const hasMore = last ? input.header.nextCursor !== null : true;
    return {
      snapshotId: input.header.snapshotId, revision: input.header.revision,
      collectionId: input.collectionId, syncCursor: input.header.syncCursor,
      pageSequence: page + 1,
      parentRevisions: nodes.flatMap((node) => {
        const revision = node.snapshotChildrenRevision ?? node.mapping.projection.childrenRevision;
        if ((node.kind !== 'Folder' && node.parentId !== null) || !revision) return [];
        return [{ parentId: node.colpId, childrenRevision: revision }];
      }),
      nodes: nodes.map((node) => ({
        id: node.colpId, parentId: node.parentId,
        kind: node.parentId === null ? 'root' as const
          : node.kind === 'Folder' ? 'folder' as const
            : node.kind === 'Bookmark' ? 'bookmark' as const : 'separator' as const,
        ...(node.mapping.projection.content ? { content: node.mapping.projection.content } : {}),
      })),
      hasMore, nextCursor: last ? input.header.nextCursor : `staged-${page + 1}`,
      materializationVersion: input.header.materializationVersion,
    };
  });
}

export type { SnapshotNode };

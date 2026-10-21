/**
 * Sync 0.2 paged Snapshot accumulator. Separate from colp 0.1 assembleSnapshotPages.
 */
export const SNAPSHOT_V02_SUPPORT = Object.freeze({
  commonBookmarkCount: 3_000,
  maxNodes: 10_000,
  maxAggregateBytes: 2 * 1024 * 1024,
});

export const SNAPSHOT_MATERIALIZATION_SORT_VERSION = 'parent-first-v1';

export interface SnapshotV02Node {
  readonly id: string;
  readonly parentId: string | null;
  readonly kind: 'root' | 'folder' | 'bookmark' | 'separator';
  /** Title retained from the snapshot body. Counted even when `content` omits it. */
  readonly title?: string;
  /** URL retained from the snapshot body. Counted even when `content` omits it. */
  readonly url?: string;
  /**
   * Body kept for restart: description, tags, visibility, extensions,
   * folderRole, and title/url when they still live only inside projection content.
   */
  readonly content?: Readonly<Record<string, unknown>>;
}

export interface SnapshotV02ParentRevision {
  readonly parentId: string;
  readonly childrenRevision: string;
}

export interface SnapshotV02Page {
  readonly snapshotId: string;
  readonly revision: string;
  readonly collectionId: string;
  readonly syncCursor: string;
  readonly pageSequence: number;
  readonly parentRevisions: readonly SnapshotV02ParentRevision[];
  readonly nodes: readonly SnapshotV02Node[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
  readonly materializationVersion?: string;
}

export type SnapshotV02RejectCode =
  | 'identity_conflict'
  | 'parent_revision_conflict'
  | 'missing_children_revision'
  | 'page_mutation'
  | 'sequence_gap'
  | 'graph_invalid'
  | 'budget_exceeded';

export type SnapshotV02Accumulation =
  | {
      readonly ok: true;
      readonly complete: boolean;
      readonly graphChecked: boolean;
      readonly parentRevisions: ReadonlyMap<string, string>;
      readonly pages: readonly SnapshotV02Page[];
    }
  | { readonly ok: false; readonly code: SnapshotV02RejectCode };

const textEncoder = new TextEncoder();

function utf8Bytes(value: string): number {
  return textEncoder.encode(value).byteLength;
}

/**
 * UTF-8 size of one node's identity and retained body.
 * Title, URL, and projection content all count. A rejected duplicate page does not add to this.
 */
export function snapshotV02NodeBytes(node: SnapshotV02Node): number {
  return utf8Bytes(JSON.stringify({
    id: node.id,
    parentId: node.parentId,
    kind: node.kind,
    title: node.title ?? null,
    url: node.url ?? null,
    content: node.content ?? null,
  }));
}

/** UTF-8 size of the page envelope plus its nodes. Rejected pages are not added to the aggregate. */
export function snapshotV02PageWireBytes(page: SnapshotV02Page): number {
  return utf8Bytes(JSON.stringify({
    snapshotId: page.snapshotId,
    revision: page.revision,
    collectionId: page.collectionId,
    syncCursor: page.syncCursor,
    pageSequence: page.pageSequence,
    hasMore: page.hasMore,
    nextCursor: page.nextCursor,
    materializationVersion: page.materializationVersion ?? null,
    parentRevisions: page.parentRevisions,
  })) + page.nodes.reduce((total, node) => total + snapshotV02NodeBytes(node), 0);
}

export interface SnapshotV02Accumulator {
  add(page: SnapshotV02Page): SnapshotV02Accumulation;
  reset(): void;
  readonly nodes: number;
  readonly bytes: number;
}

export function createSnapshotV02Accumulator(): SnapshotV02Accumulator {
  let seenSequences = new Set<number>();
  let parentRevisions = new Map<string, string>();
  let seenIds = new Set<string>();
  let pages: SnapshotV02Page[] = [];
  let bytes = 0;
  const accumulator: SnapshotV02Accumulator = {
    get nodes() { return seenIds.size; },
    get bytes() { return bytes; },
    reset() {
      seenSequences = new Set();
      parentRevisions = new Map();
      seenIds = new Set();
      pages = [];
      bytes = 0;
    },
    add(page) {
      if (pages.length === 0 && page.pageSequence !== 1) return { ok: false, code: 'sequence_gap' };
      const first = pages[0] ?? page;
      if (page.snapshotId !== first.snapshotId || page.revision !== first.revision
          || page.collectionId !== first.collectionId || page.syncCursor !== first.syncCursor
          || page.materializationVersion !== first.materializationVersion) {
        return { ok: false, code: 'identity_conflict' };
      }
      if (page.hasMore !== (page.nextCursor !== null)) return { ok: false, code: 'sequence_gap' };
      if (seenSequences.has(page.pageSequence) || page.pageSequence !== pages.length + 1) {
        return { ok: false, code: seenSequences.has(page.pageSequence) ? 'page_mutation' : 'sequence_gap' };
      }
      const pageIds = new Set<string>();
      for (const node of page.nodes) {
        if (pageIds.has(node.id) || seenIds.has(node.id)) return { ok: false, code: 'page_mutation' };
        pageIds.add(node.id);
      }
      const addedBytes = snapshotV02PageWireBytes(page);
      if (seenIds.size + pageIds.size > SNAPSHOT_V02_SUPPORT.maxNodes
          || bytes + addedBytes > SNAPSHOT_V02_SUPPORT.maxAggregateBytes) {
        return { ok: false, code: 'budget_exceeded' };
      }
      const folderIds = page.nodes.filter((node) => node.kind === 'root' || node.kind === 'folder').map((node) => node.id);
      const pageParents = new Map(page.parentRevisions.map((item) => [item.parentId, item.childrenRevision]));
      if (new Set(pageParents.keys()).size !== page.parentRevisions.length) {
        return { ok: false, code: 'parent_revision_conflict' };
      }
      for (const id of folderIds) {
        if (!pageParents.has(id)) return { ok: false, code: 'missing_children_revision' };
      }
      for (const [parentId, revision] of pageParents) {
        const prior = parentRevisions.get(parentId);
        if (prior !== undefined && prior !== revision) return { ok: false, code: 'parent_revision_conflict' };
      }
      for (const node of page.nodes) {
        if (node.parentId !== null && !seenIds.has(node.parentId) && !pageIds.has(node.parentId)) {
          return { ok: false, code: 'graph_invalid' };
        }
      }
      const nextPages = [...pages, page];
      const complete = page.hasMore === false && page.nextCursor === null;
      // A rejected page leaves the pages already accepted in place.
      if (complete && !graphValid(nextPages)) return { ok: false, code: 'graph_invalid' };
      const nextParents = new Map(parentRevisions);
      for (const [parentId, revision] of pageParents) nextParents.set(parentId, revision);
      for (const id of pageIds) seenIds.add(id);
      seenSequences.add(page.pageSequence);
      bytes += addedBytes;
      pages = nextPages;
      parentRevisions = nextParents;
      const publishedParents = new Map(nextParents);
      if (!complete) {
        return { ok: true, complete: false, graphChecked: false, parentRevisions: publishedParents, pages };
      }
      return { ok: true, complete: true, graphChecked: true, parentRevisions: publishedParents, pages };
    },
  };
  return accumulator;
}

export function accumulateSnapshotV02Pages(pages: readonly SnapshotV02Page[]): SnapshotV02Accumulation {
  if (pages.length === 0) return { ok: false, code: 'sequence_gap' };
  const accumulator = createSnapshotV02Accumulator();
  let result: SnapshotV02Accumulation = { ok: false, code: 'sequence_gap' };
  for (const page of [...pages].sort((left, right) => left.pageSequence - right.pageSequence)) {
    result = accumulator.add(page);
    if (!result.ok) return result;
  }
  return result;
}

function graphValid(pages: readonly SnapshotV02Page[]): boolean {
  const nodes = pages.flatMap((page) => page.nodes);
  const byId = new Map<string, SnapshotV02Node>();
  for (const node of nodes) {
    if (byId.has(node.id)) return false;
    byId.set(node.id, node);
  }
  const roots = nodes.filter((node) => node.parentId === null);
  if (roots.length !== 1 || roots[0]?.kind !== 'root') return false;
  for (const node of nodes) {
    if (node.parentId === null) continue;
    const parent = byId.get(node.parentId);
    if (!parent || (parent.kind !== 'root' && parent.kind !== 'folder')) return false;
  }
  const rootId = roots[0]!.id;
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    const siblings = children.get(node.parentId);
    if (siblings) siblings.push(node.id); else children.set(node.parentId, [node.id]);
  }
  const reachable = new Set<string>();
  const pending = [rootId];
  for (let index = 0; index < pending.length; index += 1) {
    const current = pending[index]!;
    if (reachable.has(current)) return false;
    reachable.add(current);
    pending.push(...(children.get(current) ?? []));
  }
  return reachable.size === nodes.length;
}

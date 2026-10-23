import type { BookmarkEventNode } from './bookmark-event-codec.js';
import { isDescendant } from './bookmark-event-codec.js';
import type { DeletionJournalRecord, MappingInput, SyncScope, createSyncStateStore } from './sync-state-store.js';

const JOURNAL_BOUND = 256;

type Store = Pick<ReturnType<typeof createSyncStateStore>, 'putDeletionJournal' | 'listDeletionJournal'>;

export type RemovalEnvelope = {
  readonly parentId: string; readonly index: number; readonly node?: BookmarkEventNode | null;
};

export function removalPayloadMissing(node: BookmarkEventNode | null | undefined): boolean {
  return !node || typeof node.id !== 'string' || node.id.length === 0;
}

export async function nextJournalOrdinal(store: Store, scope: SyncScope, nativeId: string): Promise<number> {
  const rows = await store.listDeletionJournal(scope, nativeId);
  return rows.reduce((max, row) => Math.max(max, row.ordinal), 0) + 1;
}

export function journalSubtreeNativeIds(
  removedNativeId: string, rows: readonly DeletionJournalRecord[],
): string[] {
  const ids = new Set<string>([removedNativeId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (ids.has(row.nativeId)) continue;
      if (row.parentNativeId && ids.has(row.parentNativeId)) {
        ids.add(row.nativeId);
        grew = true;
      }
    }
  }
  return [...ids].slice(0, JOURNAL_BOUND);
}

export function boundedSubtreeMappings(removedNativeId: string, mappings: readonly MappingInput[]): MappingInput[] {
  const subtree = mappings.filter((mapping) => mapping.nativeId === removedNativeId
    || isDescendant(mapping, removedNativeId, mappings));
  return subtree.slice(0, JOURNAL_BOUND);
}

export async function persistRemovalJournal(store: Store, scope: SyncScope, input: {
  readonly nativeId: string; readonly removal: RemovalEnvelope; readonly mappings: readonly MappingInput[];
}): Promise<readonly DeletionJournalRecord[]> {
  const written: DeletionJournalRecord[] = [];
  const subtree = boundedSubtreeMappings(input.nativeId, input.mappings);
  const payload = input.removal.node;
  const payloadIds = payload && !removalPayloadMissing(payload)
    ? flattenPayloadIds(payload).slice(0, JOURNAL_BOUND) : [];
  const byNative = new Map(input.mappings.map((mapping) => [mapping.nativeId, mapping]));
  const subtreeByNative = new Map(subtree.map((mapping) => [mapping.nativeId, mapping]));
  const nativeIds = [...new Set([input.nativeId, ...subtree.map((row) => row.nativeId),
    ...payloadIds.filter((id) => byNative.has(id))])];
  for (const nativeId of nativeIds) {
    const mapping = subtreeByNative.get(nativeId) ?? byNative.get(nativeId);
    const ordinal = await nextJournalOrdinal(store, scope, nativeId);
    const kind = mapping?.nodeKind ?? (nativeId === payload?.id ? payloadKind(payload) : 'bookmark');
    written.push(await store.putDeletionJournal(scope, {
      nativeId, ordinal, kind,
      ...(mapping?.parentNativeId ? { parentNativeId: mapping.parentNativeId }
        : nativeId === input.nativeId ? { parentNativeId: input.removal.parentId } : {}),
      ...(nativeId === input.nativeId ? { position: input.removal.index } : {}),
      ...(mapping?.mountId ? { mountId: mapping.mountId } : {}),
      ...(mapping ? { contentDigest: mapping.projection.contentDigest ?? mapping.projection.digest } : {}),
    }));
  }
  return written;
}

function flattenPayloadIds(node: BookmarkEventNode): string[] {
  return [node.id, ...(node.children ?? []).flatMap(flattenPayloadIds)];
}

function payloadKind(node: BookmarkEventNode): DeletionJournalRecord['kind'] {
  return node.type === 'separator' ? 'separator' : typeof node.url === 'string' ? 'bookmark' : 'folder';
}

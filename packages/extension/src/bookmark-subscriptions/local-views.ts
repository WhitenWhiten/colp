import type { AccountScope, AckRecord, LocalMapping } from './local-types.js';
import type { SubscriptionStore } from './store.js';

type LocalView = LocalMapping & {
  mountPath: string[];
  bookmarkCount: number;
  ackPending: boolean;
  recoveryPending: boolean;
};
export type PendingExitSummary = Pick<AckRecord, 'id' | 'mappingId' | 'generation' | 'result' | 'completedAt'> & { localAlias?: string };
const owner = (scope: AccountScope) => JSON.stringify([scope.serverOrigin, scope.accountId, scope.profileId]);
const identity = (scope: AccountScope, mappingId: string, generation: string) => JSON.stringify([owner(scope), mappingId, generation]);

export function pendingExitSummaries(acks: AckRecord[], rows: LocalMapping[], scope: AccountScope): PendingExitSummary[] {
  const local = new Map(rows.filter(row => owner(row.scope) === owner(scope)).map(row => [row.id, row]));
  return acks.filter(ack => ack.pending && owner(ack.scope) === owner(scope)).map(ack => {
    const row = local.get(ack.mappingId);
    return { id: ack.id, mappingId: ack.mappingId, generation: ack.generation, result: ack.result, completedAt: ack.completedAt,
      ...(row?.mapping.generation === ack.generation ? { localAlias: row.localAlias } : {}) };
  }).sort((a, b) => b.completedAt - a.completedAt || a.id.localeCompare(b.id));
}

export async function loadLocalViews(
  db: Pick<SubscriptionStore, 'all' | 'pendingOperations'>,
  rows: LocalMapping[],
  nativePath: (id: string) => Promise<string[]>,
  knownAcks?: AckRecord[],
): Promise<Map<string, LocalView>> {
  if (!rows.length) return new Map();
  const [nodes, acks, operations] = await Promise.all([
    db.all('nodes'), knownAcks ?? db.all('acks'), db.pendingOperations(),
  ]);
  const bookmarkCounts = new Map<string, number>();
  for (const node of nodes) {
    if (!node.copyTaskId && node.node.kind === 'bookmark' && node.node.role === 'content') {
      bookmarkCounts.set(node.mappingId, (bookmarkCounts.get(node.mappingId) ?? 0) + 1);
    }
  }
  const pendingAcks = new Set(acks.filter(a => a.pending).map(a => identity(a.scope, a.mappingId, a.generation)));
  const pendingOperations = new Set(operations.map(o => o.mappingId));
  const views = await Promise.all(rows.map(async row => ({
    ...row,
    mountPath: await nativePath(row.rootNativeId ?? row.mountParentNativeId).catch(() => []),
    bookmarkCount: bookmarkCounts.get(row.id) ?? 0,
    ackPending: pendingAcks.has(identity(row.scope, row.id, row.mapping.generation)),
    recoveryPending: Boolean(row.cleanup) || pendingOperations.has(row.id)
      || ['repair_pending', 'local_change', 'target_missing'].includes(row.state),
  })));
  return new Map(views.map(view => [view.id, view]));
}

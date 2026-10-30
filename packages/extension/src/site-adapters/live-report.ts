import { activityCode } from './activity.js';
import { get, type SourceDatabase } from './source-db.js';
import { cursorPage, cursorPageDescending, requestValue } from '../sync-state/idb.js';
import { localSourceProgress } from './local-progress.js';
import type { SourcePolicyRecord } from './layout.js';
import type { ObservationRow, SourceAuthority } from './ledger-types.js';
import type { SourceWork } from './work-queue.js';
import type { TransportState } from './transport.js';
import type { SiteDefinition } from './registry-types.js';

type PlannedObservation = ObservationRow & { planning?: { reason: string; planIds?: string[] } };
interface Configuration { state: string; live: boolean; collectionIds: string[]; copies?: string; semantic?: string }

/** Current, bounded read-only evidence. Never export account IDs, item data, native IDs or credentials. */
export async function sourceLiveReport(db: SourceDatabase, definition: SiteDefinition, state: TransportState, attached: ReadonlySet<string>) {
  const authority = await db.read<SourceAuthority>('authorities', definition.adapterId), connection = authority?.connectionId;
  const stored = await db.transaction(['meta', 'observations', 'work'], 'readonly', async tx => {
    const config = connection ? await get<Configuration>(tx, 'meta', `archiveConfig:${connection}`) : undefined;
    const policy = connection ? await get<SourcePolicyRecord>(tx, 'meta', `policy:${connection}`) : undefined;
    const index = tx.objectStore('observations').index('installationStateOrdinal');
    const range = (status: string) => IDBKeyRange.bound([definition.adapterId, status, 0], [definition.adapterId, status, Number.MAX_SAFE_INTEGER]);
    const pending = await requestValue(index.count(range('pending'))), settled = await requestValue(index.count(range('settled')));
    const recent = [...await cursorPageDescending<PlannedObservation>(index, range('pending'), 5),
      ...await cursorPageDescending<PlannedObservation>(index, range('settled'), 5)].sort((a, b) => b.ordinal - a.ordinal).slice(0, 5);
    const work = tx.objectStore('work').index('connectionId');
    const workCount = connection ? await requestValue(work.count(connection)) : 0;
    const queued = connection ? await cursorPage<SourceWork>(work, IDBKeyRange.only(connection), 10) : [];
    return {
      configuration: { present: !!config, state: config?.state ?? null, live: config?.live ?? false,
        collections: config?.collectionIds.length ?? 0, policyEnabled: policy?.enabled ?? false, policyLive: policy?.liveArchive ?? false },
      events: { pending, settled, recent: recent.map(row => ({ ordinal: row.ordinal, acceptedAt: row.acceptedAt, state: row.state,
        kind: row.observation.type, currentSource: row.context.connectionId === connection && row.context.installationGeneration === state.generation
          && row.context.sourceSessionGeneration === state.sourceGeneration,
        planning: row.planning ? { reason: activityCode(row.planning.reason), plans: row.planning.planIds?.length ?? 0 } : null,
        retryReason: row.retryReason ? activityCode(row.retryReason) : null })) },
      work: { count: workCount, samples: queued.map(row => ({ attempts: row.attempts, parked: row.dueAt === Number.MAX_SAFE_INTEGER,
        retryAt: row.dueAt === Number.MAX_SAFE_INTEGER ? null : row.dueAt, reason: row.reason ? activityCode(row.reason) : null })) },
    };
  });
  const progress = connection ? await localSourceProgress(db, connection) : null;
  const { lastCommandId: _privateCommand, ...pipeline } = progress ?? {};
  if ('reason' in pipeline && typeof pipeline.reason === 'string') pipeline.reason = activityCode(pipeline.reason);
  return { available: true, source: { enabled: state.enabled, accountConfirmed: !!state.accountId && !state.sourceUnresolved,
    pendingAccount: !!state.candidateAccount, documents: state.leases.filter(lease => lease.expiresAt > Date.now() && attached.has(lease.id)).length },
    ...stored, pipeline: progress ? pipeline : null };
}

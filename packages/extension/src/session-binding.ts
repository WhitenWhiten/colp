import type { BootstrapMode, FirstRunState, QueueOperation, ScopeRecord, SyncScope } from './sync-state/types.js';

export type SessionMountBinding = {
  readonly browserProfileId: string;
  readonly mountMode: 'whole-profile' | 'mounted-folder';
  readonly mountNativeId: string | null;
  readonly generation: string;
};

export type ColpSessionTransportSlice = {
  readonly binding: SessionMountBinding;
  readonly bootstrapMode: BootstrapMode;
};

const NONTERMINAL_QUEUE_STATUSES = ['pending', 'claimed', 'deferred', 'gap', 'blocked', 'unknown'] as const;

export function resolveSessionMountBinding(input: {
  readonly browserProfileId: string;
  readonly generation: string;
  readonly scope: ScopeRecord | null;
  readonly legacyNativeId?: string | null;
}): SessionMountBinding {
  const { browserProfileId, generation, scope, legacyNativeId } = input;
  if (scope?.legacyCanonicalRoot) {
    return { browserProfileId, generation, mountMode: 'mounted-folder',
      mountNativeId: legacyNativeId ?? 'unconfigured' };
  }
  const mountMode = scope?.mountMode ?? 'whole-profile';
  if (mountMode === 'mounted-folder') {
    return { browserProfileId, generation, mountMode: 'mounted-folder',
      mountNativeId: legacyNativeId ?? 'unconfigured' };
  }
  return { browserProfileId, generation, mountMode: 'whole-profile', mountNativeId: null };
}

export function resolveSessionBootstrapMode(current: BootstrapMode | null | undefined): BootstrapMode {
  return current ?? 'merge';
}

export function colpSessionTransportSlice(input: {
  readonly browserProfileId: string;
  readonly generation: string;
  readonly scope: ScopeRecord | null;
  readonly legacyNativeId?: string | null;
  readonly bootstrapMode?: BootstrapMode | null;
}): ColpSessionTransportSlice {
  return {
    binding: resolveSessionMountBinding(input),
    bootstrapMode: resolveSessionBootstrapMode(input.bootstrapMode),
  };
}

const NONTERMINAL = new Set<string>(NONTERMINAL_QUEUE_STATUSES);

export function queueHasNonterminalRows(rows: ReadonlyArray<{ readonly status: string }>): boolean {
  return rows.some((row) => NONTERMINAL.has(row.status));
}

export function canProvisionDefaultSyncRoot(
  firstRun: FirstRunState | undefined, explicitCreateKnowNFolder: boolean | undefined,
): boolean {
  return firstRun === 'completed' && explicitCreateKnowNFolder === true;
}

export async function retireScopeIfQueueDrained(store: {
  listQueue(scope: SyncScope, status?: QueueOperation['status'], afterSequence?: number, limit?: number):
    Promise<ReadonlyArray<{ readonly status: string }>>;
  retireScope(scope: SyncScope, retirement: { readonly retiredAt: number; readonly reason: string }): Promise<void>;
}, scope: SyncScope, options: { readonly abandonQueue?: boolean } = {}): Promise<void> {
  if (!options.abandonQueue) {
    for (const status of NONTERMINAL_QUEUE_STATUSES) {
      const rows = await store.listQueue(scope, status, 0, 1);
      if (queueHasNonterminalRows(rows)) throw new Error('queue_not_drained');
    }
  }
  await store.retireScope(scope, { retiredAt: Date.now(), reason: 'legacy_remount' });
}

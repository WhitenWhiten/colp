import type { AuthoritativeParentRevision, Collection, SnapshotNode, SnapshotPage,
  SyncPullV02 } from '@know-n/colp/types';
import type { SyncEndpoints } from './manifest-client.js';
import type { DrainOutcome } from './outbound-push-worker.js';
import type { DurableSyncEngineState, MappingInput, SyncScope, createSyncStateStore } from './sync-state-store.js';
import type { StoredCredential, StoredSession } from './types.js';

export type PlacementRefreshOutcome = 'continue' | 'recovery';

export type DurableSyncSnapshot = {
  readonly protocolVersion: '0.2'; readonly snapshotId: string; readonly mode: 'sync'; readonly complete: boolean;
  readonly collection: Collection; readonly nodes: readonly SnapshotNode[]; readonly revision: string;
  readonly syncCursor: string; readonly recoveryCapability?: string;
  readonly parentRevisions: readonly AuthoritativeParentRevision[];
  readonly page: SnapshotPage; readonly generatedAt: string; readonly warnings: readonly unknown[];
  readonly annotations: readonly unknown[]; readonly attachments: readonly unknown[];
  readonly relations: readonly unknown[]; readonly tombstones: readonly unknown[];
};

export interface EngineOptions {
  readonly scope: SyncScope; readonly store: ReturnType<typeof createSyncStateStore>;
  readonly origin?: string;
  readonly endpoints: () => Promise<Pick<SyncEndpoints, 'syncPull' | 'syncSnapshot' | 'syncAck'>>;
  readonly sessions: { get(forceRefresh?: boolean): Promise<{ readonly credential: Pick<StoredCredential, 'accessToken'>;
    readonly session: StoredSession }> };
  readonly pullApplier: { stage(page: SyncPullV02, cursorAuthority?: { readonly reissued?: boolean }): Promise<void>;
    resume(mode?: { readonly recoveryOnly?: boolean }): Promise<void> };
  readonly pushWorker: { drain(onNetworkResponse?: () => void | Promise<void>): Promise<DrainOutcome> };
  readonly fetch?: typeof fetch; readonly requestTimeoutMilliseconds?: number;
  readonly now?: () => number; readonly random?: () => number;
  readonly schedule?: (delayMilliseconds: number) => void;
  readonly recoverIdentityFreeze?: () => Promise<boolean>;
  readonly snapshotProjector: (staged: readonly MappingInput[], mode?: { readonly recoveryOnly?: boolean }) => Promise<readonly MappingInput[]>;
  readonly boundary?: (point: 'before_pull' | 'after_pull' | 'after_pull_apply' | 'before_ack' | 'after_ack'
    | 'before_snapshot_page' | 'after_snapshot_page') => void | Promise<void>;
}

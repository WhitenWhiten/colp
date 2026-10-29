import type { SiteObservation } from './contracts.js';
export interface SourceAuthority { installationId?: string; enabled: boolean; installationGeneration: number; sourceSessionGeneration: number;
  connectionId: string | null; accountId: string | null; negativeReadback: boolean }
export interface SourceConnection { id: string; siteKey: string; accountId: string; identityVersion: number }
/** Constructed only by the host from a verified lease; never page input. */
export interface SourceContext { installationId?: string; connectionId: string; installationGeneration: number; sourceSessionGeneration: number;
  communityOrigin?: import('./community-state.js').CommunityOrigin;
  documentId: string; tabId: number; routeEpoch: number; leaseId: string }
export interface LedgerEdge { connectionId: string; itemId: string; collectionId: string; state: 'present' | 'absent' | 'unresolved';
  ordinal: number; liveOrdinal: number; evidence: 'live' | 'import' | 'read'; observationId: string; conflicts: readonly string[] }
export interface ObservationRow { installationId?: string; id: string; ordinal: number; context: SourceContext; observation: SiteObservation; acceptedAt: number; adapterVersion: string; cause: 'siteFavorite' | 'reconcile'; state: 'pending' | 'settled'; readyAt?: number; retryReason?: string; retryRevision?: number }
export interface SourceReceipt { id: string; digest: string; ordinal: number }
export interface SourceImportRun { id: string; context: SourceContext; baselineOrdinal: number; phase: 'scanning' | 'stopped';
  outstanding: string | null; cursor: string | null; coverage: 'complete' | 'partial'; seenItems: readonly string[]; seenCursors: readonly string[] }
export interface ImportRead { id: string; runId: string; context: SourceContext; deadlineAt: number;
  query: { kind: 'collections'; cursor: string | null } | { kind: 'items'; collectionId: string; cursor: string | null } }
export type LedgerAdmission = { status: 'accepted' | 'duplicate'; receiptId: string } | { status: 'rejected'; reason: 'conflict' | 'invalid' | 'staleContext' | 'capacity' };

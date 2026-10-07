import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { ProblemCode } from '@know-n/colp/server';
import { createValidatorRegistry } from '@know-n/colp/schema';
import { validateSnapshotSemantics } from '@know-n/colp/semantic';
import type {
  AuthoritativeParentRevision, Collection, Snapshot, SnapshotNode, SyncSnapshotQuery, SyncSnapshotV02,
} from '@know-n/colp/types';
import { snapshotMaterializationIdentity } from './sync-snapshot-parent-first.js';

export interface SyncBootstrapAuthorityResult {
  readonly sessionId: string;
  readonly collectionId: string;
  readonly replicaId: string;
  readonly leaseGeneration: number;
  readonly sessionExpiresAt: string;
  readonly replicaState: 'new' | 'active' | 'expired' | 'recovery_required' | 'retired';
  readonly bindingMode: 'whole-profile' | 'mounted-folder';
  readonly bindingRootNodeId: string;
  readonly contentRevision: string;
  readonly policyRevision: string;
  readonly bootstrapCursor: string;
  readonly collection: Collection;
  readonly nodes: readonly SnapshotNode[];
  /**
   * FIX-M-014 (SYNC-R09): total node count of the Snapshot. Stored paged
   * authorities persist the count in the header and return only the requested
   * page in `pageNodes`; `nodes` stays empty for those reads. Absent
   * `nodeCount`, the full `nodes` array length is authoritative.
   */
  readonly nodeCount?: number;
  /**
   * FIX-M-014 (SYNC-R09): the pre-fetched page (offset..offset+limit) for a
   * stored paged read. Absent, the service derives the page from `nodes`.
   */
  readonly pageNodes?: readonly SnapshotNode[];
  readonly parentRevisions?: readonly AuthoritativeParentRevision[];
  readonly protocolVersion?: '0.1' | '0.2';
  readonly snapshotId?: string;
  readonly generatedAt?: string;
  /** Negotiated per-page transport byte budget (session-bound). */
  readonly snapshotPageBytes?: number;
}

export interface SyncBootstrapAuthority {
  load(input: { readonly sessionId: string; readonly snapshotId?: string; readonly limit: number;
    /** FIX-M-014: page offset for a stored paged read (cursor continuation). */
    readonly offset?: number }): Promise<SyncBootstrapAuthorityResult>;
  markComplete?(input: { readonly sessionId: string; readonly snapshotId: string }): Promise<void>;
  recordPage?(input: { readonly sessionId: string; readonly snapshotId: string;
    readonly sequence: number; readonly startOffset: number; readonly endOffset: number;
    readonly complete: boolean; readonly responseDigest: string }): Promise<void>;
  issueRecoveryCapability?(input: { readonly sessionId: string; readonly snapshotId: string }): Promise<string>;
}

/**
 * FIX-L-033 (SYNC-R17): the minimal attachment-projection policy port of the
 * Sync domain. Sync understands ONLY the allow/deny projection decision and
 * never imports the attachments module; the composition adapter maps the
 * attachments exposure-eligibility gate (deny-by-default while no
 * content-safety capability exists) onto this port. The contract is
 * fail-closed: an uncomposed port or a throwing adapter denies the Snapshot,
 * and the `attachments` projection stays empty by construction.
 */
export interface AttachmentExposurePolicyPort {
  /**
   * Denies the attachment projection for the collection scope. Resolves only
   * after every blob in scope is explicitly ineligible for shared exposure;
   * any other outcome (uncomposed/absent port, adapter or facts failure,
   * unexpected eligible verdict) throws.
   */
  assertAttachmentsDenied(input: { readonly collectionId: string }): Promise<void>;
}

export class SyncBootstrapSnapshotError extends Error {
  constructor(public readonly code: ProblemCode, public readonly authorityGuard?: string) {
    super(`Sync bootstrap Snapshot denied: ${code}`);
    this.name = 'SyncBootstrapSnapshotError';
  }
}

interface CursorPayload {
  readonly snapshotId: string;
  readonly generation: number;
  readonly offset: number;
  readonly sequence: number;
  readonly limit: number;
  readonly expiresAt: number;
  readonly scope: string;
}

export function createSyncBootstrapSnapshotService(options: {
  readonly authority: SyncBootstrapAuthority;
  readonly cursorSecret: string | Uint8Array;
  readonly cursorKeyId?: string;
  readonly now?: () => number;
  readonly cursorTtlMs?: number;
  readonly defaultLimit?: number;
  readonly maxLimit?: number;
  /**
   * FIX-L-033 (SYNC-R17): the attachment-projection policy port. The Sync
   * domain understands only "allow/deny attachment projection"; the
   * composition adapter maps the attachments exposure-eligibility gate onto
   * this port. An uncomposed or throwing policy fails closed and the Snapshot
   * `attachments` array stays empty by construction.
   */
  readonly attachmentExposure: AttachmentExposurePolicyPort;
}) {
  const now = options.now ?? Date.now;
  const defaultLimit = options.defaultLimit ?? 200;
  const maxLimit = options.maxLimit ?? 500;
  const ttl = options.cursorTtlMs ?? 900_000;
  const cursorKeyId = options.cursorKeyId ?? 'v1';
  if (Buffer.byteLength(options.cursorSecret) < 32) throw new TypeError('Sync Snapshot cursor secret must be at least 32 bytes');
  // FIX-L-033 (SYNC-R17): an uncomposed policy port is a composition error and
  // must fail loudly (fail closed) instead of silently allowing a projection.
  if (typeof options.attachmentExposure?.assertAttachmentsDenied !== 'function') {
    throw new TypeError('AttachmentExposurePolicyPort must provide assertAttachmentsDenied');
  }

  return Object.freeze({
    async query(query: SyncSnapshotQuery): Promise<Snapshot | SyncSnapshotV02> {
      if (!query || typeof query.sessionId !== 'string' || query.sessionId.length === 0) throw new SyncBootstrapSnapshotError('invalid_query');
      const limit = query.limit ?? defaultLimit;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxLimit) throw new SyncBootstrapSnapshotError('invalid_query');
      const cursor = query.pageCursor ? verifyCursor(query.pageCursor, options.cursorSecret, cursorKeyId, now()) : undefined;
      if (cursor && cursor.limit !== limit) throw new SyncBootstrapSnapshotError('invalid_cursor_scope');
      const source = await options.authority.load({ sessionId: query.sessionId, limit,
        ...(cursor ? { snapshotId: cursor.snapshotId, offset: cursor.offset } : {}) });
      if (source.sessionId !== query.sessionId) {
        throw new SyncBootstrapSnapshotError('invalid_cursor_scope', 'source_session');
      }
      assertAuthority(source, now());
      // FIX-L-033 (SYNC-R17): consult the composed attachment-projection
      // policy (allow/deny only). Fail-closed: a missing port or a throwing
      // adapter denies the Snapshot, and the base payload keeps
      // `attachments: []`, so the projection stays empty by construction.
      await options.attachmentExposure.assertAttachmentsDenied({ collectionId: source.collectionId });
      if (cursor && source.leaseGeneration !== cursor.generation) throw new SyncBootstrapSnapshotError('stale_replica');
      if (cursor) {
        const currentScope = cursorScope(source, cursorKeyId);
        if (cursor.scope.slice(0, 14) !== currentScope.slice(0, 14)) throw new SyncBootstrapSnapshotError('invalid_cursor_scope');
        if (cursor.scope.slice(14) !== currentScope.slice(14)) throw new SyncBootstrapSnapshotError('snapshot_expired');
      }
      const generatedAt = source.generatedAt ?? new Date(now()).toISOString();
      const snapshotId = source.snapshotId ?? stableSnapshotId(source);
      if (cursor && snapshotId !== cursor.snapshotId) throw new SyncBootstrapSnapshotError('snapshot_expired');
      if (!cursor) assertSyncBootstrapSnapshotGraph(source, snapshotId, generatedAt);
      const offset = cursor?.offset ?? 0;
      const sequence = cursor?.sequence ?? 1;
      // FIX-M-014 (SYNC-R09): a stored paged authority returns only the
      // requested page (`pageNodes`) and the persisted total (`nodeCount`);
      // full-node authorities keep the historic slice behaviour.
      const nodeCount = source.nodeCount ?? source.nodes.length;
      const protocolVersion = source.protocolVersion ?? '0.1';
      const definition = protocolVersion === '0.2' ? 'syncSnapshotV02' : 'snapshot';
      const assemblePage = (pageNodes: readonly SnapshotNode[]) => {
        const nextOffset = offset + pageNodes.length;
        const hasMore = nextOffset < nodeCount;
        const nextCursor = hasMore ? signCursor({
          snapshotId, generation: source.leaseGeneration, scope: cursorScope(source, cursorKeyId),
          offset: nextOffset, sequence: sequence + 1, limit, expiresAt: now() + ttl,
        }, options.cursorSecret) : null;
        const pageNodeIds = new Set(pageNodes.map((node) => node.id));
        const snapshotBase = {
          snapshotId, mode: 'sync' as const, complete: true,
          collection: structuredClone(source.collection), nodes: structuredClone([...pageNodes]),
          annotations: [], attachments: [], relations: [], tombstones: [], revision: source.contentRevision,
          syncCursor: source.bootstrapCursor, generatedAt,
          page: { nextCursor, hasMore, sequence }, warnings: [],
        };
        const snapshot: Snapshot | SyncSnapshotV02 = protocolVersion === '0.2'
          ? { ...snapshotBase, protocolVersion: '0.2' as const, parentRevisions: structuredClone(
            (source.parentRevisions ?? []).filter((revision) => pageNodeIds.has(revision.parentId)),
          ) }
          : { ...snapshotBase, protocolVersion: '0.1' as const };
        return { snapshot, nextOffset, hasMore };
      };
      // F013: a page over the negotiated byte budget must still make progress —
      // halve it to the largest fitting prefix (the parent-first ordering keeps
      // every emitted Node's parent in this or an earlier page) instead of
      // refusing the whole page. Only a single Node that alone exceeds the
      // budget stays inexpressible and keeps the payload_too_large contract.
      let pageNodes = source.pageNodes ?? source.nodes.slice(offset, offset + limit);
      let page = assemblePage(pageNodes);
      while (source.snapshotPageBytes !== undefined && pageNodes.length > 1
          && Buffer.byteLength(JSON.stringify(page.snapshot), 'utf8') > source.snapshotPageBytes) {
        pageNodes = pageNodes.slice(0, Math.max(1, Math.floor(pageNodes.length / 2)));
        page = assemblePage(pageNodes);
      }
      const { nextOffset, hasMore } = page;
      let snapshot = page.snapshot;
      const schema = createValidatorRegistry().validate(definition, snapshot);
      if (!schema.valid) throw new Error(`Authoritative Sync Snapshot failed COLP schema: ${JSON.stringify(schema.errors)}`);
      const semantic = validateSnapshotSemantics(snapshot as Snapshot, { referenceResolution: { mode: 'deferred' } });
      if (!semantic.valid) throw new Error(`Authoritative Sync Snapshot page failed COLP semantics: ${JSON.stringify(semantic.issues)}`);
      if (source.snapshotPageBytes !== undefined
          && Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > source.snapshotPageBytes) {
        throw new SyncBootstrapSnapshotError('payload_too_large');
      }
      if (source.replicaState === 'recovery_required') {
        await options.authority.recordPage?.({ sessionId: source.sessionId, snapshotId, sequence,
          startOffset: offset, endOffset: nextOffset, complete: !hasMore,
          responseDigest: createHash('sha256').update(JSON.stringify(snapshot)).digest('base64url') });
      }
      if (!hasMore) {
        await options.authority.markComplete?.({ sessionId: source.sessionId, snapshotId });
        if (source.replicaState === 'recovery_required' && options.authority.issueRecoveryCapability) {
          const recoveryCapability = await options.authority.issueRecoveryCapability({
            sessionId: source.sessionId, snapshotId });
          // FIX-M-012: the recovery capability is an independent protocol field issued only after
          // the complete page chain is verified, so every page keeps the identical syncCursor.
          // Protocol 0.1 clients negotiated the legacy contract and still receive the capability
          // inside syncCursor; the src1 prefix is no longer part of the current wire semantics.
          snapshot = Object.freeze(protocolVersion === '0.2'
            ? { ...snapshot, recoveryCapability }
            : { ...snapshot, syncCursor: recoveryCapability });
          if (!createValidatorRegistry().validate(definition, snapshot).valid) {
            throw new Error('Recovery capability is not a protocol-safe Snapshot field.');
          }
        }
      }
      return Object.freeze(snapshot);
    },
  });
}

function assertAuthority(source: SyncBootstrapAuthorityResult, now: number): void {
  if (Date.parse(source.sessionExpiresAt) <= now) throw new SyncBootstrapSnapshotError('authentication_required');
  if (source.replicaState !== 'active' && source.replicaState !== 'recovery_required') {
    throw new SyncBootstrapSnapshotError(source.replicaState === 'retired' ? 'replica_retired' : 'stale_replica');
  }
  if (source.collection.id !== source.collectionId || source.collection.revision !== source.contentRevision
    || source.collection.rootNodeId !== source.bindingRootNodeId) throw new SyncBootstrapSnapshotError('snapshot_expired');
}

export function assertSyncBootstrapSnapshotGraph(
  source: SyncBootstrapAuthorityResult,
  snapshotId: string,
  generatedAt: string,
): void {
  const ids = new Set<string>();
  for (const node of source.nodes) {
    if (ids.has(node.id)) throw new Error('Authoritative Sync Snapshot contains a duplicate Node ID');
    ids.add(node.id);
    if (node.collectionId !== source.collectionId) throw new SyncBootstrapSnapshotError('snapshot_expired');
  }
  if (!ids.has(source.bindingRootNodeId)) throw new Error('Authoritative Sync Snapshot binding root is absent');
  for (const node of source.nodes) if (node.parentId !== null && !ids.has(node.parentId)) throw new Error('Authoritative Sync Snapshot contains an orphan Node');
  if ((source.protocolVersion ?? '0.1') === '0.2') {
    const expectedParents = new Set(source.nodes
      .filter((node) => node.kind === 'root' || node.kind === 'folder').map((node) => node.id));
    const actualParents = new Set((source.parentRevisions ?? []).map((revision) => revision.parentId));
    if (expectedParents.size !== actualParents.size
        || actualParents.size !== (source.parentRevisions ?? []).length
        || [...expectedParents].some((parentId) => !actualParents.has(parentId))) {
      throw new Error('Authoritative Sync Snapshot lacks complete parent revision authority');
    }
  }
  const protocolVersion = source.protocolVersion ?? '0.1';
  const logicalBase = {
    snapshotId, mode: 'sync' as const, complete: true,
    collection: structuredClone(source.collection), nodes: [...structuredClone(source.nodes)],
    annotations: [], attachments: [], relations: [], tombstones: [], revision: source.contentRevision,
    syncCursor: source.bootstrapCursor, generatedAt,
    page: { nextCursor: null, hasMore: false, sequence: 1 }, warnings: [],
  };
  const logical: Snapshot | SyncSnapshotV02 = protocolVersion === '0.2'
    ? { ...logicalBase, protocolVersion: '0.2',
      parentRevisions: [...structuredClone(source.parentRevisions ?? [])] }
    : { ...logicalBase, protocolVersion: '0.1' };
  const structural = createValidatorRegistry().validate(
    protocolVersion === '0.2' ? 'syncSnapshotV02' : 'snapshot', logical,
  );
  if (!structural.valid) throw new Error(`Authoritative Sync Snapshot graph failed COLP schema: ${JSON.stringify(structural.errors)}`);
  const semantic = validateSnapshotSemantics(logical as Snapshot);
  if (!semantic.valid) throw new Error(`Authoritative Sync Snapshot graph failed COLP semantics: ${JSON.stringify(semantic.issues)}`);
}

function stableSnapshotId(source: SyncBootstrapAuthorityResult): string {
  return `snap_${snapshotMaterializationIdentity({
    protocolVersion: source.protocolVersion ?? '0.1', sessionId: source.sessionId, replicaId: source.replicaId,
    leaseGeneration: source.leaseGeneration, contentRevision: source.contentRevision,
    policyRevision: source.policyRevision, rootNodeId: source.bindingRootNodeId,
  })}`;
}

/**
 * Snapshot page cursors (`sb1.<packed fields>.<truncated-mac>`) are a
 * request-continuation MAC, not the shared keyed cursor codec. Left local;
 * sync cannot import `commands`, and the packed form is not that codec.
 */
function signCursor(payload: CursorPayload, secret: string | Uint8Array): string {
  const snapshotIdentity = payload.snapshotId.startsWith('snap_') ? payload.snapshotId.slice(5) : '';
  if (!/^[A-Za-z0-9_-]{32}$/u.test(snapshotIdentity)) throw new Error('Sync Snapshot identity is not cursor-safe');
  const encoded = [snapshotIdentity, payload.offset, payload.sequence, payload.limit,
    Math.floor(payload.expiresAt / 1_000), payload.generation]
    .map((value) => typeof value === 'number' ? value.toString(36) : value).join('.');
  const unsigned = `sb1.${encoded}.${payload.scope}`;
  const tag = createHmac('sha256', secret).update(unsigned).digest().subarray(0, 16).toString('base64url');
  return `${unsigned}.${tag}`;
}

function verifyCursor(value: string, secret: string | Uint8Array, expectedKeyId: string, now: number): CursorPayload {
  const [prefix, snapshotIdentity, rawOffset, rawSequence, rawLimit, rawExpiry, rawGeneration, scope, tag, extra] = value.split('.');
  if (prefix !== 'sb1' || !snapshotIdentity || !rawOffset || !rawSequence || !rawLimit || !rawExpiry
      || !rawGeneration || !scope || !tag || extra || !/^[A-Za-z0-9_-]{32}$/u.test(snapshotIdentity)) {
    throw new SyncBootstrapSnapshotError('invalid_cursor_scope');
  }
  const unsigned = [prefix, snapshotIdentity, rawOffset, rawSequence, rawLimit, rawExpiry, rawGeneration, scope].join('.');
  const expected = createHmac('sha256', secret).update(unsigned).digest().subarray(0, 16);
  let supplied: Buffer;
  try { supplied = Buffer.from(tag, 'base64url'); } catch { throw new SyncBootstrapSnapshotError('invalid_cursor_scope'); }
  if (supplied.length !== expected.length || supplied.toString('base64url') !== tag
      || !timingSafeEqual(supplied, expected)) throw new SyncBootstrapSnapshotError('invalid_cursor_scope');
  if (scope.slice(0, 6) !== createHash('sha256').update(expectedKeyId).digest('base64url').slice(0, 6)) {
    throw new SyncBootstrapSnapshotError('invalid_cursor_scope');
  }
  const parse = (raw: string): number => Number.parseInt(raw, 36);
  const offset = parse(rawOffset); const sequence = parse(rawSequence); const limit = parse(rawLimit);
  const expiresAt = parse(rawExpiry) * 1_000; const generation = parse(rawGeneration);
  if (![offset, sequence, limit, expiresAt, generation].every(Number.isSafeInteger)
      || offset < 1 || sequence < 2 || limit < 1 || generation < 1 || expiresAt <= now) {
    throw new SyncBootstrapSnapshotError('invalid_cursor_scope');
  }
  return { snapshotId: `snap_${snapshotIdentity}`, generation, offset, sequence, limit, expiresAt, scope };
}

function cursorScope(source: SyncBootstrapAuthorityResult, keyId: string): string {
  const keyPrefix = createHash('sha256').update(keyId).digest('base64url').slice(0, 6);
  const authority = createHash('sha256').update(JSON.stringify([
    source.sessionId, source.collectionId, source.replicaId, source.bindingMode, source.bindingRootNodeId,
  ])).digest('base64url').slice(0, 8);
  const fence = createHash('sha256').update(JSON.stringify([
    source.contentRevision, source.policyRevision,
  ])).digest('base64url').slice(0, 8);
  return `${keyPrefix}${authority}${fence}`;
}

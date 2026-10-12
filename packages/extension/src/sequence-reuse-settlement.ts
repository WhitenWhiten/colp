import { classifySequenceReuse, type SequenceReuseFacts } from './logical-operation-identity.js';
import { scopeKey } from './sync-state/scope-key.js';
import type { JsonObject, Lifecycle, QueueOperation, SyncScope } from './sync-state/types.js';
import type { StoredSession } from './types.js';

export function isSequenceReuseCode(code: string): code is 'sequence_reuse' | 'op_id_reused' {
  return code === 'sequence_reuse' || code === 'op_id_reused';
}

export function attemptOperations(body: string): unknown {
  const document = JSON.parse(body) as { operations?: unknown };
  return document.operations;
}

export function assertUnchangedOperationBytes(previousBody: string, nextBody: string): void {
  if (JSON.stringify(attemptOperations(previousBody)) !== JSON.stringify(attemptOperations(nextBody))) {
    throw new Error('push_attempt_operation_changed');
  }
}

/**
 * The persisted attempt body is encoded by the push request encoder with this
 * exact canonical form. Reuse classification must compare wire bytes, not
 * JavaScript key order, so the same encoding is used here.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  const encoded = JSON.stringify(value); if (encoded === undefined) throw new Error('push_request_invalid'); return encoded;
}

/** True only when the durable attempt still carries exactly the queued Operation bytes. */
function attemptOperationBytesMatch(body: string | undefined, payload: JsonObject): boolean {
  if (typeof body !== 'string') return false;
  try { return canonicalJson(attemptOperations(body)) === canonicalJson([payload]); }
  catch { return false; }
}

export function sequenceReuseFacts(input: {
  readonly code: 'sequence_reuse' | 'op_id_reused';
  readonly scope: SyncScope;
  readonly queue: QueueOperation;
  readonly session: StoredSession;
  readonly replicaLifecycle: Lifecycle;
  /** Durable local authority evidence for this operation: an applied receipt or a bound create mapping. */
  readonly hasLocalEvidence: boolean;
  /** `subject` of the credential that minted the push Session, when the host exposes it. */
  readonly credentialSubject?: string;
}): SequenceReuseFacts {
  const payload = input.queue.payload;
  const collectionId = typeof payload.collectionId === 'string' ? payload.collectionId : '';
  const replicaId = typeof payload.replicaId === 'string' ? payload.replicaId : '';
  const sequence = typeof payload.sequence === 'number' ? payload.sequence : -1;
  const opId = typeof payload.opId === 'string' ? payload.opId : '';
  // The durable row is stored under the account-scoped key (account, profile,
  // collection, replica and generation included). That binding is the account
  // proof when the host does not surface the credential subject; a row stored
  // under another scope key can never be treated as matching.
  const accountScoped = input.queue.scopeKey === scopeKey(input.scope);
  const identityScoped = accountScoped && collectionId === input.scope.collectionId
    && replicaId === input.scope.replicaId && sequence === input.queue.sequence && opId === input.queue.opId;
  return {
    code: input.code,
    authValid: input.session.replicaLease.state === 'active'
      && input.session.scope === 'collection'
      && Number.isFinite(Date.parse(input.session.expiresAt)),
    accountMatches: input.credentialSubject === undefined
      ? accountScoped : input.credentialSubject === input.scope.accountId,
    collectionMatches: collectionId === input.scope.collectionId
      && input.session.collection.collectionId === input.scope.collectionId,
    replicaMatches: replicaId === input.scope.replicaId,
    replicaLifecycle: input.replicaLifecycle,
    generationMatches: Number(input.session.replicaLease.generation) === input.scope.generation,
    sequenceMatches: sequence === input.queue.sequence,
    opIdMatches: opId === input.queue.opId,
    operationBytesMatch: attemptOperationBytesMatch(input.queue.attempt?.body, payload),
    isLocalPendingInScope: identityScoped
      && input.queue.status !== 'terminal' && input.queue.status !== 'rejected',
    clientResultUnknown: !input.hasLocalEvidence,
  };
}

export function classifyLocalSequenceReuse(input: Parameters<typeof sequenceReuseFacts>[0]) {
  return classifySequenceReuse(sequenceReuseFacts(input));
}

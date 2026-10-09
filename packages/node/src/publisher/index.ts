import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';

import canonicalize from 'canonicalize';
import { normalizeIfMatchForDigest } from './idempotency-digest.js';
import { normalizePublisherMediaType } from './media-type.js';
import {
  assertNonEmptyString,
  isJsonValue,
  isPlainJsonObject,
  snapshotCanonicalRequestDigestInput,
  snapshotPublisherIdempotencyBindingBase,
  snapshotPublisherIdempotencyKeyInput,
  snapshotPublisherIdempotencyRequest,
} from './input-snapshots.js';
export { normalizePublisherMediaType } from './media-type.js';

import {
  createValidatorRegistry,
  validateWireDocument,
  type DefinitionName,
} from '../schema/index.js';
import { endpointContracts, type EndpointKey } from '../semantic/endpoint-contracts.js';
import { validateManifestSemantics } from '../semantic/manifest.js';
import type { SemanticIssue } from '../semantic/index.js';
import { immutableJsonData, immutableJsonSnapshot } from '../shared/immutable-json.js';
import type { AuditEvent, Manifest, Operation } from '../types/index.js';
import type { CollectionCreate, CollectionCreateResult, RootCreate } from '../types/generated.js';
import { problemRegistry } from '../shared/problems.js';
import {
  reserveServerIds,
  type ServerIdReservation,
  type ServerIdReservationTransaction,
} from '../shared/server-id-reservations.js';

export {
  evaluatePublisherPrecondition,
  evaluatePublisherWritePrecondition,
  type PublisherWritePreconditionFailure,
  type PublisherWritePreconditionFailureWithEtag,
  type PublisherWritePreconditionInput,
  type PublisherWritePreconditionResult,
  type PublisherWritePreconditionResultWithEtag,
  type PublisherWritePreconditionSatisfied,
} from './preconditions.js';

export {
  executePublisherDelete,
  type PublisherDeleteRequest,
  type PublisherDeletionAdapterResult,
  type PublisherDeletionPort,
  type PublisherDeletionResourceType,
  type PublisherDeletionResources,
  type PublisherDeletionScope,
  type PublisherDeletionTransaction,
  type PublisherDeletionWatermark,
} from './deletion-receipt.js';

/**
 * Publisher Streamable HTTP request boundary (composition over SEC-0015/0016).
 * Adapters must derive {@link TrustedTransportEvidence} from deployment signals
 * and call this before handling remote Streamable HTTP — not atomic guards with
 * a self-asserted `remote: false` (M-1).
 */
export {
  enforcePublisherStreamableHttpBoundary,
  type PublisherStreamableHttpBoundaryDecision,
  type PublisherStreamableHttpBoundaryOptions,
  type TrustedTransportEvidence,
} from '../security/request-boundary.js';

export type {
  ServerIdReservation,
  ServerIdReservationConflict,
  ServerIdReservationResult,
  ServerIdReservationStore,
  ServerIdReservationTransaction,
  ServerIdResourceType,
} from '../shared/server-id-reservations.js';
export { reserveServerIds, ServerIdAlreadyReservedError } from '../shared/server-id-reservations.js';

export {
  mapPublisherSidecarOperation,
  toCanonicalOperation,
  type PublisherOperationContext,
  type PublisherSidecarAction,
  type PublisherSidecarKind,
  type PublisherSidecarOperationRequest,
  type PublisherSidecarPayload,
} from './operation-mapping.js';

export {
  applyPublisherOperations,
  mapPublisherNodeOperation,
  mapPublisherOperation,
  type PublisherNodeAction,
  type PublisherNodeOperationRequest,
  type PublisherNodePayload,
  type PublisherOperationApplicationPort,
  type PublisherOperationBatch,
  type PublisherOperationBatchResult,
  type PublisherOperationRequest,
  type PublisherWritableOperation,
} from './operation-application.js';

export {
  notifyPublisherInternalFailure,
  type PublisherInternalFailureObservation,
  type PublisherInternalFailureObserver,
  type PublisherInternalFailureOperation,
} from './internal-failure.js';

export {
  executePublisherGuardedNodeWrite,
  type PublisherGuardedNodeWritePorts,
  type PublisherGuardedNodeWriteResult,
  type PublisherNodeWriteAuthenticationDecision,
  type PublisherNodeWriteAuthorizationDecision,
  type PublisherNodeWriteAuthorizationSubject,
  type PublisherNodeWriteConcealmentDecision,
  type PublisherNodeWriteConcealmentInput,
  type PublisherNodeWriteUnitOfWork,
} from './node-write.js';

export {
  executePublisherOrdinaryNodeCreate,
  type PublisherOrdinaryNodeCreateOperation,
  type PublisherOrdinaryNodeCreatePorts,
  type PublisherOrdinaryNodeCreateRequest,
  type PublisherOrdinaryNodeCreateTransaction,
} from './node-create.js';

export {
  executePublisherNodeMove,
  type PublisherNodeMoveOperation,
  type PublisherNodeMovePorts,
  type PublisherNodeMovePositionContext,
  type PublisherNodeMoveRequest,
  type PublisherNodeMoveResult,
  type PublisherNodeMoveTransaction,
} from './node-move.js';

export {
  executePublisherNodeDelete,
  PUBLISHER_NODE_DELETE_SCOPE,
  type PublisherNodeDeleteOperation,
  type PublisherNodeDeletePorts,
  type PublisherNodeDeleteRequest,
  type PublisherNodeDeleteRequiredScope,
  type PublisherNodeDeleteResult,
  type PublisherNodeDeleteTransaction,
  type PublisherNodeDeletionApplicationLedger,
  type PublisherNodeDeletionPlanBinding,
  type PublisherNodeDeletionWatermark,
} from './node-delete.js';

export interface CanonicalRequestDigestInput {
  /** Authenticated principal identity. Included when supplied so the digest is
   * independently verifiable in addition to the idempotency uniqueness key. */
  readonly principalId?: string;
  readonly protocolVersion: string;
  readonly endpointKey: string;
  readonly resourceIdentity: string;
  readonly method: string;
  readonly query: Readonly<Record<string, unknown>>;
  readonly mediaType: string;
  readonly body: unknown;
  /** Normalized HTTP If-Match precondition, when the operation uses one. */
  readonly ifMatch?: string | null | readonly string[];
}

export function createCanonicalRequestDigest(input: CanonicalRequestDigestInput): string {
  const request = snapshotCanonicalRequestDigestInput(input);
  assertNonEmptyString(request.protocolVersion, 'protocolVersion');
  assertNonEmptyString(request.endpointKey, 'endpointKey');
  assertNonEmptyString(request.resourceIdentity, 'resourceIdentity');
  assertNonEmptyString(request.method, 'method');
  if (typeof request.mediaType !== 'string' || request.mediaType.trim().length === 0) {
    throw new TypeError('Canonical request mediaType must be a non-empty string.');
  }
  if (request.principalId !== undefined) assertNonEmptyString(request.principalId, 'principalId');
  if (!isPlainJsonObject(request.query)) {
    throw new TypeError('Canonical request query must be a decoded I-JSON object.');
  }
  if (request.body === undefined || !isJsonValue(request.body)) {
    throw new TypeError('Canonical request body must be an I-JSON value.');
  }
  const ifMatch = normalizeIfMatchForDigest(request.ifMatch) ?? null;
  const canonicalInput = {
    ...(request.principalId === undefined ? {} : { principalId: request.principalId }),
    protocolVersion: request.protocolVersion,
    endpointKey: request.endpointKey,
    resourceIdentity: request.resourceIdentity,
    method: request.method.toUpperCase(),
    query: request.query,
    mediaType: normalizePublisherMediaType(request.mediaType),
    body: request.body,
    ...(ifMatch === undefined ? {} : { ifMatch }),
  };
  // RFC 8785 canonicalization walks every string and allocates the complete
  // serialized document. Snapshot the assembled envelope with an aggregate
  // byte ceiling first so oversized caller-controlled strings cannot turn the
  // digest helper into an unbounded allocation path.
  const boundedCanonicalInput = immutableJsonSnapshot(canonicalInput, 'Canonical request digest input', {
    // Body/query each retain their I-JSON contract; allow the envelope and array length slots.
    maxDepth: 130,
    maxMembers: 400_010,
    maxBytes: 8 * 1024 * 1024,
  });
  const canonical = canonicalize(boundedCanonicalInput);
  if (canonical === undefined) {
    throw new TypeError('Canonical request input is not JSON serializable.');
  }
  return `sha-256:${createHash('sha256').update(canonical).digest('base64url')}`;
}

export interface PublisherIdempotencyRequest {
  readonly principalId: string;
  readonly protocolVersion: string;
  readonly method: string;
  readonly endpointKey: EndpointKey;
  readonly resourceIdentity: string;
  readonly idempotencyKey: string;
  /** Parsed and endpoint-validated DTO; raw query strings are not accepted. */
  readonly decodedQuery: Readonly<Record<string, unknown>>;
  readonly mediaType: string;
  /** Parsed I-JSON body; RFC 8785 serialization is applied by this boundary. */
  readonly body: unknown;
  /** Raw If-Match field used by conditional Publisher mutations. */
  readonly ifMatch?: string | null | readonly string[];
}

export interface IdempotencyBinding {
  /** Stable authenticated principal identifier. */
  readonly principalId: string;
  /** Negotiated Collection Protocol version. */
  readonly protocolVersion: string;
  /** Uppercase HTTP method. */
  readonly method: string;
  /** Manifest Endpoint key, not a concrete URL. */
  readonly endpointKey: string;
  /**
   * Stable request-target identity. Collection creation uses the instance/mount
   * creation scope, never a newly allocated Collection or Root ID.
   */
  readonly resourceIdentity: string;
  readonly key: string;
  readonly requestDigest: string;
}

/** Builds the complete uniqueness tuple and digest from one request view. */
export function createPublisherIdempotencyBinding(input: PublisherIdempotencyRequest): IdempotencyBinding {
  const request = snapshotPublisherIdempotencyRequest(input);
  if (typeof request.method !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(request.method)) {
    throw new TypeError('Publisher idempotency request method is invalid.');
  }
  if (typeof request.endpointKey !== 'string'
    || !Object.prototype.hasOwnProperty.call(endpointContracts, request.endpointKey)) {
    throw new TypeError('Publisher idempotency request endpointKey is not a Manifest Endpoint key.');
  }
  const method = request.method.toUpperCase();
  const operation = endpointContracts[request.endpointKey].operations.find(
    (candidate) => candidate.method === method && candidate.profile === 'publisher',
  );
  if (operation === undefined) {
    throw new TypeError('Publisher idempotency request method is not a Publisher operation for endpointKey.');
  }
  if (!isPlainJsonObject(request.decodedQuery)) {
    throw new TypeError('Publisher idempotency request decodedQuery must be a decoded I-JSON object.');
  }
  const queryDefinition = 'query' in operation ? operation.query : undefined;
  if (queryDefinition === undefined) {
    if (Object.keys(request.decodedQuery).length !== 0) {
      throw new TypeError('Publisher endpoint does not accept query parameters in decodedQuery.');
    }
  } else {
    const queryValidation = publisherRequestValidators.validate(
      queryDefinition as DefinitionName,
      request.decodedQuery,
    );
    if (!queryValidation.valid) {
      throw new TypeError('Publisher idempotency request decodedQuery does not satisfy the Endpoint contract.');
    }
  }
  const ifMatch = normalizeIfMatchForDigest(request.ifMatch) ?? null;
  const binding: IdempotencyBinding = {
    principalId: request.principalId,
    protocolVersion: request.protocolVersion,
    method,
    endpointKey: request.endpointKey,
    resourceIdentity: request.resourceIdentity,
    key: request.idempotencyKey,
    requestDigest: createCanonicalRequestDigest({
      principalId: request.principalId,
      protocolVersion: request.protocolVersion,
      method,
      endpointKey: request.endpointKey,
      resourceIdentity: request.resourceIdentity,
      query: request.decodedQuery,
      mediaType: request.mediaType,
      body: request.body,
      ifMatch,
    }),
  };
  validateIdempotencyBinding(binding);
  return Object.freeze(binding);
}

const publisherRequestValidators = createValidatorRegistry();

export interface PublisherIdempotencyKeyRequirementInput {
  /** HTTP method at the authenticated Publisher request boundary. */
  readonly method: string;
  /** Whether retrying this operation can safely reach the same logical command. */
  readonly retryable: boolean;
  /** Raw field value(s), before any adapter-specific coercion. */
  readonly idempotencyKey?: string | readonly string[] | null | undefined;
  /** Request dimensions already derived by the authenticated HTTP adapter. */
  readonly binding: Omit<IdempotencyBinding, 'method' | 'key'>;
}

export interface PublisherIdempotencyKeySatisfied {
  readonly state: 'satisfied';
  readonly required: true;
  readonly key: string;
  /** Pass this exact binding to executeIdempotentPublisherWrite. */
  readonly binding: IdempotencyBinding;
}

export interface PublisherIdempotencyKeyNotRequired {
  readonly state: 'not-required';
  readonly required: false;
  readonly reason: 'not-post' | 'not-retryable';
}

export interface PublisherIdempotencyKeyRejected {
  readonly state: 'rejected';
  readonly required: true;
  readonly reason: 'missing' | 'blank' | 'multiple' | 'invalid';
  readonly status: 428;
  readonly code: 'precondition_required';
  readonly retryable: true;
}

export type PublisherIdempotencyKeyRequirementResult =
  | PublisherIdempotencyKeySatisfied
  | PublisherIdempotencyKeyNotRequired
  | PublisherIdempotencyKeyRejected;

const IDEMPOTENCY_KEY_MAX_LENGTH = 255;
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x2B\x2D-\x7E]+$/u;

/**
 * Enforces PUBLISH-0009 at the Publisher HTTP boundary.
 *
 * A comma is rejected because HTTP stacks commonly combine repeated field lines
 * with commas. Accepting one would make a multi-value field indistinguishable
 * from a single key. Keys are otherwise bounded visible ASCII so they are safe
 * to persist and forward without whitespace or control-character ambiguity.
 */
export function evaluatePublisherIdempotencyKeyRequirement(
  input: PublisherIdempotencyKeyRequirementInput,
): PublisherIdempotencyKeyRequirementResult {
  const request = snapshotPublisherIdempotencyKeyInput(input);
  if (typeof request.method !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(request.method)) {
    throw new TypeError('Publisher idempotency-key evaluation requires a valid HTTP method.');
  }
  if (typeof request.retryable !== 'boolean') {
    throw new TypeError('Publisher idempotency-key evaluation requires a retryable boolean.');
  }

  const method = request.method.toUpperCase();
  if (method !== 'POST') {
    return Object.freeze({ state: 'not-required', required: false, reason: 'not-post' });
  }
  if (!request.retryable) {
    return Object.freeze({ state: 'not-required', required: false, reason: 'not-retryable' });
  }

  const reject = (reason: PublisherIdempotencyKeyRejected['reason']): PublisherIdempotencyKeyRejected => {
    const problem = problemRegistry.precondition_required;
    return Object.freeze({
      state: 'rejected',
      required: true,
      reason,
      status: problem.status,
      code: 'precondition_required',
      retryable: problem.retryable,
    });
  };
  const raw = request.idempotencyKey;
  if (raw === undefined || raw === null) return reject('missing');
  if (Array.isArray(raw)) {
    const values = immutableJsonData(raw, 'Publisher Idempotency-Key field') as readonly unknown[];
    if (values.length === 0) return reject('missing');
    if (values.length !== 1) return reject('multiple');
    const key: unknown = values[0];
    if (typeof key !== 'string') return reject('invalid');
    return finishPublisherIdempotencyKey(request.binding, method, key, reject);
  }
  const key: unknown = raw;
  if (typeof key !== 'string') return reject('invalid');
  return finishPublisherIdempotencyKey(request.binding, method, key, reject);
}

function finishPublisherIdempotencyKey(
  rawBinding: unknown,
  method: string,
  key: string,
  reject: (reason: PublisherIdempotencyKeyRejected['reason']) => PublisherIdempotencyKeyRejected,
): PublisherIdempotencyKeyRequirementResult {
  if (key.trim().length === 0) return reject('blank');
  if (key.length > IDEMPOTENCY_KEY_MAX_LENGTH || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
    return reject(key.includes(',') ? 'multiple' : 'invalid');
  }
  const sourceBinding = snapshotPublisherIdempotencyBindingBase(rawBinding);

  const binding = Object.freeze({
    principalId: sourceBinding.principalId,
    protocolVersion: sourceBinding.protocolVersion,
    method,
    endpointKey: sourceBinding.endpointKey,
    resourceIdentity: sourceBinding.resourceIdentity,
    key,
    requestDigest: sourceBinding.requestDigest,
  }) as IdempotencyBinding;
  validateIdempotencyBinding(binding);
  return Object.freeze({ state: 'satisfied', required: true, key, binding });
}

export interface StoredPublisherResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export type StoredIdempotencyResult = StoredPublisherResponse;

export type IdempotencyClaim =
  | { readonly state: 'claimed' }
  | { readonly state: 'in-progress' }
  | { readonly state: 'conflict'; readonly storedRequestDigest: string }
  | { readonly state: 'replay'; readonly response: StoredPublisherResponse };

export interface IdempotencyStore {
  /**
   * Atomically reserves the binding identity or returns the existing request's state.
   *
   * Adapters MUST enforce a database-level unique constraint over principalId,
   * protocolVersion, method, endpointKey, resourceIdentity, and key. The digest is
   * deliberately excluded so reuse with a different request can be reported as a
   * conflict instead of being treated as a second claim.
   */
  claim(binding: IdempotencyBinding): Promise<IdempotencyClaim>;

  /**
   * Saves an immutable copy of the first complete HTTP response and MUST NOT
   * overwrite it.
   */
  complete(binding: IdempotencyBinding, response: StoredPublisherResponse): Promise<void>;
}

export interface OutboxEvent {
  readonly id: string;
  readonly topic: string;
  readonly payload: unknown;
}

export interface OutboxStore {
  append(event: OutboxEvent): Promise<void>;
}

export interface OperationStore {
  append(operation: Operation): Promise<void>;
}

export interface AuditStore {
  append(event: AuditEvent): Promise<void>;
}

/**
 * Resource commands are adapter-specific, but their store must be transaction-bound.
 * Applications should supply a concrete interface as PublisherTransaction's first
 * type parameter instead of escaping a database client from the transaction.
 */
export type ResourceStore = object;

export interface PublisherTransaction<Resources extends ResourceStore = ResourceStore>
  extends ServerIdReservationTransaction {
  readonly resources: Resources;
  readonly idempotency: IdempotencyStore;
  readonly operations: OperationStore;
  readonly audit: AuditStore;
  readonly outbox: OutboxStore;
}

export interface PublisherUnitOfWork<Transaction extends PublisherTransaction = PublisherTransaction> {
  /**
   * Commits only after work resolves and rolls back every child store when it rejects.
   * Child stores MUST share one underlying durable transaction and MUST NOT commit
   * independently.
   *
   * The returned Promise MUST resolve only after that commit is known durable. A
   * failed or unknown commit outcome (including timeout or lost acknowledgement)
   * MUST reject it. The callback result alone is never evidence of commit.
   */
  execute<Result>(work: (transaction: Transaction) => Promise<Result>): Promise<Result>;
}

export type IdempotentPublisherWriteResult =
  | { readonly state: 'committed'; readonly response: StoredPublisherResponse }
  | { readonly state: 'replayed'; readonly response: StoredPublisherResponse }
  | { readonly state: 'in-progress' }
  | { readonly state: 'conflict'; readonly storedRequestDigest: string };

/**
 * Coordinates an idempotent write inside the adapter's transaction. This function
 * intentionally provides no process-local locking: cross-process serialization and
 * uniqueness are properties of PublisherUnitOfWork and IdempotencyStore adapters.
 * The write callback must reject for any outcome that should roll back; returning a
 * response means the resource changes and that response may be committed together.
 */
export async function executeIdempotentPublisherWrite<Transaction extends PublisherTransaction>(
  unitOfWork: PublisherUnitOfWork<Transaction>,
  binding: IdempotencyBinding,
  write: (transaction: Transaction) => Promise<StoredPublisherResponse>,
): Promise<IdempotentPublisherWriteResult> {
  const checkedBinding = snapshotIdempotencyBinding(binding);
  if (typeof write !== 'function' || nodeTypes.isProxy(write)) {
    throw new TypeError('Publisher idempotency write callback must be a non-Proxy function.');
  }
  const execute = bindPublisherPortMethod<PublisherUnitOfWork<Transaction>['execute']>(
    unitOfWork,
    'execute',
    'Publisher unit of work',
  );
  let callbackActive = true;
  let callbackCount = 0;
  let completedOutcome: IdempotentPublisherWriteResult | undefined;
  const pending = execute(async (transaction) => {
    if (!callbackActive || callbackCount !== 0) {
      throw new TypeError('Publisher unit of work invoked its callback more than once or too late.');
    }
    callbackCount += 1;
    const idempotency = publisherDataProperty(transaction, 'idempotency', 'Publisher transaction');
    const claimPort = bindPublisherPortMethod<IdempotencyStore['claim']>(
      idempotency,
      'claim',
      'Publisher idempotency store',
    );
    const completePort = bindPublisherPortMethod<IdempotencyStore['complete']>(
      idempotency,
      'complete',
      'Publisher idempotency store',
    );
    const claim = snapshotIdempotencyClaim(await requirePublisherPromise(
      claimPort(checkedBinding),
      'Publisher idempotency claim',
    ));

    switch (claim.state) {
      case 'replay':
        completedOutcome = Object.freeze({ state: 'replayed', response: claim.response });
        break;
      case 'in-progress':
        completedOutcome = Object.freeze({ state: 'in-progress' });
        break;
      case 'conflict':
        completedOutcome = Object.freeze({
          state: 'conflict',
          storedRequestDigest: claim.storedRequestDigest,
        });
        break;
      case 'claimed': {
        const response = snapshotStoredResponse(await requirePublisherPromise(
          write(transaction),
          'Publisher write callback',
        ));
        await requirePublisherPromise(
          completePort(checkedBinding, response),
          'Publisher idempotency completion',
        );
        completedOutcome = Object.freeze({ state: 'committed', response });
        break;
      }
    }
    return completedOutcome;
  });
  let outcome: IdempotentPublisherWriteResult;
  try {
    outcome = await requirePublisherPromise(pending, 'Publisher unit of work');
  } finally {
    callbackActive = false;
  }
  if (callbackCount !== 1 || completedOutcome === undefined || outcome !== completedOutcome) {
    throw new TypeError('Publisher unit of work did not durably return its callback result.');
  }
  return outcome;
}

export type PublisherIdempotencyBoundaryResult =
  | { readonly state: 'committed' | 'replayed'; readonly response: StoredPublisherResponse }
  | {
    readonly state: 'rejected';
    readonly status: 409;
    readonly code: 'idempotency_key_reused' | 'idempotency_in_progress';
    readonly retryable: boolean;
  };

/** Maps store-level concurrency states to the stable registered HTTP contract. */
export function mapPublisherIdempotencyResult(
  result: IdempotentPublisherWriteResult,
): PublisherIdempotencyBoundaryResult {
  switch (result.state) {
    case 'committed':
    case 'replayed':
      return Object.freeze({ state: result.state, response: result.response });
    case 'conflict': {
      const definition = problemRegistry.idempotency_key_reused;
      return Object.freeze({
        state: 'rejected',
        status: definition.status,
        code: 'idempotency_key_reused',
        retryable: definition.retryable,
      });
    }
    case 'in-progress': {
      const definition = problemRegistry.idempotency_in_progress;
      return Object.freeze({
        state: 'rejected',
        status: definition.status,
        code: 'idempotency_in_progress',
        retryable: definition.retryable,
      });
    }
    default:
      throw new TypeError('Publisher idempotency result is unknown.');
  }
}

/**
 * Reusable Publisher application boundary: derives the complete binding, then
 * delegates atomic claim/write/response persistence to PublisherUnitOfWork.
 */
export async function executePublisherIdempotencyBoundary<
  Transaction extends PublisherTransaction,
>(
  unitOfWork: PublisherUnitOfWork<Transaction>,
  request: PublisherIdempotencyRequest,
  write: (transaction: Transaction) => Promise<StoredPublisherResponse>,
): Promise<PublisherIdempotencyBoundaryResult> {
  const binding = createPublisherIdempotencyBinding(request);
  const result = await executeIdempotentPublisherWrite(unitOfWork, binding, write);
  return mapPublisherIdempotencyResult(result);
}

/** Host-owned durable-store capability inspected by Manifest composition. */
export interface PublisherIdempotencyRetentionPort {
  /** Return the minimum number of seconds the store actually guarantees for this mount. */
  getMinimumRetentionSeconds(mountId: string): Promise<number>;
}

const publisherRetentionVerification = Symbol('PublisherIdempotencyRetentionVerification');

/**
 * A checked composition fact, not deployment evidence and not a Publisher
 * Profile claim. Hosts can verify this again at startup against live adapter
 * configuration and the exact Manifest they will serve.
 */
export interface PublisherIdempotencyRetentionVerification {
  readonly [publisherRetentionVerification]: true;
  readonly mountId: string;
  readonly declaredRetentionSeconds: number;
  readonly guaranteedRetentionSeconds: number;
}

const publisherManifestValidators = createValidatorRegistry();

export async function verifyPublisherIdempotencyRetention(
  manifest: unknown,
  mountId: string,
  retention: PublisherIdempotencyRetentionPort,
): Promise<PublisherIdempotencyRetentionVerification> {
  assertNonEmptyString(mountId, 'Manifest mountId');
  if (retention === null || typeof retention !== 'object'
    || typeof retention.getMinimumRetentionSeconds !== 'function') {
    throw new TypeError('Publisher idempotency retention port is required.');
  }
  const validation = validateWireDocument<Manifest, SemanticIssue>(
    publisherManifestValidators,
    'manifest',
    manifest,
    validateManifestSemantics,
  );
  if (!validation.valid) throw new TypeError('Publisher retention requires a valid Manifest.');
  const mount = validation.value.mounts.find((candidate) => candidate.id === mountId);
  if (mount === undefined || !mount.profiles.includes('publisher')) {
    throw new TypeError('Publisher retention mount must exist and declare the Publisher Profile.');
  }
  const declared = mount.limits.idempotencyRetentionSeconds;
  if (!Number.isSafeInteger(declared) || declared === undefined || declared < 1) {
    throw new TypeError('Publisher Manifest must declare a positive idempotency retention minimum.');
  }
  const guaranteed = await retention.getMinimumRetentionSeconds(mountId);
  if (!Number.isSafeInteger(guaranteed) || guaranteed < declared) {
    throw new RangeError('Publisher idempotency store retention is below the Manifest declaration.');
  }
  return Object.freeze({
    [publisherRetentionVerification]: true as const,
    mountId,
    declaredRetentionSeconds: declared,
    guaranteedRetentionSeconds: guaranteed,
  });
}

/**
 * Server-resolved command for atomic Collection + Root creation. The IDs are
 * deliberately outside the canonical request body: the application reserves
 * them, while `collection` and `root` remain the protocol DTOs.
 */
export interface PublisherCollectionCreateRequest {
  readonly collectionId: string;
  readonly rootNodeId: string;
  readonly collection: CollectionCreate;
  readonly root: RootCreate;
}

/**
 * Transaction-bound persistence port for the indivisible Collection + Root
 * command. It MUST use only the transaction represented by its containing
 * PublisherCollectionCreateTransaction. It MUST NOT commit either resource,
 * open an independent transaction, or expose a single-resource create path.
 *
 * The returned pair is still checked at the application boundary. The adapter
 * remains responsible for inserting exactly one Root and for enforcing, under
 * concurrency, durable uniqueness of Root.collectionId plus mutually consistent
 * foreign-key constraints between Collection.rootNodeId and Root.collectionId.
 * No process-local or framework-specific locking is implied here.
 */
export interface PublisherCollectionCreateResources {
  createCollectionAndRoot(
    request: PublisherCollectionCreateRequest,
  ): Promise<CollectionCreateResult>;
}

export interface PublisherCollectionCreateTransaction
  extends PublisherTransaction<PublisherCollectionCreateResources> {}

/** Explicit application port used by HTTP/Nest adapters for POST /collections. */
export interface PublisherCollectionCreatePort<
  Transaction extends PublisherCollectionCreateTransaction = PublisherCollectionCreateTransaction,
> {
  readonly unitOfWork: PublisherUnitOfWork<Transaction>;
  createCollection(
    binding: IdempotencyBinding,
    request: PublisherCollectionCreateRequest,
  ): Promise<IdempotentPublisherWriteResult>;
}

/**
 * Coordinates an atomic Collection + unique Root creation. The canonical body
 * and server-resolved IDs are snapshotted before the UoW starts. The idempotency
 * claim, both permanent server ID reservations, the paired resource command and
 * stored response all participate in that one UoW.
 * The binding's resourceIdentity is the stable instance/mount creation scope;
 * server-assigned result IDs must not affect the request key or digest. On
 * replay, the original stored IDs win over this attempt's unused allocation.
 *
 * A successful result means the UoW has durably committed. Failed, rolled-back,
 * timed-out, cancelled, disconnected, or otherwise unknown commit outcomes MUST
 * reject the UoW promise; this function never converts them into success.
 */
export async function executePublisherCollectionCreate<
  Transaction extends PublisherCollectionCreateTransaction,
>(
  unitOfWork: PublisherUnitOfWork<Transaction>,
  binding: IdempotencyBinding,
  request: PublisherCollectionCreateRequest,
): Promise<IdempotentPublisherWriteResult> {
  const command = snapshotPublisherCollectionCreateRequest(request);
  const checkedBinding = snapshotIdempotencyBinding(binding);
  if (checkedBinding.method !== 'POST'
    || checkedBinding.endpointKey !== 'collection-create') {
    throw new TypeError('Publisher Collection create binding does not match the command endpoint.');
  }
  if (checkedBinding.resourceIdentity === command.collectionId
    || checkedBinding.resourceIdentity === command.rootNodeId) {
    throw new TypeError('Publisher Collection create binding requires a stable creation scope, not an allocated result ID.');
  }
  const outcome = await executeIdempotentPublisherCreation(
    unitOfWork,
    checkedBinding,
    [
      { id: command.collectionId, resourceType: 'collection' },
      { id: command.rootNodeId, resourceType: 'node' },
    ],
    async (transaction) => {
      const result = snapshotPublisherCollectionCreateResult(
        await transaction.resources.createCollectionAndRoot(command),
        command,
      );
      return Object.freeze({ status: 201, headers: Object.freeze({}), body: result });
    },
  );
  if (outcome.state !== 'committed' && outcome.state !== 'replayed') return outcome;
  return Object.freeze({
    state: outcome.state,
    response: snapshotPublisherCollectionCreateResponse(
      outcome.response,
      outcome.state === 'committed' ? command : undefined,
    ),
  });
}

function snapshotPublisherCollectionCreateRequest(
  request: PublisherCollectionCreateRequest,
): PublisherCollectionCreateRequest {
  if (request === null || typeof request !== 'object') {
    throw new TypeError('Publisher Collection create request is required.');
  }
  const command = immutableJsonData(request, 'Publisher Collection create request');
  if (Array.isArray(command)
    || Reflect.ownKeys(command).length !== 4
    || !Object.hasOwn(command, 'collectionId')
    || !Object.hasOwn(command, 'rootNodeId')
    || !Object.hasOwn(command, 'collection')
    || !Object.hasOwn(command, 'root')) {
    throw new TypeError('Publisher Collection create request contains unknown or missing fields.');
  }
  const collectionId = publisherRequestValidators.validate('opaqueId', command.collectionId);
  const rootNodeId = publisherRequestValidators.validate('opaqueId', command.rootNodeId);
  if (!collectionId.valid || !rootNodeId.valid) {
    throw new TypeError('Publisher Collection and Root IDs must be canonical opaque IDs.');
  }
  if (command.collectionId === command.rootNodeId) {
    throw new TypeError('Collection and Root IDs must be distinct.');
  }
  if (command.root === null || typeof command.root !== 'object'
    || Array.isArray(command.root) || command.root.folderRole !== 'root') {
    throw new TypeError('Publisher Collection create Root must have folderRole root.');
  }
  const body = { collection: command.collection, root: command.root };
  const validation = publisherRequestValidators.validate('collectionCreateRequest', body);
  if (!validation.valid) {
    throw new TypeError('Publisher Collection create body is not a canonical Collection + Root request.');
  }
  return command;
}

function snapshotPublisherCollectionCreateResult(
  result: unknown,
  request?: PublisherCollectionCreateRequest,
): CollectionCreateResult {
  if (result === null || typeof result !== 'object') {
    throw new TypeError('Collection create adapter returned an invalid result.');
  }
  const candidate = immutableJsonData(result, 'Publisher Collection create result') as CollectionCreateResult;
  if (Array.isArray(candidate)
    || Reflect.ownKeys(candidate).length !== 3
    || !Object.hasOwn(candidate, 'collection')
    || !Object.hasOwn(candidate, 'root')
    || !Object.hasOwn(candidate, 'links')) {
    throw new TypeError('Collection create result contains unknown or missing fields.');
  }
  if (candidate.collection === null || typeof candidate.collection !== 'object'
    || Array.isArray(candidate.collection)
    || candidate.root === null || typeof candidate.root !== 'object'
    || Array.isArray(candidate.root)
    || candidate.links === null || typeof candidate.links !== 'object'
    || Array.isArray(candidate.links)) {
    throw new TypeError('Collection create result must contain Collection, Root and links objects.');
  }
  const validation = publisherRequestValidators.validate('collectionCreateResult', candidate);
  if (!validation.valid) {
    throw new TypeError('Collection create adapter result does not satisfy the wire schema.');
  }
  // Replays are bound by the durable idempotency claim, not a retry's new IDs.
  // Always check the stored pair's own referential integrity as well.
  const collectionId = request?.collectionId ?? candidate.collection.id;
  const rootNodeId = request?.rootNodeId ?? candidate.collection.rootNodeId;
  if (candidate.collection.id !== collectionId
    || candidate.collection.id === rootNodeId
    || candidate.collection.rootNodeId !== rootNodeId
    || candidate.root.id !== rootNodeId
    || candidate.root.kind !== 'root'
    || candidate.root.parentId !== null
    || (candidate.root.position !== undefined && candidate.root.position !== null)
    || candidate.root.collectionId !== collectionId
    || candidate.root.folderRole !== 'root') {
    throw new TypeError('Collection create result violates Collection/Root identity invariants.');
  }
  return candidate;
}

function snapshotPublisherCollectionCreateResponse(
  response: StoredPublisherResponse,
  request?: PublisherCollectionCreateRequest,
): StoredPublisherResponse {
  const checkedResponse = snapshotStoredResponse(response);
  if (checkedResponse.status !== 201) {
    throw new TypeError('Collection create idempotency response must have status 201.');
  }
  const headers = immutableJsonData(
    checkedResponse.headers,
    'Publisher Collection create response headers',
  ) as Readonly<Record<string, string>>;
  const body = snapshotPublisherCollectionCreateResult(checkedResponse.body, request);
  return Object.freeze({ status: 201, headers, body });
}

function assertRequestDigest(value: unknown): asserts value is string {
  // SHA-256 is 32 octets; unpadded base64url encoding is exactly 43 chars.
  // Rejecting arbitrary-length strings prevents adapters/tests from treating a
  // label such as `sha-256:digest` as a cryptographic request binding.
  if (typeof value !== 'string' || !/^sha-256:[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new TypeError('Idempotency request digest must be a canonical SHA-256 digest.');
  }
}

function validateIdempotencyBinding(binding: IdempotencyBinding): void {
  if (binding === null || typeof binding !== 'object') throw new TypeError('Idempotency binding is required.');
  assertNonEmptyString(binding.principalId, 'idempotency principalId');
  assertNonEmptyString(binding.protocolVersion, 'idempotency protocolVersion');
  assertNonEmptyString(binding.method, 'idempotency method');
  if (!/^[!#$%&'*+.^_`|~0-9A-Z-]+$/u.test(binding.method)) {
    throw new TypeError('Canonical request idempotency method must be uppercase HTTP token syntax.');
  }
  assertNonEmptyString(binding.endpointKey, 'idempotency endpointKey');
  assertNonEmptyString(binding.resourceIdentity, 'idempotency resourceIdentity');
  assertNonEmptyString(binding.key, 'idempotency key');
  if (binding.key.length > IDEMPOTENCY_KEY_MAX_LENGTH || !IDEMPOTENCY_KEY_PATTERN.test(binding.key)) {
    throw new TypeError('Canonical request idempotency key is invalid.');
  }
  assertRequestDigest(binding.requestDigest);
}

function snapshotIdempotencyBinding(binding: IdempotencyBinding): IdempotencyBinding {
  if (binding === null || typeof binding !== 'object') {
    throw new TypeError('Idempotency binding is required.');
  }
  const candidate = immutableJsonData(binding, 'Idempotency binding') as IdempotencyBinding;
  const expectedKeys: readonly (keyof IdempotencyBinding)[] = [
    'principalId',
    'protocolVersion',
    'method',
    'endpointKey',
    'resourceIdentity',
    'key',
    'requestDigest',
  ];
  if (Array.isArray(candidate)
    || Reflect.ownKeys(candidate).length !== expectedKeys.length
    || !expectedKeys.every((key) => Object.hasOwn(candidate, key))) {
    throw new TypeError('Idempotency binding contains unknown or missing fields.');
  }
  validateIdempotencyBinding(candidate);
  return candidate;
}

const httpFieldNamePattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const invalidHttpFieldValuePattern = /[\u0000-\u0008\u000a-\u001f\u007f]/u;

function snapshotStoredResponse(response: unknown): StoredPublisherResponse {
  if (!isPlainJsonObject(response)
    || Reflect.ownKeys(response).length !== 3
    || !Object.hasOwn(response, 'status')
    || !Object.hasOwn(response, 'headers')
    || !Object.hasOwn(response, 'body')) {
    throw new TypeError('Idempotency replay response must be an exact plain I-JSON response.');
  }
  const candidate = immutableJsonData(response, 'Idempotency replay response') as unknown as StoredPublisherResponse;
  if (!Number.isInteger(candidate.status) || candidate.status < 100 || candidate.status > 599) {
    throw new TypeError('Idempotency replay response status is invalid.');
  }
  if (!isPlainJsonObject(candidate.headers)) {
    throw new TypeError('Idempotency replay response headers are invalid.');
  }
  const normalizedNames = new Set<string>();
  for (const [name, value] of Object.entries(candidate.headers)) {
    const normalizedName = name.toLowerCase();
    if (!httpFieldNamePattern.test(name) || normalizedNames.has(normalizedName)
      || typeof value !== 'string' || invalidHttpFieldValuePattern.test(value)) {
      throw new TypeError('Idempotency replay response headers are invalid.');
    }
    normalizedNames.add(normalizedName);
  }
  return candidate;
}

function snapshotIdempotencyClaim(value: unknown): IdempotencyClaim {
  const claim = exactPublisherDataObject(value, 'Publisher idempotency claim');
  switch (claim.state) {
    case 'claimed':
    case 'in-progress':
      assertPublisherDataKeys(claim, ['state'], 'Publisher idempotency claim');
      return Object.freeze({ state: claim.state });
    case 'conflict':
      assertPublisherDataKeys(
        claim,
        ['state', 'storedRequestDigest'],
        'Publisher idempotency conflict claim',
      );
      assertRequestDigest(claim.storedRequestDigest);
      return Object.freeze({ state: 'conflict', storedRequestDigest: claim.storedRequestDigest });
    case 'replay':
      assertPublisherDataKeys(claim, ['state', 'response'], 'Publisher idempotency replay claim');
      return Object.freeze({ state: 'replay', response: snapshotStoredResponse(claim.response) });
    default:
      throw new TypeError('Idempotency adapter returned an unknown claim state.');
  }
}

function exactPublisherDataObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)) {
    throw new TypeError(`${label} must be a plain non-Proxy data object.`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain non-Proxy data object.`);
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || descriptor === undefined || !descriptor.enumerable
      || !('value' in descriptor)) {
      throw new TypeError(`${label} must contain only enumerable data properties.`);
    }
  }
  return value as Record<string, unknown>;
}

function assertPublisherDataKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length || !expected.every((key) => Object.hasOwn(value, key))) {
    throw new TypeError(`${label} contains unknown or missing fields.`);
  }
}

function publisherDataProperty(owner: unknown, name: string, label: string): object {
  if (owner === null || typeof owner !== 'object' || nodeTypes.isProxy(owner)) {
    throw new TypeError(`${label} must be a non-Proxy object.`);
  }
  const descriptor = findPublisherDataProperty(owner, name, label);
  if (descriptor === undefined || !('value' in descriptor)
    || descriptor.value === null || typeof descriptor.value !== 'object'
    || nodeTypes.isProxy(descriptor.value)) {
    throw new TypeError(`${label} ${name} must be a non-Proxy data object.`);
  }
  return descriptor.value;
}

function bindPublisherPortMethod<Method extends (...args: any[]) => unknown>(
  owner: unknown,
  name: string,
  label: string,
): Method {
  if (owner === null || typeof owner !== 'object' || nodeTypes.isProxy(owner)) {
    throw new TypeError(`${label} must be a non-Proxy object.`);
  }
  const descriptor = findPublisherDataProperty(owner, name, label);
  if (descriptor === undefined || !('value' in descriptor)
    || typeof descriptor.value !== 'function' || nodeTypes.isProxy(descriptor.value)) {
    throw new TypeError(`${label} ${name} must be a non-Proxy data method.`);
  }
  const method = descriptor.value as Method;
  return ((...args: Parameters<Method>) => Reflect.apply(method, owner, args)) as Method;
}

function findPublisherDataProperty(
  owner: object,
  name: string,
  label: string,
): PropertyDescriptor | undefined {
  let current: object | null = owner;
  while (current !== null) {
    if (nodeTypes.isProxy(current)) throw new TypeError(`${label} prototype cannot be a Proxy.`);
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor !== undefined) {
      if (!('value' in descriptor)) throw new TypeError(`${label} ${name} must be a data property.`);
      return descriptor;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return undefined;
}

function requirePublisherPromise<Result>(candidate: Promise<Result>, label: string): Promise<Result> {
  if (!(candidate instanceof Promise)) throw new TypeError(`${label} must return a native Promise.`);
  return candidate;
}

/**
 * Coordinates an idempotent creation and its permanent ID reservations. Replays do
 * not attempt to reserve the IDs again; a newly claimed request reserves them before
 * invoking the resource mutation, all within the same transaction.
 */
export async function executeIdempotentPublisherCreation<
  Transaction extends PublisherTransaction,
>(
  unitOfWork: PublisherUnitOfWork<Transaction>,
  binding: IdempotencyBinding,
  reservations: readonly ServerIdReservation[],
  write: (transaction: Transaction) => Promise<StoredPublisherResponse>,
): Promise<IdempotentPublisherWriteResult> {
  return executeIdempotentPublisherWrite(unitOfWork, binding, async (transaction) => {
    await reserveServerIds(transaction, reservations);
    return write(transaction);
  });
}

import { createHash, randomBytes } from 'node:crypto';
import {
  type CanonicalMutationAction,
  type CanonicalMutationApplication,
  type CanonicalMutationResult,
  type CanonicalResourceMutation,
  type RelativePosition,
  type ResourceIdentity,
  type ResourceOwnedFields,
  type TransactionContext,
} from '../../collections/index.js';
import { admitPublisherMutation } from './admission.js';
import type {
  PublisherIdempotencyBinding,
  PublisherIdempotencyPort,
  PublisherStoredResult,
} from './ports.js';

export const PUBLISHER_PRINCIPAL_TYPE = 'publisher_client' as const;
export const PUBLISHER_INTERNAL_RESULT_SCHEMA_VERSION = 'publisher-internal-result/v1';
export const PUBLISHER_INTERNAL_RESULT_MEDIA_TYPE =
  'application/vnd.known.publisher-internal-result+json';

/**
 * Exact-replay internal result contract for Canonical Mutation harness outcomes.
 * Owned by Publisher admission; Canonical Mutation does not serialize HTTP.
 */
export interface PublisherInternalResultContract {
  readonly schemaVersion: typeof PUBLISHER_INTERNAL_RESULT_SCHEMA_VERSION;
  readonly mediaType: typeof PUBLISHER_INTERNAL_RESULT_MEDIA_TYPE;
  readonly outcome: 'applied';
  readonly operationId: string;
  readonly collectionId: string;
  readonly resourceId: string;
  readonly action: string;
  readonly allocation: {
    readonly commitOrdinal: string;
    readonly resourceRevision?: string;
    readonly contentRevision?: string;
    readonly policyRevision?: string;
    readonly childrenRevisions: Readonly<Record<string, string>>;
    readonly positionToken?: string;
  };
}

/**
 * Transaction-bound ports for the Publisher + Canonical Mutation harness.
 *
 * - publisher_idempotency only (never product_command_receipts)
 * - shared CanonicalMutationApplication (same write order / field authority)
 * - single surrounding UoW transaction (no nesting, no Product transport)
 */
export interface PublisherCanonicalMutationHarnessPorts<Transaction> {
  readonly publisherIdempotency: PublisherIdempotencyPort;
  readonly canonical: CanonicalMutationApplication<Transaction>;
}

export interface ExecutePublisherCanonicalMutationInput {
  readonly binding: PublisherIdempotencyBinding;
  /**
   * Request payload included in the fingerprint (namespace + principal +
   * resource identity + payload). Callers may pass a precomputed fingerprint
   * via `fingerprint` to skip re-hashing (tests).
   */
  readonly payload: unknown;
  readonly collectionId: string;
  readonly mutation: {
    readonly action: CanonicalMutationAction;
    readonly target: ResourceIdentity;
    readonly parentId: string | null;
    readonly relativePosition?: RelativePosition;
    readonly fields?: ResourceOwnedFields;
    readonly expectedResourceRevision?: string;
  };
  /** Optional override; production admission owns generation. */
  readonly operationId?: string;
  /** Optional precomputed fingerprint (must match publisherMutationFingerprint). */
  readonly fingerprint?: string;
}

export type ExecutePublisherCanonicalMutationResult =
  | {
      readonly kind: 'executed';
      readonly operationId: string;
      readonly binding: PublisherIdempotencyBinding;
      readonly fingerprint: string;
      readonly mutation: CanonicalMutationResult;
      readonly contract: PublisherInternalResultContract;
      readonly result: PublisherStoredResult;
    }
  | {
      readonly kind: 'replay';
      readonly binding: PublisherIdempotencyBinding;
      readonly fingerprint: string;
      readonly result: PublisherStoredResult;
      readonly contract: PublisherInternalResultContract;
    }
  | {
      readonly kind: 'in_progress';
      readonly binding: PublisherIdempotencyBinding;
      readonly fingerprint: string;
      readonly retryAfterSeconds: number;
    }
  | {
      readonly kind: 'reused';
      readonly binding: PublisherIdempotencyBinding;
      readonly fingerprint: string;
    };

/** Canonical JSON encoder for Publisher fingerprint and internal result bytes. */
export function publisherCanonicalJson(value: unknown): string {
  const encode = (input: unknown): string => {
    if (input === null) return 'null';
    if (typeof input === 'string') {
      for (let index = 0; index < input.length; index += 1) {
        const unit = input.charCodeAt(index);
        if (unit >= 0xd800 && unit <= 0xdbff) {
          const next = input.charCodeAt(index + 1);
          if (!(next >= 0xdc00 && next <= 0xdfff)) {
            throw new TypeError('publisher canonical JSON requires valid Unicode');
          }
          index += 1;
        } else if (unit >= 0xdc00 && unit <= 0xdfff) {
          throw new TypeError('publisher canonical JSON requires valid Unicode');
        }
      }
      return JSON.stringify(input);
    }
    if (typeof input === 'boolean') return JSON.stringify(input);
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) {
        throw new TypeError('publisher canonical JSON does not allow non-finite numbers');
      }
      if (Number.isInteger(input) && !Number.isSafeInteger(input)) {
        throw new TypeError('publisher canonical JSON requires safe integers');
      }
      return JSON.stringify(input);
    }
    if (Array.isArray(input)) return `[${input.map(encode).join(',')}]`;
    if (typeof input === 'object') {
      const entries = Object.entries(input as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([key, item]) => `${encode(key)}:${encode(item)}`).join(',')}}`;
    }
    throw new TypeError('publisher canonical JSON does not allow this value');
  };
  return encode(value);
}

/**
 * Fingerprint dimensions (P1-11): publisher namespace, principal,
 * resource identity, and payload.
 */
export function publisherMutationFingerprint(request: {
  readonly namespace: string;
  readonly principalId: string;
  readonly principalType?: typeof PUBLISHER_PRINCIPAL_TYPE;
  readonly resource: {
    readonly collectionId: string;
    readonly resourceId: string;
    readonly resourceKind: string;
  };
  readonly payload: unknown;
}): string {
  const canonical = publisherCanonicalJson({
    namespace: request.namespace,
    principalId: request.principalId,
    principalType: request.principalType ?? PUBLISHER_PRINCIPAL_TYPE,
    resource: {
      collectionId: request.resource.collectionId,
      resourceId: request.resource.resourceId,
      resourceKind: request.resource.resourceKind,
    },
    payload: request.payload ?? null,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function projectPublisherInternalResult(
  mutationResult: CanonicalMutationResult,
): PublisherInternalResultContract {
  const allocation = mutationResult.allocation;
  return {
    schemaVersion: PUBLISHER_INTERNAL_RESULT_SCHEMA_VERSION,
    mediaType: PUBLISHER_INTERNAL_RESULT_MEDIA_TYPE,
    outcome: 'applied',
    operationId: mutationResult.operationId,
    collectionId: mutationResult.collectionId,
    resourceId: mutationResult.resourceId,
    action: mutationResult.action,
    allocation: {
      commitOrdinal: allocation.commitOrdinal.toString(),
      ...(allocation.resourceRevision
        ? { resourceRevision: allocation.resourceRevision }
        : {}),
      ...(allocation.contentRevision
        ? { contentRevision: allocation.contentRevision }
        : {}),
      ...(allocation.policyRevision
        ? { policyRevision: allocation.policyRevision }
        : {}),
      childrenRevisions: { ...allocation.childrenRevisions },
      ...(allocation.positionToken ? { positionToken: allocation.positionToken } : {}),
    },
  };
}

function encodeInternalResult(
  contract: PublisherInternalResultContract,
): PublisherStoredResult {
  const body = Buffer.from(publisherCanonicalJson(contract), 'utf8');
  return {
    status: 200,
    body,
    stableHeaders: {
      'content-type': PUBLISHER_INTERNAL_RESULT_MEDIA_TYPE,
      'cache-control': 'private, no-store',
    },
    mediaType: PUBLISHER_INTERNAL_RESULT_MEDIA_TYPE,
    contractVersion: PUBLISHER_INTERNAL_RESULT_SCHEMA_VERSION,
    targetIdentity: `${contract.action}:${contract.collectionId}/${contract.resourceId}`,
  };
}

function decodeInternalResult(body: Uint8Array): PublisherInternalResultContract {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body).toString('utf8')) as unknown;
  } catch {
    throw new Error('publisher internal result bytes are not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('publisher internal result must be a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== PUBLISHER_INTERNAL_RESULT_SCHEMA_VERSION) {
    throw new Error('publisher internal result schemaVersion is unsupported');
  }
  if (record.outcome !== 'applied') {
    throw new Error('publisher internal result outcome is unsupported');
  }
  for (const key of ['operationId', 'collectionId', 'resourceId', 'action'] as const) {
    if (typeof record[key] !== 'string' || (record[key] as string).length === 0) {
      throw new Error(`publisher internal result.${key} is required`);
    }
  }
  const allocation = record.allocation;
  if (!allocation || typeof allocation !== 'object' || Array.isArray(allocation)) {
    throw new Error('publisher internal result.allocation is required');
  }
  const alloc = allocation as Record<string, unknown>;
  if (typeof alloc.commitOrdinal !== 'string') {
    throw new Error('publisher internal result.allocation.commitOrdinal is required');
  }
  if (
    !alloc.childrenRevisions
    || typeof alloc.childrenRevisions !== 'object'
    || Array.isArray(alloc.childrenRevisions)
  ) {
    throw new Error('publisher internal result.allocation.childrenRevisions is required');
  }
  return {
    schemaVersion: PUBLISHER_INTERNAL_RESULT_SCHEMA_VERSION,
    mediaType: PUBLISHER_INTERNAL_RESULT_MEDIA_TYPE,
    outcome: 'applied',
    operationId: record.operationId as string,
    collectionId: record.collectionId as string,
    resourceId: record.resourceId as string,
    action: record.action as string,
    allocation: {
      commitOrdinal: alloc.commitOrdinal as string,
      ...(typeof alloc.resourceRevision === 'string'
        ? { resourceRevision: alloc.resourceRevision }
        : {}),
      ...(typeof alloc.contentRevision === 'string'
        ? { contentRevision: alloc.contentRevision }
        : {}),
      ...(typeof alloc.policyRevision === 'string'
        ? { policyRevision: alloc.policyRevision }
        : {}),
      childrenRevisions: alloc.childrenRevisions as Readonly<Record<string, string>>,
      ...(typeof alloc.positionToken === 'string'
        ? { positionToken: alloc.positionToken }
        : {}),
    },
  };
}

function generatePublisherOperationId(): string {
  return randomBytes(16).toString('base64url');
}

function toResourceMutation(
  collectionId: string,
  mutation: ExecutePublisherCanonicalMutationInput['mutation'],
): CanonicalResourceMutation {
  if (mutation.target.collectionId !== collectionId) {
    throw new Error('publisher mutation target.collectionId must match collectionId');
  }
  return {
    action: mutation.action,
    target: mutation.target,
    parentId: mutation.parentId,
    ...(mutation.relativePosition ? { relativePosition: mutation.relativePosition } : {}),
    ...(mutation.fields ? { fields: mutation.fields } : {}),
    ...(mutation.expectedResourceRevision
      ? { expectedResourceRevision: mutation.expectedResourceRevision }
      : {}),
  };
}

/**
 * Publisher admission + shared Canonical Mutation Application (P1-11).
 *
 * Flow (single surrounding transaction):
 * 1. claim publisher_idempotency namespace
 * 2. run createCanonicalMutationApplication path (field authority, lock, plan, …)
 * 3. complete exact internal result contract for replay
 *
 * Same binding + fingerprint → exact replay; different fingerprint → reused.
 * Product command receipts and Product transport are never touched.
 */
export async function executePublisherCanonicalMutation<Transaction>(
  ports: PublisherCanonicalMutationHarnessPorts<Transaction>,
  context: TransactionContext<Transaction>,
  input: ExecutePublisherCanonicalMutationInput,
): Promise<ExecutePublisherCanonicalMutationResult> {
  if (!input?.binding) throw new Error('publisher binding is required');
  if (!input.collectionId?.trim()) throw new Error('publisher collectionId is required');
  if (!input.mutation?.target) throw new Error('publisher mutation.target is required');

  const binding: PublisherIdempotencyBinding = {
    namespace: input.binding.namespace,
    principalId: input.binding.principalId,
    idempotencyKey: input.binding.idempotencyKey,
  };

  const fingerprint = input.fingerprint?.trim()
    ? input.fingerprint
    : publisherMutationFingerprint({
      namespace: binding.namespace,
      principalId: binding.principalId,
      principalType: PUBLISHER_PRINCIPAL_TYPE,
      resource: {
        collectionId: input.mutation.target.collectionId,
        resourceId: input.mutation.target.resourceId,
        resourceKind: input.mutation.target.resourceKind,
      },
      payload: input.payload,
    });

  // Operation ID is owned by this Publisher admission layer (not Product).
  const operationId = input.operationId?.trim()
    ? input.operationId
    : generatePublisherOperationId();

  const resourceMutation = toResourceMutation(input.collectionId, input.mutation);
  let appliedMutation: CanonicalMutationResult | undefined;
  let appliedContract: PublisherInternalResultContract | undefined;

  const outcome = await admitPublisherMutation(ports.publisherIdempotency, {
    binding,
    fingerprint,
    execute: async () => {
      appliedMutation = await ports.canonical.execute(context, {
        operationId,
        collectionId: input.collectionId,
        actor: {
          principalId: binding.principalId,
          principalType: PUBLISHER_PRINCIPAL_TYPE,
        },
        mutation: resourceMutation,
      });
      appliedContract = projectPublisherInternalResult(appliedMutation);
      return encodeInternalResult(appliedContract);
    },
  });

  if (outcome.kind === 'in_progress') {
    return {
      kind: 'in_progress',
      binding,
      fingerprint,
      retryAfterSeconds: outcome.retryAfterSeconds,
    };
  }
  if (outcome.kind === 'reused') {
    return { kind: 'reused', binding, fingerprint };
  }
  if (outcome.kind === 'replay') {
    return {
      kind: 'replay',
      binding,
      fingerprint,
      result: outcome.result,
      contract: decodeInternalResult(outcome.result.body),
    };
  }

  if (!appliedMutation || !appliedContract) {
    throw new Error('publisher canonical mutation completed without a mutation result');
  }

  return {
    kind: 'executed',
    operationId: appliedMutation.operationId,
    binding,
    fingerprint,
    mutation: appliedMutation,
    contract: appliedContract,
    result: outcome.result,
  };
}

/** @deprecated Use executePublisherCanonicalMutation. */
export const executePublisherCanonicalMutationHarness = executePublisherCanonicalMutation;

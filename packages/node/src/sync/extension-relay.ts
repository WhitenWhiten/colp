import {
  preserveExtensionCarrier,
  preserveExtensions,
  type ExtensionCarrier,
  type ExtensionMap,
  type ExtensionRemovalAudit,
  type ExtensionSecurityPolicy,
} from '../schema/extensions.js';
import {
  assertNonEmpty,
  assertPlainDataObject,
  requirePromise,
} from './internal-guards.js';

export interface SyncExtensionResourceKey {
  readonly resourceType: string;
  readonly resourceId: string;
}

export interface StoredSyncExtensionCarrier extends SyncExtensionResourceKey {
  readonly revision: string;
  readonly extensions?: ExtensionMap;
}

export type SyncExtensionReplacement =
  | { readonly kind: 'replace'; readonly extensions: ExtensionMap }
  | { readonly kind: 'delete' };

export interface SyncExtensionStoreWrite {
  readonly key: SyncExtensionResourceKey;
  readonly expectedRevision: string | null;
  readonly revision: string;
  readonly replacement: SyncExtensionReplacement;
}

export type SyncExtensionStoreWriteResult =
  | { readonly state: 'stored'; readonly carrier: StoredSyncExtensionCarrier }
  | { readonly state: 'conflict'; readonly current?: StoredSyncExtensionCarrier | undefined };

export interface SyncExtensionStore {
  load(key: SyncExtensionResourceKey): Promise<StoredSyncExtensionCarrier | undefined>;
  compareAndSet(write: SyncExtensionStoreWrite): Promise<SyncExtensionStoreWriteResult>;
}

export interface SyncExtensionRelayRequest {
  readonly operationId: string;
  readonly replicaId: string;
  readonly sequenceScope: string;
  readonly sequence: number;
  readonly digest: string;
  readonly key: SyncExtensionResourceKey;
  readonly expectedRevision: string | null;
  readonly revision: string;
  readonly replacement: SyncExtensionReplacement;
}

export type SyncExtensionRelayResult =
  | {
      readonly state: 'committed' | 'replayed';
      readonly carrier: StoredSyncExtensionCarrier;
      /** Persisted privately with a receipt; omitted from coordinator return values. */
      readonly digest?: string;
    }
  | { readonly state: 'receipt_conflict'; readonly digest?: string }
  | { readonly state: 'revision_conflict'; readonly currentRevision: string | null; readonly digest?: string };

export interface SyncExtensionReceiptStore {
  /**
   * Adapter uniqueness binds operationId, replicaId, sequenceScope, and sequence.
   * The persisted result's digest distinguishes exact replay from key/Sequence reuse.
   */
  load(request: SyncExtensionRelayRequest): Promise<SyncExtensionRelayResult | undefined>;
  save(request: SyncExtensionRelayRequest, result: SyncExtensionRelayResult): Promise<void>;
}

export interface SyncExtensionTransaction {
  readonly extensions: SyncExtensionStore;
  readonly receipts: SyncExtensionReceiptStore;
}

export interface SyncExtensionUnitOfWork {
  /** Resolve only after commit is known; reject on rollback or uncertain commit outcome. */
  execute<Result>(work: (transaction: SyncExtensionTransaction) => Promise<Result>): Promise<Result>;
}

function immutableResourceKey(key: SyncExtensionResourceKey): SyncExtensionResourceKey {
  if (typeof key !== 'object' || key === null) throw new TypeError('Extension resource key must be an object.');
  assertPlainDataObject(key, new Set(['resourceType', 'resourceId']), 'Extension resource key');
  assertNonEmpty(key.resourceType, 'Extension resourceType');
  assertNonEmpty(key.resourceId, 'Extension resourceId');
  return Object.freeze({ resourceType: key.resourceType, resourceId: key.resourceId });
}

function sameResourceKey(left: SyncExtensionResourceKey, right: SyncExtensionResourceKey): boolean {
  return left.resourceType === right.resourceType && left.resourceId === right.resourceId;
}

function immutableResourceCarrier(
  candidate: StoredSyncExtensionCarrier,
  expectedKey?: SyncExtensionResourceKey,
  expectedRevision?: string,
): StoredSyncExtensionCarrier {
  if (typeof candidate !== 'object' || candidate === null) {
    throw new TypeError('Stored extension carrier must be an object.');
  }
  assertPlainDataObject(
    candidate,
    new Set(['resourceType', 'resourceId', 'revision', 'extensions']),
    'Stored extension carrier',
  );
  const key = immutableResourceKey({
    resourceType: candidate.resourceType,
    resourceId: candidate.resourceId,
  });
  assertNonEmpty(candidate.revision, 'Extension carrier revision');
  if (expectedKey !== undefined && !sameResourceKey(key, expectedKey)) {
    throw new TypeError('Extension store returned a mismatched resource key.');
  }
  if (expectedRevision !== undefined && candidate.revision !== expectedRevision) {
    throw new TypeError('Extension store returned a mismatched revision.');
  }
  const descriptor = Object.getOwnPropertyDescriptor(candidate, 'extensions');
  if (descriptor === undefined) return Object.freeze({ ...key, revision: candidate.revision });
  if (!descriptor.enumerable || !('value' in descriptor)) {
    throw new TypeError('Stored extensions must be an enumerable data property.');
  }
  const preserved = preserveExtensions(descriptor.value as ExtensionMap, { surface: 'sync-server' });
  return Object.freeze({ ...key, revision: candidate.revision, extensions: preserved.extensions });
}

function mutableResourceCarrier(carrier: StoredSyncExtensionCarrier): StoredSyncExtensionCarrier {
  return structuredClone(carrier) as StoredSyncExtensionCarrier;
}

function equalResourceCarrier(
  left: StoredSyncExtensionCarrier,
  right: StoredSyncExtensionCarrier,
): boolean {
  if (!sameResourceKey(left, right) || left.revision !== right.revision) return false;
  const leftHasExtensions = Object.hasOwn(left, 'extensions');
  const rightHasExtensions = Object.hasOwn(right, 'extensions');
  return leftHasExtensions === rightHasExtensions
    && (!leftHasExtensions || equalJson(left.extensions, right.extensions));
}

function equalJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => equalJson(value, right[index]));
  }
  const leftRecord = left as Readonly<Record<string, unknown>>;
  const rightRecord = right as Readonly<Record<string, unknown>>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && equalJson(leftRecord[key], rightRecord[key]));
}

export interface SyncExtensionTransformationOptions {
  /** Downstream projection only. Canonical Sync storage never accepts this policy. */
  readonly extensionSecurityPolicy?: ExtensionSecurityPolicy;
  /** JSON Pointer to the protocol object being transformed, for removal audits. */
  readonly extensionCarrierPath?: string;
}

export interface SyncExtensionLoadOptions extends SyncExtensionTransformationOptions {}

export type ProjectedSyncExtensionCarrier = StoredSyncExtensionCarrier & {
  readonly extensionRemovals: readonly ExtensionRemovalAudit[];
};

/** Strict detached read boundary used by Sync replay, pull, and Snapshot assembly. */
export function loadSyncExtensionCarrier(
  store: SyncExtensionStore,
  candidateKey: SyncExtensionResourceKey,
): Promise<StoredSyncExtensionCarrier | undefined>;
export function loadSyncExtensionCarrier(
  store: SyncExtensionStore,
  candidateKey: SyncExtensionResourceKey,
  options: SyncExtensionLoadOptions & { readonly extensionSecurityPolicy: ExtensionSecurityPolicy },
): Promise<ProjectedSyncExtensionCarrier | undefined>;
export function loadSyncExtensionCarrier(
  store: SyncExtensionStore,
  candidateKey: SyncExtensionResourceKey,
  options: SyncExtensionLoadOptions,
): Promise<StoredSyncExtensionCarrier | ProjectedSyncExtensionCarrier | undefined>;
export async function loadSyncExtensionCarrier(
  store: SyncExtensionStore,
  candidateKey: SyncExtensionResourceKey,
  options?: SyncExtensionLoadOptions,
): Promise<StoredSyncExtensionCarrier | ProjectedSyncExtensionCarrier | undefined> {
  const key = immutableResourceKey(candidateKey);
  const raw = await requirePromise(store.load(key), 'Sync extension load');
  if (raw === undefined) return undefined;
  const carrier = immutableResourceCarrier(raw, key);
  if (options?.extensionSecurityPolicy === undefined) return carrier;

  const projected = preserveExtensionCarrier(carrier, {
    resourceType: carrier.resourceType,
    resourceId: carrier.resourceId,
    revision: carrier.revision,
  }, {
    surface: 'sync-server',
    ...(options.extensionCarrierPath === undefined ? {} : { path: options.extensionCarrierPath }),
    securityPolicy: options.extensionSecurityPolicy,
  });
  const removals = Object.freeze(projected.removals.map((removal) => Object.freeze({ ...removal })));
  return Object.freeze({ ...projected.value, extensionRemovals: removals });
}

function immutableRelayRequest(request: SyncExtensionRelayRequest): SyncExtensionRelayRequest {
  if (typeof request !== 'object' || request === null) {
    throw new TypeError('Sync extension relay request must be an object.');
  }
  assertPlainDataObject(
    request,
    new Set([
      'operationId', 'replicaId', 'sequenceScope', 'sequence', 'digest', 'key',
      'expectedRevision', 'revision', 'replacement',
    ]),
    'Sync extension relay request',
  );
  assertNonEmpty(request.operationId, 'Sync operationId');
  assertNonEmpty(request.replicaId, 'Sync replicaId');
  assertNonEmpty(request.sequenceScope, 'Sync sequenceScope');
  assertNonEmpty(request.digest, 'Sync request digest');
  assertNonEmpty(request.revision, 'Sync extension revision');
  if (!Number.isSafeInteger(request.sequence) || request.sequence < 1) {
    throw new RangeError('Sync Sequence must be a positive safe integer.');
  }
  if (request.expectedRevision !== null) {
    assertNonEmpty(request.expectedRevision, 'Expected Sync extension revision');
    if (request.expectedRevision === request.revision) {
      throw new TypeError('A replacement revision must differ from its expected revision.');
    }
  }
  const key = immutableResourceKey(request.key);
  if (typeof request.replacement !== 'object' || request.replacement === null) {
    throw new TypeError('Sync extension replacement must be an object.');
  }
  let replacement: SyncExtensionReplacement;
  if (request.replacement.kind === 'replace') {
    assertPlainDataObject(
      request.replacement,
      new Set(['kind', 'extensions']),
      'Sync extension replacement',
    );
    replacement = Object.freeze({
      kind: 'replace' as const,
      extensions: preserveExtensions(request.replacement.extensions, { surface: 'sync-server' }).extensions,
    });
  } else if (request.replacement.kind === 'delete') {
    assertPlainDataObject(request.replacement, new Set(['kind']), 'Sync extension replacement');
    replacement = Object.freeze({ kind: 'delete' as const });
  } else {
    throw new TypeError('Unknown Sync extension replacement kind.');
  }
  return Object.freeze({
    operationId: request.operationId,
    replicaId: request.replicaId,
    sequenceScope: request.sequenceScope,
    sequence: request.sequence,
    digest: request.digest,
    key,
    expectedRevision: request.expectedRevision,
    revision: request.revision,
    replacement,
  });
}

type PersistedSyncExtensionReceipt =
  | {
      readonly state: 'committed';
      readonly carrier: StoredSyncExtensionCarrier;
      readonly digest: string;
    }
  | {
      readonly state: 'revision_conflict';
      readonly currentRevision: string | null;
      readonly digest: string;
    };

function immutableStoredReceipt(
  candidate: SyncExtensionRelayResult,
  request: SyncExtensionRelayRequest,
  expectedCarrier: StoredSyncExtensionCarrier,
): PersistedSyncExtensionReceipt {
  if (typeof candidate !== 'object' || candidate === null) {
    throw new TypeError('Stored Sync extension receipt must be an object.');
  }
  assertPlainDataObject(
    candidate,
    new Set(['state', 'carrier', 'currentRevision', 'digest']),
    'Stored Sync extension receipt',
  );
  if (candidate.state === 'committed') {
    assertPlainDataObject(candidate, new Set(['state', 'carrier', 'digest']), 'Stored Sync extension receipt');
    const digest = candidate.digest;
    assertNonEmpty(digest, 'Stored Sync extension receipt digest');
    const sameDigest = digest === request.digest;
    const carrier = immutableResourceCarrier(
      candidate.carrier,
      request.key,
      sameDigest ? request.revision : undefined,
    );
    if (sameDigest && !equalResourceCarrier(carrier, expectedCarrier)) {
      throw new TypeError('Stored Sync extension receipt differs from the requested replacement.');
    }
    return Object.freeze({ state: 'committed', carrier, digest });
  }
  if (candidate.state === 'revision_conflict') {
    assertPlainDataObject(
      candidate,
      new Set(['state', 'currentRevision', 'digest']),
      'Stored Sync extension receipt',
    );
    const digest = candidate.digest;
    assertNonEmpty(digest, 'Stored Sync extension receipt digest');
    if (candidate.currentRevision !== null) {
      assertNonEmpty(candidate.currentRevision, 'Stored Sync extension conflict revision');
    }
    return Object.freeze({
      state: 'revision_conflict',
      currentRevision: candidate.currentRevision,
      digest,
    });
  }
  throw new TypeError('Stored Sync extension receipt has an invalid result state.');
}

function equalRelayResult(left: SyncExtensionRelayResult, right: SyncExtensionRelayResult): boolean {
  if (left.state !== right.state) return false;
  if (left.state === 'receipt_conflict') return true;
  if (left.state === 'revision_conflict') {
    return right.state === 'revision_conflict' && left.currentRevision === right.currentRevision;
  }
  return (right.state === 'committed' || right.state === 'replayed')
    && equalResourceCarrier(left.carrier, right.carrier);
}

async function saveAndVerifyReceipt(
  transaction: SyncExtensionTransaction,
  request: SyncExtensionRelayRequest,
  result: SyncExtensionRelayResult,
  expectedCarrier: StoredSyncExtensionCarrier,
): Promise<void> {
  await requirePromise(
    transaction.receipts.save(request, structuredClone(result) as SyncExtensionRelayResult),
    'Sync extension receipt save',
  );
  const reloaded = await requirePromise(
    transaction.receipts.load(request),
    'Sync extension transaction-local receipt read-back',
  );
  if (reloaded === undefined) {
    throw new TypeError('Stored Sync extension receipt could not be reloaded before commit.');
  }
  const verified = immutableStoredReceipt(reloaded, request, expectedCarrier);
  if (verified.digest !== request.digest || !equalRelayResult(verified, result)) {
    throw new TypeError('Stored Sync extension receipt failed transaction-local read-back verification.');
  }
}

function returnedRelayResult(result: SyncExtensionRelayResult): SyncExtensionRelayResult {
  if (result.state === 'receipt_conflict') return Object.freeze({ state: 'receipt_conflict' });
  if (result.state === 'revision_conflict') {
    return Object.freeze({ state: 'revision_conflict', currentRevision: result.currentRevision });
  }
  return Object.freeze({
    state: result.state,
    carrier: immutableResourceCarrier(result.carrier),
  });
}

/**
 * Atomically CAS-replaces one complete canonical extension map and saves its replay
 * receipt. No success result escapes until the UnitOfWork confirms commit.
 */
export async function relaySyncExtensionCarrier(
  unitOfWork: SyncExtensionUnitOfWork,
  candidateRequest: SyncExtensionRelayRequest,
): Promise<SyncExtensionRelayResult> {
  const request = immutableRelayRequest(candidateRequest);
  const expectedCarrier = immutableResourceCarrier({
    ...request.key,
    revision: request.revision,
    ...(request.replacement.kind === 'replace'
      ? { extensions: request.replacement.extensions }
      : {}),
  });
  let callbackInvocations = 0;
  let callbackOutcome: SyncExtensionRelayResult | undefined;
  const outcome = await requirePromise(unitOfWork.execute(async (transaction) => {
    callbackInvocations += 1;
    if (callbackInvocations !== 1) {
      throw new TypeError('Sync extension UnitOfWork must invoke its callback exactly once.');
    }
    const receipt = await requirePromise(transaction.receipts.load(request), 'Sync extension receipt load');
    if (receipt !== undefined) {
      const storedReceipt = immutableStoredReceipt(receipt, request, expectedCarrier);
      if (storedReceipt.digest !== request.digest) {
        callbackOutcome = Object.freeze({ state: 'receipt_conflict' as const });
        return callbackOutcome;
      }
      if (storedReceipt.state === 'committed') {
        callbackOutcome = Object.freeze({ state: 'replayed' as const, carrier: storedReceipt.carrier });
        return callbackOutcome;
      }
      callbackOutcome = Object.freeze({
        state: 'revision_conflict' as const,
        currentRevision: storedReceipt.currentRevision,
      });
      return callbackOutcome;
    }

    const currentBeforeWriteRaw = await requirePromise(
      transaction.extensions.load(request.key),
      'Sync extension transaction-local revision load',
    );
    const currentBeforeWrite = currentBeforeWriteRaw === undefined
      ? undefined
      : immutableResourceCarrier(currentBeforeWriteRaw, request.key);
    const currentRevision = currentBeforeWrite?.revision ?? null;
    if (currentRevision !== request.expectedRevision) {
      const result: SyncExtensionRelayResult = {
        state: 'revision_conflict',
        currentRevision,
        digest: request.digest,
      };
      await saveAndVerifyReceipt(transaction, request, result, expectedCarrier);
      callbackOutcome = returnedRelayResult(result);
      return callbackOutcome;
    }

    const write: SyncExtensionStoreWrite = {
      key: { ...request.key },
      expectedRevision: request.expectedRevision,
      revision: request.revision,
      replacement: request.replacement.kind === 'replace'
        ? { kind: 'replace', extensions: structuredClone(request.replacement.extensions) as ExtensionMap }
        : { kind: 'delete' },
    };
    const writeResult = await requirePromise(
      transaction.extensions.compareAndSet(write),
      'Sync extension compare-and-set',
    );
    if (typeof writeResult !== 'object' || writeResult === null) {
      throw new TypeError('Sync extension store returned an invalid compare-and-set result.');
    }
    assertPlainDataObject(
      writeResult,
      new Set(['state', 'carrier', 'current']),
      'Sync extension compare-and-set result',
    );
    if (writeResult.state === 'conflict') {
      assertPlainDataObject(
        writeResult,
        new Set(['state', 'current']),
        'Sync extension compare-and-set result',
      );
      const current = writeResult.current === undefined
        ? undefined
        : immutableResourceCarrier(writeResult.current, request.key);
      const result: SyncExtensionRelayResult = {
        state: 'revision_conflict',
        currentRevision: current?.revision ?? null,
        digest: request.digest,
      };
      await saveAndVerifyReceipt(transaction, request, result, expectedCarrier);
      callbackOutcome = returnedRelayResult(result);
      return callbackOutcome;
    }
    if (writeResult.state !== 'stored') {
      throw new TypeError('Sync extension store returned an invalid compare-and-set result.');
    }
    assertPlainDataObject(
      writeResult,
      new Set(['state', 'carrier']),
      'Sync extension compare-and-set result',
    );
    const stored = immutableResourceCarrier(writeResult.carrier, request.key, request.revision);
    if (!equalResourceCarrier(stored, expectedCarrier)) {
      throw new TypeError('Sync extension store returned data that differs from the requested replacement.');
    }
    const reloadedRaw = await requirePromise(
      transaction.extensions.load(request.key),
      'Sync extension transaction-local read-back',
    );
    if (reloadedRaw === undefined) {
      throw new TypeError('Stored Sync extension carrier could not be reloaded before receipt persistence.');
    }
    const reloaded = immutableResourceCarrier(reloadedRaw, request.key, request.revision);
    if (!equalResourceCarrier(reloaded, expectedCarrier)) {
      throw new TypeError('Stored Sync extension carrier failed transaction-local read-back verification.');
    }
    const receiptResult: SyncExtensionRelayResult = {
      state: 'committed',
      carrier: mutableResourceCarrier(reloaded),
      digest: request.digest,
    };
    await saveAndVerifyReceipt(transaction, request, receiptResult, expectedCarrier);
    callbackOutcome = Object.freeze({ state: 'committed' as const, carrier: reloaded });
    return callbackOutcome;
  }), 'Sync extension UnitOfWork execute');
  if (callbackInvocations !== 1 || callbackOutcome === undefined || !equalRelayResult(outcome, callbackOutcome)) {
    throw new TypeError('Sync extension UnitOfWork returned a result other than its transaction callback result.');
  }
  return returnedRelayResult(outcome);
}

/** Contract for any Sync-server normalization or relay that touches extension carriers. */
export interface SyncExtensionTransformation<Value> {
  readonly value: Value;
  /** Empty unless extensionSecurityPolicy made an explicit removal decision. */
  readonly extensionRemovals: readonly ExtensionRemovalAudit[];
}

/** Applies preservation or an explicitly audited downstream projection after canonical load. */
export function transformSyncExtensionCarrier<
  Source extends ExtensionCarrier,
  Target extends object,
>(
  source: Source,
  target: Target,
  options: SyncExtensionTransformationOptions = {},
): SyncExtensionTransformation<Target & ExtensionCarrier> {
  const result = preserveExtensionCarrier(source, target, {
    surface: 'sync-server',
    ...(options.extensionCarrierPath === undefined ? {} : { path: options.extensionCarrierPath }),
    ...(options.extensionSecurityPolicy === undefined
      ? {}
      : { securityPolicy: options.extensionSecurityPolicy }),
  });
  return { value: result.value, extensionRemovals: result.removals };
}

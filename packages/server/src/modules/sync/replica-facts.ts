export type ReplicaKind = 'browser_extension' | 'desktop_client' | 'mobile_client'
  | 'server' | 'importer' | 'other';
export type ReplicaMountMode = 'whole-profile' | 'mounted-folder';
export type ReplicaAnnotationCapability = 'native' | 'sidecar' | 'none';
export type ReplicaStatus = 'active' | 'expired' | 'recovery_required' | 'retired';

export interface ReplicaAdapterFacts {
  readonly profile: string;
  readonly version: string;
}

export interface ReplicaCapabilities {
  readonly read: boolean;
  readonly write: boolean;
  readonly events: boolean;
  readonly separator: boolean;
  readonly alias: boolean;
  readonly annotations: ReplicaAnnotationCapability;
  readonly maxBatchOperations: number;
}

export interface ReplicaBindingFacts {
  readonly browserProfileId: string;
  readonly mountMode: ReplicaMountMode;
  readonly browserGeneration: string;
}

export interface ReplicaCreateTrustedActor {
  readonly actorAccountId: string;
}

export interface ReplicaCreateInput {
  readonly accountId: string;
  readonly collectionId: string;
  readonly deviceId?: string;
  readonly deviceName: string;
  readonly replicaName: string;
  readonly kind: ReplicaKind;
  readonly adapter: ReplicaAdapterFacts;
  readonly capabilities: ReplicaCapabilities;
  readonly binding: ReplicaBindingFacts;
  readonly leaseDurationSeconds: number;
}

export interface ReplicaCheckpointFacts {
  readonly acknowledgedCursor: string | null;
  readonly acknowledgedCommitOrdinal: string | null;
}

export interface ReplicaWireFacts {
  readonly replicaId: string;
  readonly deviceId: string;
  readonly accountId: string;
  readonly collectionId: string;
  readonly replicaName: string;
  readonly kind: ReplicaKind;
  readonly leaseId: string;
  readonly leaseGeneration: string;
  readonly adapter: ReplicaAdapterFacts;
  readonly capabilities: ReplicaCapabilities;
  readonly binding: ReplicaBindingFacts;
  readonly checkpoint: ReplicaCheckpointFacts;
  readonly status: ReplicaStatus;
}

export interface ReplicaRecord extends ReplicaWireFacts {
  readonly deviceName: string;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly leaseExpiresAt: Date;
  readonly retiredAt: Date | null;
  readonly leaseValid: boolean;
  /** Internal optimistic fence; it is not part of the COLP wire payload. */
  readonly lifecycleRevision: string;
}

export class ReplicaFactsValidationError extends TypeError {
  readonly code = 'invalid_replica_facts' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ReplicaFactsValidationError';
  }
}

const INPUT_KEYS = new Set([
  'accountId', 'collectionId', 'deviceId', 'deviceName', 'replicaName', 'kind',
  'adapter', 'capabilities', 'binding', 'leaseDurationSeconds',
]);
const ADAPTER_KEYS = new Set(['profile', 'version']);
const CAPABILITY_KEYS = new Set([
  'read', 'write', 'events', 'separator', 'alias', 'annotations', 'maxBatchOperations',
]);
const BINDING_KEYS = new Set(['browserProfileId', 'mountMode', 'browserGeneration']);
const KINDS = new Set<unknown>([
  'browser_extension', 'desktop_client', 'mobile_client', 'server', 'importer', 'other',
]);
const ANNOTATIONS = new Set<unknown>(['native', 'sidecar', 'none']);
const MOUNT_MODES = new Set<unknown>(['whole-profile', 'mounted-folder']);
const OPAQUE_ID = /^[A-Za-z0-9._~-]{1,128}$/;

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ReplicaFactsValidationError(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) throw new ReplicaFactsValidationError(`${label} contains an unknown field`);
  }
  for (const key of keys) {
    if (key === 'deviceId') continue;
    if (!Object.hasOwn(value, key)) throw new ReplicaFactsValidationError(`${label} is incomplete`);
  }
}

function text(value: unknown, label: string, opaque = false): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512
      || (opaque && !OPAQUE_ID.test(value))) {
    throw new ReplicaFactsValidationError(`${label} is invalid`);
  }
  return value;
}

function adapter(value: unknown): ReplicaAdapterFacts {
  const candidate = plainRecord(value, 'Replica adapter');
  exactKeys(candidate, ADAPTER_KEYS, 'Replica adapter');
  return Object.freeze({
    profile: text(candidate.profile, 'Replica adapter profile'),
    version: text(candidate.version, 'Replica adapter version'),
  });
}

export function validateReplicaCapabilities(value: unknown): ReplicaCapabilities {
  const candidate = plainRecord(value, 'Replica capabilities');
  exactKeys(candidate, CAPABILITY_KEYS, 'Replica capabilities');
  for (const field of ['read', 'write', 'events', 'separator', 'alias'] as const) {
    if (typeof candidate[field] !== 'boolean') {
      throw new ReplicaFactsValidationError(`Replica capability ${field} must be boolean`);
    }
  }
  if (!ANNOTATIONS.has(candidate.annotations)) {
    throw new ReplicaFactsValidationError('Replica annotation capability is invalid');
  }
  if (!Number.isSafeInteger(candidate.maxBatchOperations)
      || (candidate.maxBatchOperations as number) < 1
      || (candidate.maxBatchOperations as number) > 10_000) {
    throw new ReplicaFactsValidationError('Replica maxBatchOperations is invalid');
  }
  return Object.freeze({
    read: candidate.read as boolean,
    write: candidate.write as boolean,
    events: candidate.events as boolean,
    separator: candidate.separator as boolean,
    alias: candidate.alias as boolean,
    annotations: candidate.annotations as ReplicaAnnotationCapability,
    maxBatchOperations: candidate.maxBatchOperations as number,
  });
}

export function validateReplicaBindingFacts(value: unknown): ReplicaBindingFacts {
  const candidate = plainRecord(value, 'Replica binding');
  exactKeys(candidate, BINDING_KEYS, 'Replica binding');
  if (!MOUNT_MODES.has(candidate.mountMode)) {
    throw new ReplicaFactsValidationError('Replica mount mode is invalid');
  }
  return Object.freeze({
    browserProfileId: text(candidate.browserProfileId, 'Replica browser profile ID', true),
    mountMode: candidate.mountMode as ReplicaMountMode,
    browserGeneration: text(candidate.browserGeneration, 'Replica browser generation', true),
  });
}

export function validateProtocolSafeReplicaId(value: unknown, label: string): string {
  return text(value, label, true);
}

export function assertReplicaCreateActor(
  accountId: string,
  actorAccountId: string,
): void {
  if (actorAccountId !== accountId) {
    throw new ReplicaFactsValidationError('Replica create actor does not match account');
  }
}

export function validateReplicaCreateInput(
  value: unknown,
  trusted: ReplicaCreateTrustedActor,
): ReplicaCreateInput {
  const candidate = plainRecord(value, 'Replica create input');
  exactKeys(candidate, INPUT_KEYS, 'Replica create input');
  if (!KINDS.has(candidate.kind)) throw new ReplicaFactsValidationError('Replica kind is invalid');
  if (!Number.isSafeInteger(candidate.leaseDurationSeconds)
      || (candidate.leaseDurationSeconds as number) < 1
      || (candidate.leaseDurationSeconds as number) > 2_592_000) {
    throw new ReplicaFactsValidationError('Replica lease duration is invalid');
  }
  const actor = plainRecord(trusted, 'Replica create actor');
  const actorAccountId = text(actor.actorAccountId, 'Replica create actor');
  const deviceId = candidate.deviceId === undefined
    ? undefined : text(candidate.deviceId, 'Device ID', true);
  const accountId = text(candidate.accountId, 'Account ID');
  assertReplicaCreateActor(accountId, actorAccountId);
  return Object.freeze({
    accountId,
    collectionId: text(candidate.collectionId, 'Collection ID'),
    ...(deviceId === undefined ? {} : { deviceId }),
    deviceName: text(candidate.deviceName, 'Device name'),
    replicaName: text(candidate.replicaName, 'Replica name'),
    kind: candidate.kind as ReplicaKind,
    adapter: adapter(candidate.adapter),
    capabilities: validateReplicaCapabilities(candidate.capabilities),
    binding: validateReplicaBindingFacts(candidate.binding),
    leaseDurationSeconds: candidate.leaseDurationSeconds as number,
  });
}

export function materializeReplicaWireFacts(facts: ReplicaWireFacts): ReplicaWireFacts {
  return Object.freeze({
    replicaId: facts.replicaId,
    deviceId: facts.deviceId,
    accountId: facts.accountId,
    collectionId: facts.collectionId,
    replicaName: facts.replicaName,
    kind: facts.kind,
    leaseId: facts.leaseId,
    leaseGeneration: facts.leaseGeneration,
    adapter: Object.freeze({ ...facts.adapter }),
    capabilities: Object.freeze({ ...facts.capabilities }),
    binding: Object.freeze({ ...facts.binding }),
    checkpoint: Object.freeze({ ...facts.checkpoint }),
    status: facts.status,
  });
}

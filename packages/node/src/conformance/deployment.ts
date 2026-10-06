import { randomUUID } from 'node:crypto';

import { profileDependencies, type ProtocolProfile } from '../semantic/index.js';
import {
  createVersionedMcpEvidenceBinding,
  isLegacyMcpConformanceProbeId,
  isMcpConformanceProbeId,
  mcpConformanceProbeFamilies,
  assertVersionedMcpEvidenceBinding,
  type McpVersionedEvidenceBinding,
} from './mcp-conformance.js';

export const deploymentConformanceProbeIds = Object.freeze([
  'core.id-ledger-persistence',
  'core.sync-extension-persistence',
  'core.pre-write-validation',
  'core.parent-cycle-transaction',
  'core.node-subtree-transaction',
  'core.managed-bookmarks-transaction',
  'core.ai-provenance-transaction',
  'core.profile-id-persistence',
  'core.profile-id-key-rotation',
  'core.secret-redaction',
  'publication.http-contracts',
  'feed.delivery-contracts',
  'publisher.transaction-contracts',
  'sync.transaction-contracts',
  ...mcpConformanceProbeFamilies,
] as const);

export type DeploymentConformanceProbeId = (typeof deploymentConformanceProbeIds)[number];

export const deploymentConformanceCapabilityIds = Object.freeze([
  'core-authoritative-writes',
  'managed-bookmark-writes',
  'sync-extension-storage',
  'ai-content-writes',
  'local-profile-id-storage',
  'server-profile-id-hmac',
] as const);

export type DeploymentConformanceCapabilityId =
  (typeof deploymentConformanceCapabilityIds)[number];

/** Profile-owned wire/transport probes. Optional deployment roles are scoped separately. */
export const profileDeploymentConformanceProbes = Object.freeze({
  core: Object.freeze([]),
  publication: Object.freeze(['publication.http-contracts']),
  feed: Object.freeze(['feed.delivery-contracts']),
  publisher: Object.freeze(['publisher.transaction-contracts']),
  sync: Object.freeze(['sync.transaction-contracts']),
  'mcp-read': Object.freeze([
    'mcp-2026-07-28.transport-header-contracts',
    'mcp-2026-07-28.discovery-contracts',
    'mcp-2026-07-28.subscription-contracts',
    'mcp-2026-07-28.read-schema-contracts',
    'mcp-2026-07-28.oauth-client-contracts',
  ]),
  'mcp-write': Object.freeze(['mcp-2026-07-28.write-mrtr-contracts']),
} as const satisfies Readonly<Record<ProtocolProfile, readonly DeploymentConformanceProbeId[]>>);

/** Optional deployment roles and the stateful guarantees each role must prove. */
export const deploymentCapabilityConformanceProbes = Object.freeze({
  'core-authoritative-writes': Object.freeze([
    'core.id-ledger-persistence',
    'core.pre-write-validation',
    'core.parent-cycle-transaction',
    'core.node-subtree-transaction',
  ]),
  'managed-bookmark-writes': Object.freeze(['core.managed-bookmarks-transaction']),
  'sync-extension-storage': Object.freeze(['core.sync-extension-persistence']),
  'ai-content-writes': Object.freeze(['core.ai-provenance-transaction']),
  'local-profile-id-storage': Object.freeze(['core.profile-id-persistence']),
  'server-profile-id-hmac': Object.freeze([
    'core.profile-id-key-rotation',
    'core.secret-redaction',
  ]),
} as const satisfies Readonly<
  Record<DeploymentConformanceCapabilityId, readonly DeploymentConformanceProbeId[]>
>);

/** Capabilities necessarily exposed by each Profile itself. Dependencies are expanded by the planner. */
export const profileDeploymentConformanceCapabilities = Object.freeze({
  core: Object.freeze([]),
  publication: Object.freeze([]),
  feed: Object.freeze([]),
  publisher: Object.freeze(['core-authoritative-writes', 'managed-bookmark-writes']),
  sync: Object.freeze([
    'core-authoritative-writes',
    'managed-bookmark-writes',
    'sync-extension-storage',
  ]),
  'mcp-read': Object.freeze([]),
  'mcp-write': Object.freeze([]),
} as const satisfies Readonly<
  Record<ProtocolProfile, readonly DeploymentConformanceCapabilityId[]>
>);

export interface DeploymentConformanceScope {
  readonly profiles: readonly ProtocolProfile[];
  readonly capabilities: readonly DeploymentConformanceCapabilityId[];
  /**
   * Source-bound facts required whenever the scope exercises any versioned
   * MCP probe family. The issued target evidence then carries the exact
   * versioned binding (version/source/SDK lock/fixture topology/digests).
   */
  readonly mcpConformance?: {
    readonly sourceRevision: string;
    readonly requirementsDigest: string;
    readonly reportDigest: string;
  };
}

export interface DeploymentConformancePlan extends DeploymentConformanceScope {
  readonly probeIds: readonly DeploymentConformanceProbeId[];
}

const deploymentConformanceProfileOrder = Object.freeze(
  Object.keys(profileDependencies) as ProtocolProfile[],
);
const knownProfiles = new Set<unknown>(deploymentConformanceProfileOrder);
const knownCapabilityIds = new Set<DeploymentConformanceCapabilityId>(
  deploymentConformanceCapabilityIds,
);

function assertScope(value: unknown): asserts value is DeploymentConformanceScope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Deployment conformance scope must be an object.');
  }
  const keys = Reflect.ownKeys(value);
  if ((keys.length !== 2 && keys.length !== 3)
    || !keys.includes('profiles') || !keys.includes('capabilities')
    || (keys.length === 3 && !keys.includes('mcpConformance'))
    || keys.some((key) => typeof key !== 'string'
      || (key !== 'profiles' && key !== 'capabilities' && key !== 'mcpConformance'))) {
    throw new TypeError(
      'Deployment conformance scope must contain only profiles and capabilities (plus optional mcpConformance).',
    );
  }
  for (const key of ['profiles', 'capabilities'] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)
      || !Array.isArray(descriptor.value)) {
      throw new TypeError(`Deployment conformance scope ${key} must be an enumerable array value.`);
    }
  }
  if (keys.includes('mcpConformance')) {
    const descriptor = Object.getOwnPropertyDescriptor(value, 'mcpConformance');
    const mcpConformance = descriptor === undefined ? undefined : descriptor.value;
    if (typeof mcpConformance !== 'object' || mcpConformance === null || Array.isArray(mcpConformance)) {
      throw new TypeError('Deployment conformance scope mcpConformance must be an object.');
    }
    const mcpKeys = Reflect.ownKeys(mcpConformance);
    if (mcpKeys.length !== 3
      || !mcpKeys.includes('sourceRevision')
      || !mcpKeys.includes('requirementsDigest')
      || !mcpKeys.includes('reportDigest')
      || mcpKeys.some((key) => typeof key !== 'string')) {
      throw new TypeError(
        'Deployment conformance scope mcpConformance must contain only sourceRevision, requirementsDigest, and reportDigest.',
      );
    }
    const sourceRevision = (mcpConformance as { sourceRevision?: unknown }).sourceRevision;
    const requirementsDigest = (mcpConformance as { requirementsDigest?: unknown }).requirementsDigest;
    const reportDigest = (mcpConformance as { reportDigest?: unknown }).reportDigest;
    if (typeof sourceRevision !== 'string' || !/^[0-9a-f]{40,64}$/u.test(sourceRevision)) {
      throw new TypeError('Deployment conformance scope mcpConformance.sourceRevision must be a full hexadecimal commit ID.');
    }
    if (typeof requirementsDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(requirementsDigest)) {
      throw new TypeError('Deployment conformance scope mcpConformance.requirementsDigest must be a SHA-256 digest.');
    }
    if (typeof reportDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(reportDigest)) {
      throw new TypeError('Deployment conformance scope mcpConformance.reportDigest must be a SHA-256 digest.');
    }
  }
}

/** Resolves an exact immutable probe plan from Manifest Profiles and enabled deployment roles. */
export function createDeploymentConformancePlan(
  scope: DeploymentConformanceScope,
): DeploymentConformancePlan {
  assertScope(scope);
  if (scope.profiles.length === 0) {
    throw new TypeError('Deployment conformance scope must contain at least one Profile.');
  }

  const selectedProfiles = new Set<ProtocolProfile>();
  for (const value of scope.profiles as readonly unknown[]) {
    if (!knownProfiles.has(value)) {
      throw new TypeError(`Unknown deployment conformance Profile: ${String(value)}`);
    }
    const profile = value as ProtocolProfile;
    if (selectedProfiles.has(profile)) {
      throw new TypeError(`Duplicate deployment conformance Profile: ${profile}`);
    }
    selectedProfiles.add(profile);
  }
  for (const profile of selectedProfiles) {
    for (const dependency of profileDependencies[profile]) {
      if (!selectedProfiles.has(dependency)) {
        throw new TypeError(`Deployment conformance Profile ${profile} requires Profile ${dependency}.`);
      }
    }
  }

  const selectedCapabilities = new Set<DeploymentConformanceCapabilityId>();
  for (const value of scope.capabilities as readonly unknown[]) {
    if (!knownCapabilityIds.has(value as DeploymentConformanceCapabilityId)) {
      throw new TypeError(`Unknown deployment conformance capability: ${String(value)}`);
    }
    const capability = value as DeploymentConformanceCapabilityId;
    if (selectedCapabilities.has(capability)) {
      throw new TypeError(`Duplicate deployment conformance capability: ${capability}`);
    }
    selectedCapabilities.add(capability);
  }
  for (const profile of selectedProfiles) {
    for (const capability of profileDeploymentConformanceCapabilities[profile]) {
      selectedCapabilities.add(capability);
    }
  }

  const profiles = Object.freeze(
    deploymentConformanceProfileOrder.filter((profile) => selectedProfiles.has(profile)),
  );
  const capabilities = Object.freeze(
    deploymentConformanceCapabilityIds.filter((capability) => selectedCapabilities.has(capability)),
  );
  const requiredProbeIds = new Set<DeploymentConformanceProbeId>();
  for (const profile of profiles) {
    for (const probeId of profileDeploymentConformanceProbes[profile]) requiredProbeIds.add(probeId);
  }
  for (const capability of capabilities) {
    for (const probeId of deploymentCapabilityConformanceProbes[capability]) {
      requiredProbeIds.add(probeId);
    }
  }
  const probeIds = Object.freeze(
    deploymentConformanceProbeIds.filter((probeId) => requiredProbeIds.has(probeId)),
  );
  return Object.freeze({ profiles, capabilities, probeIds });
}

export type DeploymentConformanceCommand =
  | {
      readonly kind: 'id-ledger.reserve';
      readonly logicalKey: string;
      readonly requestedId: string;
      readonly resourceType: 'collection' | 'node' | 'annotation' | 'attachment' | 'relation' | 'operation' | 'event';
    }
  | { readonly kind: 'id-ledger.delete-resource'; readonly logicalKey: string }
  | { readonly kind: 'sync-extension.replace'; readonly resourceId: string; readonly value: unknown }
  | { readonly kind: 'sync-extension.load'; readonly resourceId: string }
  | { readonly kind: 'pre-write.write'; readonly objectId: string; readonly candidate: unknown }
  | { readonly kind: 'pre-write.load'; readonly objectId: string }
  | { readonly kind: 'parent-cycle.seed'; readonly nodes: readonly ParentProbeNode[] }
  | { readonly kind: 'parent-cycle.move'; readonly nodeId: string; readonly parentId: string }
  | { readonly kind: 'parent-cycle.parent'; readonly nodeId: string }
  | { readonly kind: 'node-subtree.seed'; readonly nodes: readonly ParentProbeNode[] }
  | { readonly kind: 'node-subtree.delete'; readonly nodeId: string }
  | { readonly kind: 'node-subtree.read'; readonly nodeId: string }
  | { readonly kind: 'managed-bookmarks.seed'; readonly folderId: string; readonly childId: string }
  | {
      readonly kind: 'managed-bookmarks.mutate';
      readonly mutation:
        | 'create-child'
        | 'update-node'
        | 'move-node'
        | 'reorder-children'
        | 'delete-node'
        | 'delete-subtree'
        | 'restore-node';
      readonly nodeId: string;
      readonly marker: string;
    }
  | { readonly kind: 'managed-bookmarks.read'; readonly nodeId: string }
  | {
      readonly kind: 'ai-provenance.create';
      readonly objectId: string;
      readonly trustedOrigin: 'ai' | 'human';
      readonly callerProvenance?: unknown;
    }
  | { readonly kind: 'ai-provenance.edit-human'; readonly objectId: string }
  | { readonly kind: 'ai-provenance.load'; readonly objectId: string }
  | { readonly kind: 'random-profile-id.get-or-create'; readonly profileKey: string }
  | {
      readonly kind: 'profile-id.configure-key';
      readonly version: string;
      readonly secret: string;
    }
  | { readonly kind: 'profile-id.activate-key'; readonly version: string }
  | { readonly kind: 'profile-id.derive'; readonly profileKey: string; readonly version: string }
  | { readonly kind: 'publication.http-contract'; readonly challenge: string }
  | { readonly kind: 'feed.delivery-contract'; readonly challenge: string }
  | { readonly kind: 'publisher.transaction-contract'; readonly challenge: string }
  | { readonly kind: 'sync.transaction-contract'; readonly challenge: string }
  | {
      readonly kind: 'mcp-2026-07-28.transport-header-contract';
      readonly challenge: string;
      readonly headers: readonly { readonly name: string; readonly value: string }[];
    }
  | { readonly kind: 'mcp-2026-07-28.discovery-contract'; readonly challenge: string }
  | {
      readonly kind: 'mcp-2026-07-28.subscription-contract';
      readonly challenge: string;
      readonly subscriptionId: string;
      readonly notification: {
        readonly method: string;
        readonly subscriptionId: string;
        readonly resourceBody: boolean;
      };
    }
  | {
      readonly kind: 'mcp-2026-07-28.read-schema-contract';
      readonly challenge: string;
      readonly schema: unknown;
      readonly budget: { readonly maxNodes: number; readonly maxDepth: number; readonly maxBytes: number };
    }
  | {
      readonly kind: 'mcp-2026-07-28.write-mrtr-contract';
      readonly challenge: string;
      readonly mode: 'complete' | 'input_required';
    }
  | {
      readonly kind: 'mcp-2026-07-28.oauth-client-contract';
      readonly challenge: string;
      readonly issuer: string;
      readonly expectedIssuer: string;
      readonly applicationType: 'web' | 'native';
      readonly credentialKey: string;
    };

export interface ParentProbeNode {
  readonly id: string;
  readonly parentId: string | null;
}

/**
 * Test-control adapter for a real deployment. The package owns every command
 * sequence and assertion; adapters may only translate commands to deployment operations.
 */
export interface DeploymentConformanceTarget {
  execute(command: DeploymentConformanceCommand): Promise<unknown>;
  restart(): Promise<void>;
  readDiagnostics(): Promise<unknown>;
}

declare const verifiedDeploymentEvidenceBrand: unique symbol;

export interface VerifiedDeploymentConformanceEvidence {
  readonly profiles: readonly ProtocolProfile[];
  readonly capabilities: readonly DeploymentConformanceCapabilityId[];
  readonly passedProbeIds: readonly DeploymentConformanceProbeId[];
  /**
   * Exact versioned MCP binding (version/source/SDK lock/fixture topology/
   * digests) present exactly when the issued scope exercised a versioned MCP
   * probe family. Old unversioned evidence can never carry this binding.
   */
  readonly mcpBinding?: McpVersionedEvidenceBinding;
  readonly [verifiedDeploymentEvidenceBrand]: true;
}

const knownProbeIds = new Set<DeploymentConformanceProbeId>(deploymentConformanceProbeIds);
const issuedEvidence = new WeakSet<object>();

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must return an observation object.`);
  }
  return value as Record<string, unknown>;
}

function requirePromise<Value>(value: Promise<Value>, label: string): Promise<Value> {
  if (!(value instanceof Promise)) throw new TypeError(`${label} must return a native Promise.`);
  return value;
}

async function execute(
  target: DeploymentConformanceTarget,
  command: DeploymentConformanceCommand,
): Promise<Record<string, unknown>> {
  return record(
    await requirePromise(target.execute(Object.freeze(structuredClone(command))), 'Deployment execute'),
    command.kind,
  );
}

async function restart(target: DeploymentConformanceTarget): Promise<void> {
  const result = await requirePromise(target.restart(), 'Deployment restart');
  if (result !== undefined) throw new TypeError('Deployment restart must resolve without a result.');
}

function equalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertStatus(observation: Record<string, unknown>, expected: string, label: string): void {
  if (observation.status !== expected) {
    throw new Error(`${label} did not report status ${expected}.`);
  }
}

function assertJsonDoesNotContainSecret(value: unknown, secret: string, label: string): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new TypeError(`${label} must be JSON serializable.`);
  }
  const bytes = Buffer.from(secret, 'utf8');
  const representations = new Set([
    secret,
    bytes.toString('hex'),
    bytes.toString('hex').toUpperCase(),
    bytes.toString('base64'),
    bytes.toString('base64url'),
  ]);
  if ([...representations].some((candidate) => serialized.includes(candidate))) {
    throw new Error(`${label} disclosed Profile ID key material.`);
  }
}

function assertCanonicalRandomProfileId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^prf\.r1\.[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new Error(`${label} is not a canonical prf.r1 Profile ID.`);
  }
  const encoded = value.slice('prf.r1.'.length);
  const bytes = Buffer.from(encoded, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== encoded) {
    throw new Error(`${label} is not a canonical 256-bit prf.r1 Profile ID.`);
  }
}

const officialScenarios: Readonly<Record<DeploymentConformanceProbeId, (
  target: DeploymentConformanceTarget,
) => Promise<void>>> = Object.freeze({
  async 'core.id-ledger-persistence'(target) {
    const key = `ledger-${randomUUID()}`;
    const otherKey = `ledger-${randomUUID()}`;
    const id = `id-${randomUUID()}`;
    const first = await execute(target, {
      kind: 'id-ledger.reserve',
      logicalKey: key,
      requestedId: id,
      resourceType: 'collection',
    });
    assertStatus(first, 'reserved', 'ID ledger first reservation');
    if (first.id !== id) throw new Error('ID ledger changed the reserved ID.');
    await restart(target);
    const replay = await execute(target, {
      kind: 'id-ledger.reserve',
      logicalKey: key,
      requestedId: `id-${randomUUID()}`,
      resourceType: 'collection',
    });
    assertStatus(replay, 'reserved', 'ID ledger replay');
    if (replay.id !== id) throw new Error('ID ledger did not retain the committed mapping after restart.');
    const conflict = await execute(target, {
      kind: 'id-ledger.reserve',
      logicalKey: otherKey,
      requestedId: id,
      resourceType: 'event',
    });
    assertStatus(conflict, 'conflict', 'ID ledger duplicate reservation');

    const contendedId = `id-${randomUUID()}`;
    const contenders = await Promise.all([
      execute(target, {
        kind: 'id-ledger.reserve',
        logicalKey: `ledger-${randomUUID()}`,
        requestedId: contendedId,
        resourceType: 'node',
      }),
      execute(target, {
        kind: 'id-ledger.reserve',
        logicalKey: `ledger-${randomUUID()}`,
        requestedId: contendedId,
        resourceType: 'annotation',
      }),
    ]);
    if (contenders.filter(({ status }) => status === 'reserved').length !== 1
      || contenders.filter(({ status }) => status === 'conflict').length !== 1) {
      throw new Error('Concurrent ID ledger reservations did not produce exactly one winner.');
    }

    const deleted = await execute(target, { kind: 'id-ledger.delete-resource', logicalKey: key });
    assertStatus(deleted, 'deleted', 'ID ledger resource deletion');
    const afterDelete = await execute(target, {
      kind: 'id-ledger.reserve',
      logicalKey: `ledger-${randomUUID()}`,
      requestedId: id,
      resourceType: 'relation',
    });
    assertStatus(afterDelete, 'conflict', 'ID ledger reservation after resource deletion');
  },

  async 'core.sync-extension-persistence'(target) {
    const resourceId = `resource-${randomUUID()}`;
    const value = { [`https://extensions.example/${randomUUID()}`]: { present: false, count: 0 } };
    const stored = await execute(target, { kind: 'sync-extension.replace', resourceId, value });
    assertStatus(stored, 'stored', 'Sync extension replacement');
    await restart(target);
    const loaded = await execute(target, { kind: 'sync-extension.load', resourceId });
    assertStatus(loaded, 'found', 'Sync extension reload');
    if (!equalJson(loaded.value, value)) throw new Error('Sync extensions changed across restart.');
  },

  async 'core.pre-write-validation'(target) {
    const base = {
      collectionId: `collection-${randomUUID()}`,
      kind: 'bookmark',
      parentId: `root-${randomUUID()}`,
      position: 'A0',
      title: 'Conformance Bookmark',
      url: 'https://example.com/original?order=1&order=2',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      revision: 'revision-1',
      extensions: {},
    };
    const structuralId = `structural-${randomUUID()}`;
    const structural = await execute(target, {
      kind: 'pre-write.write',
      objectId: structuralId,
      candidate: { ...base, id: structuralId, url: 42 },
    });
    assertStatus(structural, 'rejected', 'Pre-write structurally invalid candidate');
    const structuralLoaded = await execute(target, { kind: 'pre-write.load', objectId: structuralId });
    assertStatus(structuralLoaded, 'missing', 'Pre-write structural rejection lookup');

    const semanticId = `semantic-${randomUUID()}`;
    const semantic = await execute(target, {
      kind: 'pre-write.write',
      objectId: semanticId,
      candidate: {
        ...base,
        id: semanticId,
        urlHash: `sha-256=:${Buffer.alloc(32).toString('base64')}:`,
      },
    });
    assertStatus(semantic, 'rejected', 'Pre-write semantically invalid candidate');
    const semanticLoaded = await execute(target, { kind: 'pre-write.load', objectId: semanticId });
    assertStatus(semanticLoaded, 'missing', 'Pre-write semantic rejection lookup');

    const validId = `valid-${randomUUID()}`;
    const validCandidate = { ...base, id: validId };
    const valid = await execute(target, {
      kind: 'pre-write.write',
      objectId: validId,
      candidate: validCandidate,
    });
    assertStatus(valid, 'stored', 'Pre-write valid candidate');
    const validLoaded = await execute(target, { kind: 'pre-write.load', objectId: validId });
    assertStatus(validLoaded, 'found', 'Pre-write valid persistence lookup');
    if (!equalJson(validLoaded.value, validCandidate)) {
      throw new Error('Pre-write valid candidate changed during persistence.');
    }
  },

  async 'core.parent-cycle-transaction'(target) {
    const root = `root-${randomUUID()}`;
    const source = `source-${randomUUID()}`;
    const child = `child-${randomUUID()}`;
    const seeded = await execute(target, {
      kind: 'parent-cycle.seed',
      nodes: [{ id: root, parentId: null }, { id: source, parentId: root }, { id: child, parentId: source }],
    });
    assertStatus(seeded, 'stored', 'Parent-cycle fixture');
    const moved = await execute(target, { kind: 'parent-cycle.move', nodeId: source, parentId: child });
    assertStatus(moved, 'rejected', 'Parent-cycle mutation');
    const parent = await execute(target, { kind: 'parent-cycle.parent', nodeId: source });
    assertStatus(parent, 'found', 'Parent-cycle source lookup');
    if (parent.parentId !== root) throw new Error('Rejected parent-cycle mutation partially persisted.');
  },

  async 'core.node-subtree-transaction'(target) {
    const parent = `parent-${randomUUID()}`;
    const subtree = `subtree-${randomUUID()}`;
    const nested = `nested-${randomUUID()}`;
    const leaf = `leaf-${randomUUID()}`;
    const sibling = `sibling-${randomUUID()}`;
    const seeded = await execute(target, {
      kind: 'node-subtree.seed',
      nodes: [
        { id: parent, parentId: null },
        { id: subtree, parentId: parent },
        { id: nested, parentId: subtree },
        { id: leaf, parentId: nested },
        { id: sibling, parentId: parent },
      ],
    });
    assertStatus(seeded, 'stored', 'Node subtree fixture');
    const deleted = await execute(target, { kind: 'node-subtree.delete', nodeId: subtree });
    assertStatus(deleted, 'deleted', 'Node subtree deletion');
    if (deleted.affectedCount !== 3) {
      throw new Error('Node subtree deletion affectedCount did not equal the complete deletion range.');
    }
    for (const nodeId of [subtree, nested, leaf]) {
      const loaded = await execute(target, { kind: 'node-subtree.read', nodeId });
      assertStatus(loaded, 'missing', `Deleted subtree member ${nodeId}`);
    }
    for (const nodeId of [parent, sibling]) {
      const loaded = await execute(target, { kind: 'node-subtree.read', nodeId });
      assertStatus(loaded, 'found', `Surviving subtree neighbor ${nodeId}`);
    }
  },

  async 'core.managed-bookmarks-transaction'(target) {
    const folderId = `managed-${randomUUID()}`;
    const childId = `child-${randomUUID()}`;
    const seeded = await execute(target, { kind: 'managed-bookmarks.seed', folderId, childId });
    assertStatus(seeded, 'stored', 'Managed-bookmarks fixture');
    const mutationKinds = [
      'create-child',
      'update-node',
      'move-node',
      'reorder-children',
      'delete-node',
      'delete-subtree',
      'restore-node',
    ] as const;
    for (const mutation of mutationKinds) {
      const result = await execute(target, {
        kind: 'managed-bookmarks.mutate',
        mutation,
        nodeId: mutation === 'create-child' || mutation === 'reorder-children' ? folderId : childId,
        marker: `forbidden-${randomUUID()}`,
      });
      assertStatus(result, 'rejected', `Managed-bookmarks ${mutation}`);
    }
    const loaded = await execute(target, { kind: 'managed-bookmarks.read', nodeId: childId });
    assertStatus(loaded, 'found', 'Managed-bookmarks descendant reload');
    if (loaded.title !== 'original') throw new Error('Rejected managed-bookmarks mutations partially persisted.');
  },

  async 'core.ai-provenance-transaction'(target) {
    const forgedId = `annotation-${randomUUID()}`;
    const forged = await execute(target, {
      kind: 'ai-provenance.create',
      objectId: forgedId,
      trustedOrigin: 'human',
      callerProvenance: {
        kind: 'ai',
        generatedAt: '2026-01-01T00:00:00Z',
        provider: 'caller-forged',
      },
    });
    assertStatus(forged, 'rejected', 'Caller-forged AI provenance');
    const forgedLoaded = await execute(target, { kind: 'ai-provenance.load', objectId: forgedId });
    assertStatus(forgedLoaded, 'missing', 'Caller-forged AI provenance lookup');

    const trustedId = `annotation-${randomUUID()}`;
    const trusted = await execute(target, {
      kind: 'ai-provenance.create',
      objectId: trustedId,
      trustedOrigin: 'ai',
      callerProvenance: { kind: 'human' },
    });
    assertStatus(trusted, 'stored', 'Trusted AI annotation creation');
    const created = await execute(target, { kind: 'ai-provenance.load', objectId: trustedId });
    assertStatus(created, 'found', 'Trusted AI annotation lookup');
    const provenance = record(created.provenance, 'Trusted AI annotation provenance');
    if (provenance.kind !== 'ai' || typeof provenance.generatedAt !== 'string'
      || provenance.provider === 'caller-forged') {
      throw new Error('Trusted AI annotation did not persist server-authoritative provenance.');
    }
    const generatedAt = provenance.generatedAt;

    const edited = await execute(target, { kind: 'ai-provenance.edit-human', objectId: trustedId });
    assertStatus(edited, 'stored', 'Human edit of trusted AI annotation');
    const editedValue = await execute(target, { kind: 'ai-provenance.load', objectId: trustedId });
    assertStatus(editedValue, 'found', 'Human-edited AI annotation lookup');
    const editedProvenance = record(editedValue.provenance, 'Human-edited AI annotation provenance');
    if (editedProvenance.kind !== 'ai' || editedProvenance.generatedAt !== generatedAt
      || editedProvenance.editedByHuman !== true) {
      throw new Error('Human edit did not preserve and mark trusted AI provenance.');
    }
  },

  async 'core.profile-id-persistence'(target) {
    const profileKey = `profile-${randomUUID()}`;
    const otherProfileKey = `profile-${randomUUID()}`;
    const [first, concurrent] = await Promise.all([
      execute(target, { kind: 'random-profile-id.get-or-create', profileKey }),
      execute(target, { kind: 'random-profile-id.get-or-create', profileKey }),
    ]);
    assertStatus(first, 'found', 'Random Profile ID creation');
    assertStatus(concurrent, 'found', 'Concurrent random Profile ID creation');
    assertCanonicalRandomProfileId(first.id, 'Random Profile ID');
    assertCanonicalRandomProfileId(concurrent.id, 'Concurrent random Profile ID');
    if (concurrent.id !== first.id) throw new Error('Concurrent Profile ID creation produced different IDs.');
    const other = await execute(target, {
      kind: 'random-profile-id.get-or-create',
      profileKey: otherProfileKey,
    });
    assertStatus(other, 'found', 'Independent random Profile ID creation');
    assertCanonicalRandomProfileId(other.id, 'Independent random Profile ID');
    if (other.id === first.id) throw new Error('Different Profile keys reused one random Profile ID.');
    await restart(target);
    const second = await execute(target, { kind: 'random-profile-id.get-or-create', profileKey });
    assertStatus(second, 'found', 'Random Profile ID reload');
    assertCanonicalRandomProfileId(second.id, 'Reloaded random Profile ID');
    if (second.id !== first.id) throw new Error('Random Profile ID changed after restart.');
    const otherReloaded = await execute(target, {
      kind: 'random-profile-id.get-or-create',
      profileKey: otherProfileKey,
    });
    assertStatus(otherReloaded, 'found', 'Independent random Profile ID reload');
    if (otherReloaded.id !== other.id) throw new Error('Independent random Profile ID changed after restart.');
  },

  async 'core.profile-id-key-rotation'(target) {
    const profileKey = `profile-${randomUUID()}`;
    const firstVersion = `v-${randomUUID()}`;
    const secondVersion = `v-${randomUUID()}`;
    await execute(target, { kind: 'profile-id.configure-key', version: firstVersion, secret: randomUUID() });
    await execute(target, { kind: 'profile-id.activate-key', version: firstVersion });
    const first = await execute(target, { kind: 'profile-id.derive', profileKey, version: firstVersion });
    assertStatus(first, 'derived', 'Initial HMAC Profile ID');
    await execute(target, { kind: 'profile-id.configure-key', version: secondVersion, secret: randomUUID() });
    await execute(target, { kind: 'profile-id.activate-key', version: secondVersion });
    const rotated = await execute(target, { kind: 'profile-id.derive', profileKey, version: secondVersion });
    assertStatus(rotated, 'derived', 'Rotated HMAC Profile ID');
    if (rotated.id === first.id) throw new Error('Key rotation did not change the versioned Profile ID.');
    await restart(target);
    const retained = await execute(target, { kind: 'profile-id.derive', profileKey, version: firstVersion });
    assertStatus(retained, 'derived', 'Retained HMAC Profile ID');
    if (retained.id !== first.id) throw new Error('Old HMAC key mapping did not survive rotation and restart.');
  },

  async 'core.secret-redaction'(target) {
    const secret = `secret-${randomUUID()}`;
    const version = `redaction-${randomUUID()}`;
    const configured = await execute(target, { kind: 'profile-id.configure-key', version, secret });
    assertStatus(configured, 'configured', 'Secret-redaction key configuration');
    assertJsonDoesNotContainSecret(configured, secret, 'Profile ID key configuration response');
    const activated = await execute(target, { kind: 'profile-id.activate-key', version });
    assertStatus(activated, 'activated', 'Secret-redaction key activation');
    assertJsonDoesNotContainSecret(activated, secret, 'Profile ID key activation response');
    const derived = await execute(target, {
      kind: 'profile-id.derive',
      profileKey: `redaction-profile-${randomUUID()}`,
      version,
    });
    assertStatus(derived, 'derived', 'Secret-redaction Profile ID derivation');
    assertJsonDoesNotContainSecret(derived, secret, 'Profile ID derivation response');
    const diagnostics = await requirePromise(target.readDiagnostics(), 'Deployment diagnostics');
    assertJsonDoesNotContainSecret(diagnostics, secret, 'Deployment diagnostics');
  },

  async 'publication.http-contracts'(target) {
    const challenge = randomUUID();
    const result = await execute(target, { kind: 'publication.http-contract', challenge });
    if (result.challenge !== challenge || result.initialStatus !== 200 || result.conditionalStatus !== 304
      || result.validated !== true || typeof result.etag !== 'string') {
      throw new Error('Publication HTTP contract observation is incomplete.');
    }
  },
  async 'feed.delivery-contracts'(target) {
    const challenge = randomUUID();
    const result = await execute(target, { kind: 'feed.delivery-contract', challenge });
    if (result.challenge !== challenge || result.releaseFirst !== true || result.skipRejected !== true) {
      throw new Error('Feed delivery contract observation is incomplete.');
    }
  },
  async 'publisher.transaction-contracts'(target) {
    const challenge = randomUUID();
    const result = await execute(target, { kind: 'publisher.transaction-contract', challenge });
    if (result.challenge !== challenge || result.committed !== true || result.replayed !== true
      || result.rollbackObserved !== true) {
      throw new Error('Publisher transaction contract observation is incomplete.');
    }
  },
  async 'sync.transaction-contracts'(target) {
    const challenge = randomUUID();
    const result = await execute(target, { kind: 'sync.transaction-contract', challenge });
    if (result.challenge !== challenge || result.casObserved !== true || result.replayed !== true
      || result.rollbackObserved !== true) {
      throw new Error('Sync transaction contract observation is incomplete.');
    }
  },
  async 'mcp-2026-07-28.transport-header-contracts'(target) {
    const challenge = randomUUID();
    const encoded = `=?base64?${Buffer.from('sentinel', 'utf8').toString('base64')}?=`;
    const valid = await execute(target, {
      kind: 'mcp-2026-07-28.transport-header-contract',
      challenge,
      headers: [
        { name: 'Mcp-Method', value: 'resources/read' },
        { name: 'Mcp-Name', value: encoded },
        { name: 'Mcp-Param-collectionId', value: 'collection-1' },
      ],
    });
    if (valid.challenge !== challenge) throw new Error('MCP transport-header challenge was not echoed.');
    if (valid.accepted !== true || valid.codec !== 'base64' || valid.decoded !== 'sentinel'
      || valid.unique !== true) {
      throw new Error('MCP transport-header contract did not prove the Base64 sentinel codec handling.');
    }
    const conflicting = await execute(target, {
      kind: 'mcp-2026-07-28.transport-header-contract',
      challenge: `${challenge}-conflict`,
      headers: [
        { name: 'Mcp-Method', value: 'resources/read' },
        { name: 'Mcp-Method', value: 'tools/call' },
      ],
    });
    if (conflicting.challenge !== `${challenge}-conflict`) {
      throw new Error('MCP transport-header conflict challenge was not echoed.');
    }
    if (conflicting.accepted !== false || conflicting.unique !== false) {
      throw new Error('MCP transport-header contract did not reject conflicting header cardinality.');
    }
  },
  async 'mcp-2026-07-28.discovery-contracts'(target) {
    const challenge = randomUUID();
    const result = await execute(target, { kind: 'mcp-2026-07-28.discovery-contract', challenge });
    if (result.protocolVersion !== '2026-07-28') {
      throw new Error(
        `MCP discovery contract must declare protocol version 2026-07-28, received ${String(result.protocolVersion)}.`,
      );
    }
    if (result.challenge !== challenge || result.discovered !== true
      || typeof result.serverInfo !== 'object' || result.serverInfo === null
      || typeof (result.serverInfo as { name?: unknown }).name !== 'string'
      || result.capabilitiesDeclared !== true || result.extensionsBounded !== true) {
      throw new Error('MCP discovery contract observation is incomplete or wrong.');
    }
  },
  async 'mcp-2026-07-28.subscription-contracts'(target) {
    const challenge = randomUUID();
    const subscriptionId = `sub-${randomUUID()}`;
    const routed = await execute(target, {
      kind: 'mcp-2026-07-28.subscription-contract',
      challenge,
      subscriptionId,
      notification: {
        method: 'notifications/resources/updated',
        subscriptionId,
        resourceBody: false,
      },
    });
    if (routed.challenge !== challenge || routed.subscriptionId !== subscriptionId
      || routed.acknowledged !== true || routed.notificationRouted !== true
      || routed.requestScoped !== true || routed.bodyCarried !== false) {
      throw new Error('MCP subscription contract did not route a request-scoped notification.');
    }
    const misrouted = await execute(target, {
      kind: 'mcp-2026-07-28.subscription-contract',
      challenge: `${challenge}-misroute`,
      subscriptionId,
      notification: {
        method: 'notifications/resources/updated',
        subscriptionId: `other-${subscriptionId}`,
        resourceBody: false,
      },
    });
    if (misrouted.challenge !== `${challenge}-misroute` || misrouted.notificationRouted !== false) {
      throw new Error('MCP subscription contract did not refuse a misrouted notification.');
    }
  },
  async 'mcp-2026-07-28.read-schema-contracts'(target) {
    const challenge = randomUUID();
    const normal = await execute(target, {
      kind: 'mcp-2026-07-28.read-schema-contract',
      challenge,
      schema: {
        type: 'object',
        properties: { collectionId: { type: 'string' } },
        additionalProperties: false,
      },
      budget: { maxNodes: 64, maxDepth: 8, maxBytes: 4096 },
    });
    if (normal.challenge !== challenge || normal.accepted !== true || normal.refsResolved !== true) {
      throw new Error('MCP read-schema contract did not accept a bounded schema.');
    }
    const bombSchema = Array.from({ length: 2000 }, () => ({ $ref: '#/definitions/explode' }));
    const bomb = await execute(target, {
      kind: 'mcp-2026-07-28.read-schema-contract',
      challenge: `${challenge}-bomb`,
      schema: bombSchema,
      budget: { maxNodes: 64, maxDepth: 8, maxBytes: 4096 },
    });
    if (bomb.challenge !== `${challenge}-bomb` || bomb.accepted !== false) {
      throw new Error('MCP read-schema contract did not reject a Schema bomb beyond the budget.');
    }
  },
  async 'mcp-2026-07-28.write-mrtr-contracts'(target) {
    const challenge = randomUUID();
    const complete = await execute(target, {
      kind: 'mcp-2026-07-28.write-mrtr-contract',
      challenge,
      mode: 'complete',
    });
    if (complete.challenge !== challenge || complete.resultType !== 'complete'
      || complete.serverInitiated !== false) {
      throw new Error('MCP write/MRTR contract did not fix normal results to complete.');
    }
    const pending = await execute(target, {
      kind: 'mcp-2026-07-28.write-mrtr-contract',
      challenge: `${challenge}-pending`,
      mode: 'input_required',
    });
    if (pending.challenge !== `${challenge}-pending` || pending.resultType !== 'input_required'
      || typeof pending.requestState !== 'string' || pending.requestState.length === 0
      || pending.retryResumed !== true || pending.serverInitiated !== false) {
      throw new Error('MCP write/MRTR contract did not return a bound input_required result.');
    }
  },
  async 'mcp-2026-07-28.oauth-client-contracts'(target) {
    const challenge = randomUUID();
    const valid = await execute(target, {
      kind: 'mcp-2026-07-28.oauth-client-contract',
      challenge,
      issuer: 'https://issuer.example/',
      expectedIssuer: 'https://issuer.example/',
      applicationType: 'native',
      credentialKey: 'issuer-keyed',
    });
    if (valid.challenge !== challenge || valid.issuerValidated !== true
      || valid.dcrApplicationType !== 'native'
      || valid.credentialIssuerKeyed !== true || valid.refreshStateIsolated !== true) {
      throw new Error('MCP OAuth client contract observation is incomplete or wrong.');
    }
    const mixedUp = await execute(target, {
      kind: 'mcp-2026-07-28.oauth-client-contract',
      challenge: `${challenge}-mixup`,
      issuer: 'https://issuer.example/',
      expectedIssuer: 'https://attacker.example/',
      applicationType: 'web',
      credentialKey: 'other-issuer-key',
    });
    if (mixedUp.challenge !== `${challenge}-mixup` || mixedUp.issuerValidated !== false) {
      throw new Error('MCP OAuth client contract did not reject an iss mix-up.');
    }
  },
});

function assertTarget(value: unknown): asserts value is DeploymentConformanceTarget {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Deployment conformance target must be an object.');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 3 || !keys.includes('execute') || !keys.includes('restart')
    || !keys.includes('readDiagnostics') || keys.some((key) => typeof key !== 'string')) {
    throw new TypeError('Deployment conformance target must contain only execute, restart, and readDiagnostics.');
  }
  for (const key of ['execute', 'restart', 'readDiagnostics'] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)
      || typeof descriptor.value !== 'function') {
      throw new TypeError(`Deployment conformance target ${key} must be an enumerable function.`);
    }
  }
}

/** Runs one package-owned scenario without issuing publishable evidence. */
export async function runDeploymentConformanceProbe(
  target: DeploymentConformanceTarget,
  probeId: DeploymentConformanceProbeId,
): Promise<void> {
  assertTarget(target);
  if (isLegacyMcpConformanceProbeId(probeId)) {
    throw new TypeError(
      `Legacy MCP deployment conformance probe ${String(probeId)} is rejected migration input; `
      + 'use the exact 2026-07-28 family probes instead.',
    );
  }
  if (!knownProbeIds.has(probeId)) {
    throw new TypeError(`Unknown deployment conformance probe: ${String(probeId)}`);
  }
  await officialScenarios[probeId](target);
}

/** Runs the exact scope-derived black-box plan and issues process-local evidence. */
export async function runDeploymentConformanceProbes(
  target: DeploymentConformanceTarget,
  scope: DeploymentConformanceScope,
): Promise<VerifiedDeploymentConformanceEvidence> {
  assertTarget(target);
  const plan = createDeploymentConformancePlan(scope);
  // Validate and snapshot the source binding before any target side effects.
  const exercisesMcpFamilies = plan.probeIds.some((probeId) => isMcpConformanceProbeId(probeId));
  let mcpBinding: McpVersionedEvidenceBinding | undefined;
  if (exercisesMcpFamilies) {
    if (scope.mcpConformance === undefined) {
      throw new TypeError(
        'MCP deployment conformance probes require an mcpConformance source binding '
        + '(sourceRevision, requirementsDigest, reportDigest).',
      );
    }
    const exercisedMcpFamilyIds = mcpConformanceProbeFamilies.filter(
      (family) => plan.probeIds.includes(family),
    );
    mcpBinding = createVersionedMcpEvidenceBinding({
      sourceRevision: scope.mcpConformance.sourceRevision,
      requirementsDigest: scope.mcpConformance.requirementsDigest,
      reportDigest: scope.mcpConformance.reportDigest,
      probeFamilyIds: exercisedMcpFamilyIds,
    });
  }

  const passedProbeIds: DeploymentConformanceProbeId[] = [];
  for (const probeId of plan.probeIds) {
    await officialScenarios[probeId](target);
    passedProbeIds.push(probeId);
  }
  const evidence = Object.freeze({
    profiles: plan.profiles,
    capabilities: plan.capabilities,
    passedProbeIds: Object.freeze(passedProbeIds),
    ...(mcpBinding === undefined ? {} : { mcpBinding }),
  }) as unknown as VerifiedDeploymentConformanceEvidence;
  issuedEvidence.add(evidence);
  return evidence;
}

export function assertVerifiedDeploymentConformanceEvidence(
  value: unknown,
): asserts value is VerifiedDeploymentConformanceEvidence {
  if (typeof value !== 'object' || value === null || !issuedEvidence.has(value)) {
    throw new TypeError(
      'Deployment conformance evidence must be returned by runDeploymentConformanceProbes in this process.',
    );
  }
  const evidence = value as VerifiedDeploymentConformanceEvidence;
  const mcpBinding = evidence.mcpBinding;
  if (mcpBinding !== undefined) {
    const plan = createDeploymentConformancePlan({
      profiles: evidence.profiles,
      capabilities: evidence.capabilities,
    });
    const exercisedFamilyIds = mcpConformanceProbeFamilies.filter(
      (family) => plan.probeIds.includes(family),
    );
    assertVersionedMcpEvidenceBinding(mcpBinding, { probeFamilyIds: exercisedFamilyIds });
  }
}

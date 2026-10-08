import { createHash, randomUUID } from 'node:crypto';

import {
  publicationSnapshotNextUrl,
  type FetchImplementation,
} from '@know-n/colp/client';
import type {
  DeploymentConformanceCommand,
  DeploymentConformanceTarget,
} from '@know-n/colp/conformance';
import {
  createValidatorRegistry,
  validateWireDocument,
} from '@know-n/colp/schema';
import {
  assembleSnapshotPages,
  validateManifestSemantics,
  validateNodeUrlHashSemantics,
} from '@know-n/colp/semantic';
import type { Manifest, Node, Snapshot } from '@know-n/colp/types';
import { createDatabaseRuntime, createPostgresProductCommandReceiptPort, createUnitOfWork, type DatabaseRuntime } from '../../src/infrastructure/database/index.js';
import {
  createPostgresCanonicalMutationPorts,
  createPostgresCollectionsWritePorts,
} from '../../src/infrastructure/collections/index.js';
import {
  CanonicalMutationInvariantError,
  bootstrapCanonicalOwnedCollection,
  createCanonicalMutationApplication,
  type CanonicalMutationInput,
  type JsonObject,
} from '../../src/modules/collections/index.js';

const CONFORMANCE_SUBJECT = 'phase2-profile-conformance';
const LEDGER_PRINCIPAL = canonicalOpaqueId('principal');
const LEDGER_SCOPE = 'phase2-profile-conformance:id-ledger';
const SOURCE_CANDIDATE_EXTENSION = 'https://known.example/conformance/source-node';
const validators = createValidatorRegistry();

export interface Phase2ProfileConformanceTargetOptions {
  readonly databaseUrl: string;
  readonly manifestUrl: string;
  readonly collectionId: string;
  readonly fetch?: FetchImplementation;
}

export interface Phase2ProfileConformanceDeployment {
  readonly target: DeploymentConformanceTarget;
  close(): Promise<void>;
}

/**
 * Adapts COLP's package-owned commands to Known's real PostgreSQL write model
 * and deployed Publication HTTP surface. The dedicated connection lifecycle
 * prevents an in-memory adapter from masquerading as restart persistence.
 */
export async function createPhase2ProfileConformanceTarget(
  options: Phase2ProfileConformanceTargetOptions,
): Promise<Phase2ProfileConformanceDeployment> {
  const databaseUrl = nonEmpty(options.databaseUrl, 'databaseUrl');
  const manifestUrl = exactHttpUrl(options.manifestUrl, 'manifestUrl');
  const collectionId = nonEmpty(options.collectionId, 'collectionId');
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== 'function') {
    throw new TypeError('Phase 2 Profile conformance fetch must be a function');
  }

  let runtime = createProbeRuntime(databaseUrl);
  await runtime.verifyReady();
  await ensureConformancePrincipal(runtime);
  let closed = false;
  const identities = createProbeIdentityMap();

  const target: DeploymentConformanceTarget = Object.freeze({
    async execute(command: DeploymentConformanceCommand) {
      assertOpen(closed);
      return executeCommand(
        runtime,
        manifestUrl,
        collectionId,
        fetchImplementation,
        identities,
        command,
      );
    },
    async restart() {
      assertOpen(closed);
      const previous = runtime;
      await previous.close();
      runtime = createProbeRuntime(databaseUrl);
      await runtime.verifyReady();
      await ensureConformancePrincipal(runtime);
    },
    async readDiagnostics() {
      assertOpen(closed);
      const result = await runtime.pool.query<{ database: string; version: string }>(
        'select current_database() as database, version() as version',
      );
      return {
        database: result.rows[0]?.database ?? 'unknown',
        engine: 'postgresql',
        manifestOrigin: manifestUrl.origin,
      };
    },
  });

  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    target,
    close() {
      closePromise ??= (async () => {
        closed = true;
        await runtime.close();
      })();
      return closePromise;
    },
  });
}

function createProbeRuntime(databaseUrl: string): DatabaseRuntime {
  return createDatabaseRuntime(databaseUrl, {
    maxConnections: 4,
    applicationName: 'known-phase2-profile-conformance',
  });
}

async function ensureConformancePrincipal(runtime: DatabaseRuntime): Promise<void> {
  const fixtureTime = new Date('2026-07-31T00:00:00.000Z');
  await runtime.db.transaction().execute(async (transaction) => {
    await transaction.insertInto('accounts').values({
      id: LEDGER_PRINCIPAL,
      subject_id: CONFORMANCE_SUBJECT,
      status: 'active',
      security_epoch: 0n,
      created_at: fixtureTime,
    }).onConflict((conflict) => conflict.column('id').doNothing()).execute();
    await transaction.insertInto('profiles').values({
      account_id: LEDGER_PRINCIPAL,
      display_name: 'COLP conformance',
      avatar_url: null,
      updated_at: fixtureTime,
    }).onConflict((conflict) => conflict.column('account_id').doNothing()).execute();
  });
}

async function executeCommand(
  runtime: DatabaseRuntime,
  manifestUrl: URL,
  collectionId: string,
  fetchImplementation: FetchImplementation,
  identities: ProbeIdentityMap,
  command: DeploymentConformanceCommand,
): Promise<Record<string, unknown>> {
  switch (command.kind) {
    case 'id-ledger.reserve':
      return reserveLedgerId(runtime, command);
    case 'id-ledger.delete-resource':
      return deleteLedgerResource(runtime, command.logicalKey);
    case 'pre-write.write':
      return preWrite(runtime, identities, command.objectId, command.candidate);
    case 'pre-write.load':
      return loadPreWrite(runtime, identities, command.objectId);
    case 'parent-cycle.seed':
    case 'node-subtree.seed':
      return seedGraph(runtime, identities, command.nodes);
    case 'parent-cycle.move':
      return rejectParentCycle(runtime, identities, command.nodeId, command.parentId);
    case 'parent-cycle.parent':
      return readParent(runtime, identities, command.nodeId);
    case 'node-subtree.delete':
      return deleteSubtree(runtime, identities, command.nodeId);
    case 'node-subtree.read':
      return readNode(runtime, identities, command.nodeId);
    case 'publication.http-contract':
      return inspectPublicationHttp(
        manifestUrl,
        collectionId,
        fetchImplementation,
        command.challenge,
      );
    default:
      throw new TypeError(
        `Phase 2 deployment scope does not enable command ${command.kind}`,
      );
  }
}

async function reserveLedgerId(
  runtime: DatabaseRuntime,
  command: Extract<DeploymentConformanceCommand, { readonly kind: 'id-ledger.reserve' }>,
): Promise<Record<string, unknown>> {
  const binding = {
    principalId: LEDGER_PRINCIPAL,
    commandScope: LEDGER_SCOPE,
    commandId: deterministicUuid(command.logicalKey),
  };
  const fingerprint = createHash('sha256')
    .update(`phase2-id-ledger\0${command.logicalKey}`, 'utf8')
    .digest('hex');

  return createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
    const receipts = createPostgresProductCommandReceiptPort(transaction);
    const claim = await receipts.claim(binding, fingerprint);
    if (claim.kind === 'replay') {
      const replay = JSON.parse(Buffer.from(claim.result.body).toString('utf8')) as unknown;
      const record = objectRecord(replay, 'ID ledger replay');
      return { status: 'reserved', id: nonEmpty(record.id, 'ID ledger replay id') };
    }
    if (claim.kind !== 'claimed') {
      throw new Error(`ID ledger command could not be claimed: ${claim.kind}`);
    }

    const inserted = await transaction.insertInto('resource_id_ledger').values({
      resource_id: command.requestedId,
      resource_type: command.resourceType,
      committed_at: null,
    }).onConflict((conflict) => conflict.column('resource_id').doNothing())
      .returning('resource_id')
      .executeTakeFirst();
    if (!inserted) {
      await transaction.deleteFrom('product_command_receipts')
        .where('principal_id', '=', binding.principalId)
        .where('command_scope', '=', binding.commandScope)
        .where('command_id', '=', binding.commandId)
        .execute();
      return { status: 'conflict' };
    }

    const body = Buffer.from(JSON.stringify({ id: command.requestedId }), 'utf8');
    await receipts.complete(binding, fingerprint, {
      status: 201,
      body,
      stableHeaders: {},
      mediaType: 'application/json',
      contractVersion: '1.0.0',
      targetIdentity: command.requestedId,
    });
    return { status: 'reserved', id: command.requestedId };
  });
}

async function deleteLedgerResource(
  runtime: DatabaseRuntime,
  logicalKey: string,
): Promise<Record<string, unknown>> {
  await runtime.db.deleteFrom('product_command_receipts')
    .where('principal_id', '=', LEDGER_PRINCIPAL)
    .where('command_scope', '=', LEDGER_SCOPE)
    .where('command_id', '=', deterministicUuid(logicalKey))
    .execute();
  return { status: 'deleted' };
}

async function preWrite(
  runtime: DatabaseRuntime,
  identities: ProbeIdentityMap,
  objectId: string,
  candidate: unknown,
): Promise<Record<string, unknown>> {
  const structural = validators.validate('node', candidate);
  if (!structural.valid) return { status: 'rejected' };
  const semantic = validateNodeUrlHashSemantics(candidate as Node);
  if (!semantic.valid) return { status: 'rejected' };

  const node = objectRecord(candidate, 'pre-write candidate');
  if (node.id !== objectId || node.kind !== 'bookmark') return { status: 'rejected' };
  const collectionId = nonEmpty(node.collectionId, 'pre-write candidate collectionId');
  const parentId = nonEmpty(node.parentId, 'pre-write candidate parentId');
  const storedObjectId = identities.storage('node', objectId);
  const storedCollectionId = identities.storage('collection', collectionId);
  const storedParentId = identities.storage('node', parentId);
  await bootstrapFixtureCollection(runtime, storedCollectionId, storedParentId);
  await applyNodeCreate(runtime, {
    collectionId: storedCollectionId,
    nodeId: storedObjectId,
    parentId: storedParentId,
    kind: 'bookmark',
    title: nonEmpty(node.title, 'pre-write candidate title'),
    url: nonEmpty(node.url, 'pre-write candidate url'),
    extensions: {
      [SOURCE_CANDIDATE_EXTENSION]: {
        // PostgreSQL jsonb canonicalizes object key order. Preserve the validated
        // Wire representation text so the conformance read can return it exactly.
        json: JSON.stringify(candidate),
      },
    },
  });
  return { status: 'stored' };
}

async function loadPreWrite(
  runtime: DatabaseRuntime,
  identities: ProbeIdentityMap,
  objectId: string,
): Promise<Record<string, unknown>> {
  const row = await runtime.db.selectFrom('nodes')
    .select(['id', 'deleted_at', 'payload_json'])
    .where('id', '=', identities.storage('node', objectId))
    .executeTakeFirst();
  if (!row || row.deleted_at !== null) return { status: 'missing' };
  const payload = objectRecord(row.payload_json, 'canonical Node payload');
  const extensions = objectRecord(payload.extensions, 'canonical Node extensions');
  const encoded = extensions[SOURCE_CANDIDATE_EXTENSION];
  if (encoded === undefined) {
    throw new Error('Canonical Node omitted its conformance source representation');
  }
  const envelope = objectRecord(encoded, 'canonical Node source representation');
  const json = nonEmpty(envelope.json, 'canonical Node source representation json');
  let candidate: unknown;
  try {
    candidate = JSON.parse(json);
  } catch {
    throw new Error('Canonical Node source representation is not valid JSON');
  }
  const structural = validators.validate('node', candidate);
  if (!structural.valid || !validateNodeUrlHashSemantics(candidate as Node).valid) {
    throw new Error('Canonical Node source representation no longer passes COLP validation');
  }
  return { status: 'found', value: candidate };
}

async function seedGraph(
  runtime: DatabaseRuntime,
  identities: ProbeIdentityMap,
  nodes: readonly { readonly id: string; readonly parentId: string | null }[],
): Promise<Record<string, unknown>> {
  const root = nodes.find((node) => node.parentId === null);
  if (!root || nodes.filter((node) => node.parentId === null).length !== 1) {
    throw new TypeError('Graph seed must contain exactly one Root');
  }
  const collectionId = identities.storage('collection',
    `graph:${nodes.map(({ id }) => id).sort().join('\0')}`);
  await bootstrapFixtureCollection(runtime, collectionId, identities.storage('node', root.id));
  const pending = new Map(nodes.filter((node) => node !== root).map((node) => [node.id, node]));
  const inserted = new Set([root.id]);
  while (pending.size > 0) {
    const ready = [...pending.values()].filter(
      (node) => node.parentId !== null && inserted.has(node.parentId),
    );
    if (ready.length === 0) throw new TypeError('Graph seed is disconnected or cyclic');
    for (const node of ready) {
      await applyNodeCreate(runtime, {
        collectionId,
        nodeId: identities.storage('node', node.id),
        parentId: identities.storage('node', node.parentId!),
        kind: 'folder',
        title: node.id,
        url: null,
        extensions: {},
      });
      inserted.add(node.id);
      pending.delete(node.id);
    }
  }
  return { status: 'stored' };
}

async function rejectParentCycle(
  runtime: DatabaseRuntime,
  identities: ProbeIdentityMap,
  nodeId: string,
  parentId: string,
): Promise<Record<string, unknown>> {
  const storedNodeId = identities.storage('node', nodeId);
  const collectionId = await findLiveNodeCollection(runtime, storedNodeId);
  try {
    await applyCanonicalMutation(runtime, {
      operationId: canonicalOpaqueId(randomUUID()),
      collectionId,
      actor: conformanceActor(),
      mutation: {
        action: 'move',
        target: { collectionId, resourceId: storedNodeId, resourceKind: 'node' },
        parentId: identities.storage('node', parentId),
        fields: { kindFields: {}, extensions: {} },
      },
    });
    return { status: 'stored' };
  } catch (error: unknown) {
    if (error instanceof CanonicalMutationInvariantError) return { status: 'rejected' };
    throw error;
  }
}

async function readParent(
  runtime: DatabaseRuntime,
  identities: ProbeIdentityMap,
  nodeId: string,
): Promise<Record<string, unknown>> {
  const row = await runtime.db.selectFrom('nodes')
    .select(['parent_id', 'deleted_at'])
    .where('id', '=', identities.storage('node', nodeId))
    .executeTakeFirst();
  return !row || row.deleted_at !== null
    ? { status: 'missing' }
    : { status: 'found', parentId: row.parent_id === null
      ? null : identities.logical('node', row.parent_id) };
}

async function deleteSubtree(
  runtime: DatabaseRuntime,
  identities: ProbeIdentityMap,
  nodeId: string,
): Promise<Record<string, unknown>> {
  const storedNodeId = identities.storage('node', nodeId);
  const collectionId = await findLiveNodeCollection(runtime, storedNodeId);
  const result = await applyCanonicalMutation(runtime, {
    operationId: canonicalOpaqueId(randomUUID()),
    collectionId,
    actor: conformanceActor(),
    mutation: {
      action: 'delete',
      target: { collectionId, resourceId: storedNodeId, resourceKind: 'node' },
      parentId: null,
      deleteIntent: { scope: 'subtree' },
    },
  });
  return {
    status: 'deleted',
    affectedCount: Object.keys(result.allocation.deletedResourceRevisions ?? {}).length,
  };
}

async function readNode(
  runtime: DatabaseRuntime,
  identities: ProbeIdentityMap,
  nodeId: string,
): Promise<Record<string, unknown>> {
  const row = await runtime.db.selectFrom('nodes')
    .select('deleted_at')
    .where('id', '=', identities.storage('node', nodeId))
    .executeTakeFirst();
  return !row || row.deleted_at !== null ? { status: 'missing' } : { status: 'found' };
}

async function inspectPublicationHttp(
  manifestUrl: URL,
  collectionId: string,
  fetchImplementation: FetchImplementation,
  challenge: string,
): Promise<Record<string, unknown>> {
  const manifestHeaders = {
    accept: 'application/vnd.collection-protocol.manifest+json;version=0.1',
    'collection-protocol-version': '0.1',
  };
  const manifestRead = await inspectConditionalRead(
    manifestUrl,
    manifestHeaders,
    fetchImplementation,
  );
  const value = manifestRead.value;
  const validation = validateWireDocument<Manifest, unknown>(
    validators,
    'manifest',
    value,
    validateManifestSemantics,
  );
  if (!validation.valid) {
    throw new Error(`Publication Manifest failed ${validation.stage} validation`);
  }
  const mount = validation.value.mounts.find((candidate) => candidate.id === 'publication');
  if (!mount) throw new Error('Publication Manifest omitted the publication Mount');
  const endpointUrls = {
    directory: exactHttpUrl(nonEmpty(mount.endpoints.directory, 'directory endpoint'), 'directory endpoint'),
    metadata: exactHttpUrl(
      expandCollectionId(nonEmpty(mount.endpoints.collection, 'collection endpoint'), collectionId),
      'collection endpoint',
    ),
    snapshot: exactHttpUrl(
      expandCollectionId(nonEmpty(mount.endpoints.snapshot, 'snapshot endpoint'), collectionId),
      'snapshot endpoint',
    ),
  };
  if (Object.values(endpointUrls).some((url) => url.origin !== manifestUrl.origin)) {
    throw new Error('Publication endpoint crossed the Manifest origin');
  }
  const directory = await inspectConditionalRead(endpointUrls.directory, {
    accept: 'application/vnd.collection-protocol.catalog+json;version=0.1',
    'collection-protocol-version': '0.1',
  }, fetchImplementation);
  const metadata = await inspectConditionalRead(endpointUrls.metadata, {
    accept: 'application/vnd.collection-protocol.collection+json;version=0.1',
    'collection-protocol-version': '0.1',
  }, fetchImplementation);
  const snapshotPages = await inspectSnapshotPages(endpointUrls.snapshot, {
    accept: 'application/vnd.collection-protocol.snapshot+json;version=0.1',
    'collection-protocol-version': '0.1',
  }, fetchImplementation);
  if (!validators.validate('collectionDirectory', directory.value).valid
      || !validators.validate('collectionMetadata', metadata.value).valid) {
    throw new Error('Publication Directory or Collection Metadata failed schema validation');
  }
  const snapshotAssembly = assembleSnapshotPages(snapshotPages);
  if (!snapshotAssembly.valid) {
    throw new Error('Publication Snapshot failed assembled semantic validation');
  }
  return {
    challenge,
    initialStatus: manifestRead.initialStatus,
    conditionalStatus: manifestRead.conditionalStatus,
    etag: manifestRead.etag,
    validated: true,
  };
}

async function inspectSnapshotPages(
  initialUrl: URL,
  headers: Readonly<Record<string, string>>,
  fetchImplementation: FetchImplementation,
): Promise<readonly Snapshot[]> {
  const pages: Snapshot[] = [];
  let currentUrl: URL | undefined = initialUrl;
  while (currentUrl !== undefined) {
    if (pages.length >= 1_000) throw new Error('Publication Snapshot exceeded the page limit');
    const read = await inspectConditionalRead(currentUrl, headers, fetchImplementation);
    const structural = validators.validate('snapshot', read.value);
    if (!structural.valid) throw new Error('Publication Snapshot failed schema validation');
    const page = read.value as Snapshot;
    pages.push(page);
    currentUrl = publicationSnapshotNextUrl({
      currentUrl,
      initialUrl,
      linkHeader: read.link,
      hasMore: page.page.hasMore,
      nextCursor: page.page.nextCursor,
      validators,
    });
  }
  return pages;
}

async function inspectConditionalRead(
  url: URL,
  headers: Readonly<Record<string, string>>,
  fetchImplementation: FetchImplementation,
): Promise<{
  readonly initialStatus: number;
  readonly conditionalStatus: number;
  readonly etag: string;
  readonly link: string | null;
  readonly value: unknown;
}> {
  const initial = await fetchImplementation(url, { headers });
  const etag = initial.headers.get('etag');
  if (initial.status !== 200 || !etag) {
    throw new Error(
      `Publication endpoint ${url.pathname} was not a cacheable success `
      + `(status=${initial.status}, etag=${etag === null ? 'missing' : 'present'})`,
    );
  }
  const value: unknown = await initial.json();
  const head = await fetchImplementation(url, { method: 'HEAD', headers });
  if (head.status !== 200 || await head.text() !== '') {
    throw new Error(`Publication endpoint ${url.pathname} failed HEAD semantics`);
  }
  let conditional = await fetchImplementation(url, {
    headers: { ...headers, 'if-none-match': etag },
  });
  if (conditional.status === 200) {
    const rolloverEtag = conditional.headers.get('etag');
    if (rolloverEtag && rolloverEtag !== etag) {
      // A time-bucketed continuation cursor may legitimately roll over between
      // the initial and conditional Snapshot reads. Prove the new validator
      // once instead of treating that representation change as a 304 failure.
      conditional = await fetchImplementation(url, {
        headers: { ...headers, 'if-none-match': rolloverEtag },
      });
    }
  }
  if (conditional.status !== 304) {
    throw new Error(`Publication endpoint ${url.pathname} failed conditional GET`);
  }
  return {
    initialStatus: initial.status,
    conditionalStatus: conditional.status,
    etag,
    link: initial.headers.get('link'),
    value,
  };
}

function expandCollectionId(template: string, collectionId: string): string {
  if ((template.match(/\{collectionId\}/gu) ?? []).length !== 1) {
    throw new TypeError('Publication endpoint must contain exactly one collectionId variable');
  }
  return template.replace('{collectionId}', encodeURIComponent(collectionId));
}

async function bootstrapFixtureCollection(
  runtime: DatabaseRuntime,
  collectionId: string,
  rootNodeId: string,
): Promise<void> {
  await createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
    await bootstrapCanonicalOwnedCollection(
      createPostgresCollectionsWritePorts(transaction),
      {
        actor: conformanceActor(),
        collectionId,
        rootNodeId,
        operationId: canonicalOpaqueId(randomUUID()),
        domainEventId: canonicalOpaqueId(randomUUID()),
        outboxId: canonicalOpaqueId(randomUUID()),
        title: 'COLP conformance fixture',
        summary: null,
        kind: 'bookmarks',
        resourceRevision: revision(),
        contentRevision: revision(),
        policyRevision: revision(),
        rootResourceRevision: revision(),
        rootChildrenRevision: revision(),
      },
    );
  });
}

async function applyNodeCreate(
  runtime: DatabaseRuntime,
  input: {
    readonly collectionId: string;
    readonly nodeId: string;
    readonly parentId: string;
    readonly kind: 'folder' | 'bookmark';
    readonly title: string;
    readonly url: string | null;
    readonly extensions: JsonObject;
  },
): Promise<void> {
  await applyCanonicalMutation(runtime, {
    operationId: canonicalOpaqueId(randomUUID()),
    collectionId: input.collectionId,
    actor: conformanceActor(),
    mutation: {
      action: 'create',
      target: {
        collectionId: input.collectionId,
        resourceId: input.nodeId,
        resourceKind: 'node',
      },
      parentId: input.parentId,
      fields: {
        kindFields: {
          kind: input.kind,
          title: input.title,
          url: input.url,
          description: null,
          tags: [],
          visibility: 'inherit',
        },
        extensions: input.extensions,
      },
    },
  });
}

async function applyCanonicalMutation(
  runtime: DatabaseRuntime,
  input: CanonicalMutationInput,
) {
  return createUnitOfWork(runtime.db).execute(async ({ transaction }) =>
    createCanonicalMutationApplication(
      createPostgresCanonicalMutationPorts(transaction),
    ).execute({ transaction }, input));
}

async function findLiveNodeCollection(
  runtime: DatabaseRuntime,
  nodeId: string,
): Promise<string> {
  const row = await runtime.db.selectFrom('nodes')
    .select(['collection_id', 'deleted_at'])
    .where('id', '=', nodeId)
    .executeTakeFirst();
  if (!row || row.deleted_at !== null) throw new Error(`Conformance Node ${nodeId} is missing`);
  return row.collection_id;
}

function conformanceActor() {
  return Object.freeze({
    principalId: LEDGER_PRINCIPAL,
    principalType: 'account',
    subjectId: CONFORMANCE_SUBJECT,
  } as const);
}

function deterministicUuid(value: string): string {
  const bytes = createHash('sha256').update(value, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type ProbeIdentityScope = 'collection' | 'node';

interface ProbeIdentityMap {
  storage(scope: ProbeIdentityScope, logicalId: string): string;
  logical(scope: ProbeIdentityScope, storageId: string): string;
}

function createProbeIdentityMap(): ProbeIdentityMap {
  const forward = new Map<string, string>();
  const reverse = new Map<string, string>();
  return Object.freeze({
    storage(scope: ProbeIdentityScope, logicalId: string) {
      const key = `${scope}\0${logicalId}`;
      const existing = forward.get(key);
      if (existing) return existing;
      const storageId = canonicalOpaqueId(key);
      const collision = reverse.get(`${scope}\0${storageId}`);
      if (collision && collision !== logicalId) throw new Error('Conformance identity mapping collided');
      forward.set(key, storageId);
      reverse.set(`${scope}\0${storageId}`, logicalId);
      return storageId;
    },
    logical(scope: ProbeIdentityScope, storageId: string) {
      const logicalId = reverse.get(`${scope}\0${storageId}`);
      if (!logicalId) throw new Error('Conformance identity mapping is missing');
      return logicalId;
    },
  });
}

function canonicalOpaqueId(value: string): string {
  return createHash('sha256').update(`known-conformance\0${value}`, 'utf8')
    .digest().subarray(0, 16).toString('base64url');
}

function revision(): string {
  return `revision-${randomUUID()}`;
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactHttpUrl(value: string, label: string): URL {
  try {
    const url = new URL(nonEmpty(value, label));
    if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) throw new Error();
    return url;
  } catch {
    throw new TypeError(`${label} must be a safe absolute HTTP URL`);
  }
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function assertOpen(closed: boolean): void {
  if (closed) throw new Error('Phase 2 Profile conformance deployment is closed');
}

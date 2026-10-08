import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import {
  createLoopbackEgressPolicy,
  ColpClient,
  type FetchImplementation,
} from '@know-n/colp/client';
import {
  DEFAULT_PUBLICATION_DIRECTORY_SORT,
  createPublicationDirectoryFilterDigest,
} from '@know-n/colp/server';
import type {
  CollectionMetadata,
  Manifest,
  Snapshot,
} from '@know-n/colp/types';
import type { AppConfig } from '../../src/bootstrap/config.js';
import { buildWorker } from '../../src/bootstrap/worker.js';
import { buildApiApp } from '../../src/transport/app.js';
import { createMemorySearchRateLimiter } from '../../src/transport/http-security.js';
import type { DatabaseRuntime } from '../../src/infrastructure/database/index.js';
import { createPostgresCanonicalMutationUnitOfWork } from '../../src/infrastructure/collections/index.js';
import {
  PUBLICATION_CACHE_PURGE_HANDLER_NAME,
  PublicationCachePurgeProviderError,
} from '../../src/infrastructure/outbox/index.js';
import { InMemoryMetrics } from '../../src/infrastructure/telemetry/index.js';
import { createPostgresPublicationMetadataReadPort } from '../../src/infrastructure/publication/index.js';
import {
  createPublicationCursorKeyring,
} from '../../src/modules/publication/index.js';
import {
  generateRevisionToken,
  updateCollectionMetadataCanonical,
} from '../../src/modules/collections/index.js';
import {
  POSTGRES_PUBLICATION_ENTRY_TARGET,
  runPostgresPublicationEntryEvidence,
} from '../evidence/postgres-publication-entry.js';

export const PHASE2_PUBLICATION_ACCEPTANCE_FORMAT = 'known.phase2.publication-acceptance.v1';
// COLP Server: Know-N's real-stack browser probe drives Know-N's web e2e,
// which this package does not ship; the web build has its own tests and the
// live smoke. Every server-side probe below stays required.
export const PHASE2_PUBLICATION_REQUIRED_PROBES = Object.freeze([
  'cachePartition',
  'cursorRotationRestart',
  'mutationFences',
  'goneRetention',
  'purgeTelemetry',
] as const);

export type Phase2PublicationRequiredProbe =
  (typeof PHASE2_PUBLICATION_REQUIRED_PROBES)[number];

export type Phase2JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly Phase2JsonValue[]
  | { readonly [key: string]: Phase2JsonValue };

export interface Phase2RequiredProbeResult {
  readonly passed: true;
  readonly detail: Phase2JsonValue;
}

export interface Phase2PostgresEvidence {
  readonly engine: 'postgresql';
  readonly version: string;
  readonly database: string;
}

export interface Phase2PostgresProbe {
  verify(): Promise<Phase2PostgresEvidence>;
}

export interface Phase2PublicationDeploymentTargetOptions {
  readonly manifestUrl: string;
  readonly sourceRevision: string;
  readonly sourceDigest: string;
  readonly collectionId: string;
  readonly postgres: Phase2PostgresProbe;
  readonly fetch?: FetchImplementation;
  readonly probeSuite?: Phase2PublicationDeploymentProbeSuite;
  /** Test-only seams. Formal acceptance rejects targets built from these callbacks. */
  readonly cachePartitionProbe?: () => Promise<Phase2RequiredProbeResult>;
  readonly cursorRotationRestartProbe?: () => Promise<Phase2RequiredProbeResult>;
  readonly mutationFenceProbe?: () => Promise<Phase2RequiredProbeResult>;
  readonly goneRetentionProbe?: () => Promise<Phase2RequiredProbeResult>;
  readonly purgeTelemetryProbe?: () => Promise<Phase2RequiredProbeResult>;
}

export interface Phase2PublicationDeploymentProbeSuite {
  readonly probes: Readonly<Record<
    Phase2PublicationRequiredProbe,
    () => Promise<Phase2RequiredProbeResult>
  >>;
}

export interface KnownPhase2DeploymentProbeSuiteOptions {
  readonly runtime: DatabaseRuntime;
  readonly config: AppConfig;
  readonly origin: string;
  readonly collectionId: string;
  readonly publicationSlug: string;
  /** Real session Authorization/Cookie headers; their values are never emitted. */
  readonly memberHeaders: Readonly<Record<string, string>>;
  readonly fetch?: FetchImplementation;
  readonly publicationThresholdsPath?: string;
}

export interface Phase2PublicationDeploymentTarget {
  readonly manifestUrl: string;
  readonly sourceRevision: string;
  readonly sourceDigest: string;
  readonly collectionId: string;
  readonly postgres: Phase2PostgresProbe;
  readonly fetch: FetchImplementation;
  readonly probes: Readonly<Record<
    Phase2PublicationRequiredProbe,
    () => Promise<Phase2RequiredProbeResult>
  >>;
}

export interface Phase2PublicationAcceptanceExpectations {
  /** Exact assembled node count. Acceptance evidence must exercise at least 10k nodes. */
  readonly expectedSnapshotNodes: number;
  readonly maxRequestP95Ms: number;
  readonly maxSnapshotTraversalMs: number;
}

export interface Phase2HttpRequestEvidence {
  readonly phase: 'raw' | 'colp-client';
  readonly method: string;
  readonly url: string;
  readonly status: number;
  readonly durationMs: number;
  readonly etag: string | null;
  readonly cacheControl: string | null;
  readonly vary: string | null;
  readonly link: string | null;
}

export interface Phase2PublicationAcceptanceEvidence {
  readonly evidence: 'phase2_publication_black_box_acceptance';
  readonly format: typeof PHASE2_PUBLICATION_ACCEPTANCE_FORMAT;
  readonly sourceRevision: string;
  readonly sourceDigest: string;
  readonly generatedAt: string;
  readonly target: {
    readonly origin: string;
    readonly manifestUrl: string;
    readonly collectionId: string;
    readonly postgres: Phase2PostgresEvidence;
  };
  readonly manifest: {
    readonly serverUuid: string;
    readonly mountId: string;
    readonly deployedProfiles: readonly string[];
    readonly claimedPublication: boolean;
    readonly endpoints: {
      readonly directory: string;
      readonly collection: string;
      readonly snapshot: string;
    };
    readonly conditional: {
      readonly getStatus: 200;
      readonly headStatus: 200;
      readonly notModifiedStatus: 304;
      readonly etag: string;
      readonly cacheControl: string;
    };
  };
  readonly clientChallenge: {
    readonly applied: boolean;
    readonly addedProfile: 'publication' | null;
  };
  readonly traversal: {
    readonly directoryCollectionCount: number;
    readonly directoryContainsTarget: true;
    readonly metadataCollectionId: string;
    readonly snapshotCollectionId: string;
    readonly snapshotNodeCount: number;
    readonly snapshotHttpPages: number;
  };
  readonly cache: {
    readonly manifestRevalidated: true;
    readonly publicResponsesHaveCachePolicy: true;
    readonly endpointConditionals: Readonly<Record<
      'manifest' | 'directory' | 'metadata' | 'snapshot',
      {
        readonly getStatus: 200;
        readonly headStatus: 200;
        readonly notModifiedStatus: 304;
        readonly etag: string;
      }
    >>;
  };
  readonly latency: {
    readonly requestCount: number;
    readonly requestP50Ms: number;
    readonly requestP95Ms: number;
    readonly requestMaxMs: number;
    readonly snapshotTraversalMs: number;
    readonly thresholds: Phase2PublicationAcceptanceExpectations;
  };
  readonly probes: Readonly<Record<Phase2PublicationRequiredProbe, {
    readonly passed: true;
    readonly durationMs: number;
    readonly detail: Phase2JsonValue;
  }>>;
  readonly requests: readonly Phase2HttpRequestEvidence[];
  readonly accepted: true;
  /** SHA-256 over the canonical JSON evidence payload before this field is added. */
  readonly evidenceDigest: string;
}

export interface Phase2PublicationChallengeState {
  applied: boolean;
}

interface RawManifestProbe {
  readonly manifest: Manifest;
  readonly mount: Manifest['mounts'][number];
  readonly endpoints: {
    readonly directory: string;
    readonly collection: string;
    readonly snapshot: string;
  };
  readonly etag: string;
  readonly cacheControl: string;
}

const knownDeploymentProbeSuites = new WeakSet<object>();
const acceptanceDeploymentTargets = new WeakSet<object>();

/** Internal authority grant used only by the repo-owned Known deployment probe composition. */
function authorizeKnownPhase2DeploymentProbeSuite(
  suite: Phase2PublicationDeploymentProbeSuite,
): Phase2PublicationDeploymentProbeSuite {
  knownDeploymentProbeSuites.add(suite);
  return suite;
}

/**
 * Repo-owned probe composition. Each pass is derived from production HTTP,
 * cursor, PostgreSQL, canonical mutation, worker, provider, and metrics code.
 */
export function createKnownPhase2DeploymentProbeSuite(
  options: KnownPhase2DeploymentProbeSuiteOptions,
): Phase2PublicationDeploymentProbeSuite {
  const origin = exactOrigin(options.origin);
  const collectionId = nonEmpty(options.collectionId, 'collectionId');
  const publicationSlug = nonEmpty(options.publicationSlug, 'publicationSlug');
  if (collectionId !== POSTGRES_PUBLICATION_ENTRY_TARGET.collectionId) {
    throw new Error(
      `Known Phase 2 probes require the canonical 10k fixture ${POSTGRES_PUBLICATION_ENTRY_TARGET.collectionId}`,
    );
  }
  if (!options.memberHeaders || Object.keys(options.memberHeaders).length === 0) {
    throw new TypeError('Known Phase 2 cache probes require real member credentials');
  }
  const implementation = options.fetch ?? globalThis.fetch;
  const probes: Phase2PublicationDeploymentProbeSuite['probes'] = Object.freeze({
    cachePartition: async () => cachePartitionProbe(
      implementation,
      origin,
      collectionId,
      publicationSlug,
      options.memberHeaders,
    ),
    cursorRotationRestart: async () => cursorRotationRestartProbe(),
    mutationFences: async () => mutationFenceProbe(
      options.runtime,
      options.publicationThresholdsPath,
    ),
    goneRetention: async () => goneRetentionProbe(
      options.runtime,
      implementation,
      origin,
      options.config,
    ),
    purgeTelemetry: async () => purgeTelemetryProbe(
      options.runtime,
      options.config,
      collectionId,
    ),
  });
  return authorizeKnownPhase2DeploymentProbeSuite(Object.freeze({ probes }));
}

interface ConditionalEndpointEvidence {
  readonly getStatus: 200;
  readonly headStatus: 200;
  readonly notModifiedStatus: 304;
  readonly etag: string;
}

/**
 * Closes the deployment port up front. A missing probe is a configuration
 * failure, not a skipped acceptance probe.
 */
export function createPhase2DeploymentTarget(
  options: Phase2PublicationDeploymentTargetOptions,
): Phase2PublicationDeploymentTarget {
  const manifestUrl = exactManifestUrl(options.manifestUrl);
  const sourceRevision = nonEmpty(options.sourceRevision, 'sourceRevision');
  const sourceDigest = sha256Hex(options.sourceDigest, 'sourceDigest');
  const collectionId = nonEmpty(options.collectionId, 'collectionId');
  if (!options.postgres || typeof options.postgres.verify !== 'function') {
    throw new TypeError('Phase 2 acceptance requires a PostgreSQL readiness probe');
  }
  if (options.fetch !== undefined && typeof options.fetch !== 'function') {
    throw new TypeError('Phase 2 acceptance fetch adapter must be a function');
  }
  const callbackEntries: ReadonlyArray<readonly [
    Phase2PublicationRequiredProbe,
    (() => Promise<Phase2RequiredProbeResult>) | undefined,
  ]> = [
    ['cachePartition', options.cachePartitionProbe],
    ['cursorRotationRestart', options.cursorRotationRestartProbe],
    ['mutationFences', options.mutationFenceProbe],
    ['goneRetention', options.goneRetentionProbe],
    ['purgeTelemetry', options.purgeTelemetryProbe],
  ];
  const suite = options.probeSuite;
  const probeEntries = suite
    ? PHASE2_PUBLICATION_REQUIRED_PROBES.map((name) => [name, suite.probes[name]] as const)
    : callbackEntries;
  for (const [name, probe] of probeEntries) {
    if (typeof probe !== 'function') {
      throw new TypeError(`Phase 2 acceptance requires the ${name} probe`);
    }
  }
  const probes = Object.freeze(Object.fromEntries(probeEntries)) as Readonly<Record<
    Phase2PublicationRequiredProbe,
    () => Promise<Phase2RequiredProbeResult>
  >>;
  const postgres = Object.freeze({
    verify: () => options.postgres.verify(),
  });
  const target = Object.freeze({
    manifestUrl: manifestUrl.href,
    sourceRevision,
    sourceDigest,
    collectionId,
    postgres,
    fetch: options.fetch ?? globalThis.fetch,
    probes,
  });
  if (suite && knownDeploymentProbeSuites.has(suite)) acceptanceDeploymentTargets.add(target);
  return target;
}

/**
 * P2-16 must exercise the real client before P2-17 is allowed to publish a
 * profile claim. This fetch wrapper challenges only the client's detached
 * Manifest response by adding `publication`; it never changes the deployment
 * response. The evidence records whether the challenge was required.
 */
export function createUnclaimedPublicationChallengeFetch(
  manifestUrl: string,
  implementation: FetchImplementation = globalThis.fetch,
  state: Phase2PublicationChallengeState = { applied: false },
): FetchImplementation {
  const expected = exactManifestUrl(manifestUrl).href;
  return async (input, init) => {
    const response = await implementation(input, init);
    const requestUrl = new URL(input instanceof Request ? input.url : input).href;
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (requestUrl !== expected || method !== 'GET' || response.status !== 200) return response;

    const manifest = JSON.parse(await response.text()) as Manifest;
    const mount = selectCompletePublicationMount(manifest);
    if (!mount.profiles.includes('publication')) {
      mount.profiles.push('publication');
      state.applied = true;
    }
    const body = JSON.stringify(manifest);
    const headers = new Headers(response.headers);
    headers.set('content-length', String(Buffer.byteLength(body, 'utf8')));
    // The challenge representation is process-local and must not reuse the
    // deployment representation validator.
    headers.delete('etag');
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}

export async function runPhase2PublicationAcceptance(
  target: Phase2PublicationDeploymentTarget,
  expectations: Phase2PublicationAcceptanceExpectations,
): Promise<Phase2PublicationAcceptanceEvidence> {
  const thresholds = validateExpectations(expectations);
  const generatedAt = new Date().toISOString();
  const postgres = await target.postgres.verify();
  assertPostgresEvidence(postgres);
  if (!acceptanceDeploymentTargets.has(target)) {
    throw new Error(
      'Phase 2 formal acceptance requires the repo-owned Known deployment probe composition',
    );
  }

  const requests: Phase2HttpRequestEvidence[] = [];
  const rawFetch = traceFetch('raw', target.fetch, requests);
  const raw = await probeManifest(target.manifestUrl, rawFetch);
  if (raw.mount.profiles.includes('publication')) {
    throw new Error('P2-16 refuses a deployment that claims publication before the P2-17 evidence gate');
  }
  const challengeState: Phase2PublicationChallengeState = { applied: false };
  const challenged = createUnclaimedPublicationChallengeFetch(
    target.manifestUrl,
    target.fetch,
    challengeState,
  );
  const clientFetch = traceFetch('colp-client', challenged, requests);
  // @know-n/colp 0.1.1 refuses loopback hosts after the first hop unless an
  // egress policy allows them; a local target pages its Snapshot on loopback.
  const loopbackTarget = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(target.manifestUrl).hostname);
  const client = new ColpClient({
    manifestUrl: target.manifestUrl,
    fetch: clientFetch,
    ...(loopbackTarget ? { egressPolicy: createLoopbackEgressPolicy([target.manifestUrl]) } : {}),
    snapshotLimits: {
      maxPages: 1_000,
      maxBytes: 128 * 1024 * 1024,
      maxObjects: Math.max(100_001, thresholds.expectedSnapshotNodes + 1_000),
      timeoutMs: Math.max(30_000, Math.ceil(thresholds.maxSnapshotTraversalMs * 2)),
    },
  });

  await client.discover();
  if (!challengeState.applied) {
    throw new Error('P2-16 COLP client challenge was not applied to the unclaimed Manifest');
  }
  const directory = await client.getDirectory({ limit: 500 });
  const targetDirectoryEntry = directory.collections.find(
    (collection) => collection.id === target.collectionId,
  );
  if (!targetDirectoryEntry) {
    throw new Error(`COLP Directory did not enumerate required public Collection ${target.collectionId}`);
  }
  const metadata = await client.getCollection(target.collectionId);
  assertMetadataTarget(metadata, target.collectionId);
  const snapshotStarted = performance.now();
  const snapshot = await client.getSnapshot(target.collectionId, { limit: 500 });
  const snapshotTraversalMs = performance.now() - snapshotStarted;
  assertSnapshotTarget(snapshot, target.collectionId, thresholds.expectedSnapshotNodes);

  const snapshotUrl = expandCollectionEndpoint(raw.endpoints.snapshot, target.collectionId);
  const snapshotHttpPages = requests.filter((request) =>
    request.phase === 'colp-client'
      && request.method === 'GET'
      && request.status === 200
      && request.url.split('?', 1)[0] === snapshotUrl).length;
  if (snapshotHttpPages < 2) {
    throw new Error('Phase 2 acceptance requires a genuinely multi-page COLP Snapshot traversal');
  }

  const directoryConditionalUrl = new URL(raw.endpoints.directory);
  directoryConditionalUrl.searchParams.set('limit', '500');
  const endpointConditionals = Object.freeze({
    manifest: Object.freeze({
      getStatus: 200 as const,
      headStatus: 200 as const,
      notModifiedStatus: 304 as const,
      etag: raw.etag,
    }),
    directory: await probeConditionalEndpoint(rawFetch, {
      name: 'Directory',
      url: directoryConditionalUrl.href,
      accept: 'application/vnd.collection-protocol.catalog+json;version=0.1',
    }),
    metadata: await probeConditionalEndpoint(rawFetch, {
      name: 'Metadata',
      url: expandCollectionEndpoint(raw.endpoints.collection, target.collectionId),
      accept: 'application/vnd.collection-protocol.collection+json;version=0.1',
    }),
    snapshot: await probeConditionalEndpoint(rawFetch, {
      name: 'Snapshot',
      url: `${snapshotUrl}?limit=500`,
      accept: 'application/vnd.collection-protocol.snapshot+json;version=0.1',
    }),
  });

  const publicReads = requests.filter((request) =>
    request.status === 200 && (request.phase === 'raw' || request.phase === 'colp-client'));
  if (publicReads.length === 0 || publicReads.some((request) => !request.cacheControl)) {
    throw new Error('A public Manifest/Directory/Metadata/Snapshot response omitted Cache-Control');
  }

  const probeEvidence = {} as Record<Phase2PublicationRequiredProbe, {
    passed: true;
    durationMs: number;
    detail: Phase2JsonValue;
  }>;
  for (const name of PHASE2_PUBLICATION_REQUIRED_PROBES) {
    const started = performance.now();
    const outcome = await target.probes[name]();
    const durationMs = performance.now() - started;
    if (!outcome || outcome.passed !== true || !Object.hasOwn(outcome, 'detail')) {
      throw new Error(`Required Phase 2 ${name} probe did not return an explicit pass`);
    }
    assertJsonValue(outcome.detail, `probes.${name}.detail`);
    probeEvidence[name] = Object.freeze({
      passed: true,
      durationMs,
      detail: immutableJson(outcome.detail),
    });
  }

  const latencies = requests.map((request) => request.durationMs);
  const requestP50Ms = percentile(latencies, 0.5);
  const requestP95Ms = percentile(latencies, 0.95);
  const requestMaxMs = Math.max(...latencies);
  if (requestP95Ms > thresholds.maxRequestP95Ms) {
    throw new Error(
      `Phase 2 request p95 ${requestP95Ms.toFixed(2)}ms exceeds ${thresholds.maxRequestP95Ms}ms`,
    );
  }
  if (snapshotTraversalMs > thresholds.maxSnapshotTraversalMs) {
    throw new Error(
      `Phase 2 Snapshot traversal ${snapshotTraversalMs.toFixed(2)}ms exceeds ${thresholds.maxSnapshotTraversalMs}ms`,
    );
  }

  const payload = {
    evidence: 'phase2_publication_black_box_acceptance' as const,
    format: PHASE2_PUBLICATION_ACCEPTANCE_FORMAT,
    sourceRevision: target.sourceRevision,
    sourceDigest: target.sourceDigest,
    generatedAt,
    target: {
      origin: new URL(target.manifestUrl).origin,
      manifestUrl: target.manifestUrl,
      collectionId: target.collectionId,
      postgres: immutableJson(postgres),
    },
    manifest: {
      serverUuid: raw.manifest.serverUuid,
      mountId: raw.mount.id,
      deployedProfiles: Object.freeze([...raw.mount.profiles]),
      claimedPublication: raw.mount.profiles.includes('publication'),
      endpoints: raw.endpoints,
      conditional: {
        getStatus: 200 as const,
        headStatus: 200 as const,
        notModifiedStatus: 304 as const,
        etag: raw.etag,
        cacheControl: raw.cacheControl,
      },
    },
    clientChallenge: {
      applied: challengeState.applied,
      addedProfile: challengeState.applied ? 'publication' as const : null,
    },
    traversal: {
      directoryCollectionCount: directory.collections.length,
      directoryContainsTarget: true as const,
      metadataCollectionId: metadata.collection.id,
      snapshotCollectionId: snapshot.collection.id,
      snapshotNodeCount: snapshot.nodes.length,
      snapshotHttpPages,
    },
    cache: {
      manifestRevalidated: true as const,
      publicResponsesHaveCachePolicy: true as const,
      endpointConditionals,
    },
    latency: {
      requestCount: requests.length,
      requestP50Ms,
      requestP95Ms,
      requestMaxMs,
      snapshotTraversalMs,
      thresholds,
    },
    probes: Object.freeze(probeEvidence),
    requests: Object.freeze(requests.map((request) => Object.freeze({ ...request }))),
    accepted: true as const,
  };
  const evidenceDigest = createHash('sha256')
    .update(canonicalJson(payload), 'utf8')
    .digest('base64url');
  return deepFreeze({ ...payload, evidenceDigest }) as Phase2PublicationAcceptanceEvidence;
}

async function probeManifest(
  manifestUrl: string,
  implementation: FetchImplementation,
): Promise<RawManifestProbe> {
  const headers = {
    accept: 'application/vnd.collection-protocol.manifest+json;version=0.1',
    'collection-protocol-version': '0.1',
  };
  const get = await implementation(manifestUrl, { method: 'GET', headers });
  if (get.status !== 200) throw new Error(`Manifest GET failed with HTTP ${get.status}`);
  const etag = get.headers.get('etag');
  const cacheControl = get.headers.get('cache-control');
  if (!etag) throw new Error('Manifest GET omitted ETag');
  if (!cacheControl?.toLowerCase().includes('public')) {
    throw new Error('Manifest GET omitted an explicit public cache policy');
  }
  const manifest = await get.json() as Manifest;
  const mount = selectCompletePublicationMount(manifest);
  const endpoints = validateDeclaredEndpoints(mount, new URL(manifestUrl).origin);

  const head = await implementation(manifestUrl, { method: 'HEAD', headers });
  if (head.status !== 200 || (await head.text()).length !== 0) {
    throw new Error('Manifest HEAD must return HTTP 200 with an empty body');
  }
  const conditional = await implementation(manifestUrl, {
    method: 'GET',
    headers: { ...headers, 'if-none-match': etag },
  });
  if (conditional.status !== 304 || (await conditional.text()).length !== 0) {
    throw new Error('Manifest conditional GET must return HTTP 304 with an empty body');
  }
  return { manifest, mount, endpoints, etag, cacheControl };
}

async function probeConditionalEndpoint(
  implementation: FetchImplementation,
  input: { readonly name: string; readonly url: string; readonly accept: string },
): Promise<ConditionalEndpointEvidence> {
  const headers = {
    accept: input.accept,
    'collection-protocol-version': '0.1',
  };
  const get = await implementation(input.url, { method: 'GET', headers });
  if (get.status !== 200) throw new Error(`${input.name} GET failed with HTTP ${get.status}`);
  const etag = get.headers.get('etag');
  if (!etag) throw new Error(`${input.name} GET omitted ETag`);
  if (!get.headers.get('cache-control')) throw new Error(`${input.name} GET omitted Cache-Control`);
  await get.arrayBuffer();

  const head = await implementation(input.url, { method: 'HEAD', headers });
  if (head.status !== 200 || (await head.text()).length !== 0) {
    throw new Error(`${input.name} HEAD must return HTTP 200 with an empty body`);
  }
  const conditional = await implementation(input.url, {
    method: 'GET',
    headers: { ...headers, 'if-none-match': etag },
  });
  if (conditional.status !== 304 || (await conditional.text()).length !== 0) {
    throw new Error(`${input.name} conditional GET must return HTTP 304 with an empty body`);
  }
  return Object.freeze({
    getStatus: 200 as const,
    headStatus: 200 as const,
    notModifiedStatus: 304 as const,
    etag,
  });
}

function traceFetch(
  phase: Phase2HttpRequestEvidence['phase'],
  implementation: FetchImplementation,
  sink: Phase2HttpRequestEvidence[],
): FetchImplementation {
  return async (input, init) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const url = new URL(input instanceof Request ? input.url : input).href;
    const started = performance.now();
    const response = await implementation(input, init);
    sink.push({
      phase,
      method,
      url,
      status: response.status,
      durationMs: performance.now() - started,
      etag: response.headers.get('etag'),
      cacheControl: response.headers.get('cache-control'),
      vary: response.headers.get('vary'),
      link: response.headers.get('link'),
    });
    return response;
  };
}

function selectCompletePublicationMount(manifest: Manifest): Manifest['mounts'][number] {
  if (!manifest || !Array.isArray(manifest.mounts)) throw new Error('Manifest mounts are missing');
  const candidates = manifest.mounts.filter((mount) =>
    mount.profiles.includes('core')
      && typeof mount.endpoints.directory === 'string'
      && typeof mount.endpoints.collection === 'string'
      && typeof mount.endpoints.snapshot === 'string');
  if (candidates.length !== 1) {
    throw new Error('Manifest must expose exactly one complete core Publication mount');
  }
  return candidates[0]!;
}

function validateDeclaredEndpoints(
  mount: Manifest['mounts'][number],
  expectedOrigin: string,
): RawManifestProbe['endpoints'] {
  const output = {} as Record<'directory' | 'collection' | 'snapshot', string>;
  for (const name of ['directory', 'collection', 'snapshot'] as const) {
    const declaration = mount.endpoints[name];
    if (typeof declaration !== 'string') throw new Error(`Manifest endpoint ${name} is missing`);
    const expanded = declaration.replace('{collectionId}', 'acceptance-target');
    let endpoint: URL;
    try {
      endpoint = new URL(expanded);
    } catch {
      throw new Error(`Manifest endpoint ${name} is not absolute`);
    }
    if (endpoint.origin !== expectedOrigin || endpoint.username || endpoint.password || endpoint.hash) {
      throw new Error(`Manifest endpoint ${name} escaped the deployment origin`);
    }
    output[name] = declaration;
  }
  return Object.freeze(output);
}

function assertMetadataTarget(metadata: CollectionMetadata, collectionId: string): void {
  if (metadata.collection.id !== collectionId) {
    throw new Error('COLP Metadata did not describe the Directory target');
  }
}

function assertSnapshotTarget(
  snapshot: Snapshot,
  collectionId: string,
  expectedNodes: number,
): void {
  if (snapshot.collection.id !== collectionId) {
    throw new Error('COLP Snapshot did not describe the Metadata target');
  }
  if (snapshot.nodes.length !== expectedNodes) {
    throw new Error(
      `COLP Snapshot returned ${snapshot.nodes.length} nodes; expected exactly ${expectedNodes}`,
    );
  }
}

async function cachePartitionProbe(
  implementation: FetchImplementation,
  origin: string,
  collectionId: string,
  publicationSlug: string,
  memberHeaders: Readonly<Record<string, string>>,
): Promise<Phase2RequiredProbeResult> {
  const credentialNames = Object.keys(memberHeaders).map((name) => name.toLowerCase());
  if (!credentialNames.includes('cookie') && !credentialNames.includes('authorization')) {
    throw new Error('Member cache probe requires Cookie or Authorization credentials');
  }
  const url = `${origin}/colp/v0.1/collections/${encodeURIComponent(collectionId)}`;
  const common = {
    accept: 'application/vnd.collection-protocol.collection+json;version=0.1',
    'collection-protocol-version': '0.1',
  };
  const anonymous = await implementation(url, { headers: common });
  const member = await implementation(url, { headers: { ...common, ...memberHeaders } });
  const [anonymousBody] = await Promise.all([
    anonymous.json() as Promise<CollectionMetadata>,
    member.arrayBuffer(),
  ]);
  const anonymousCache = anonymous.headers.get('cache-control') ?? '';
  const memberCache = member.headers.get('cache-control') ?? '';
  const memberVary = member.headers.get('vary') ?? '';
  const anonymousEtag = anonymous.headers.get('etag');
  const memberEtag = member.headers.get('etag');
  if (anonymous.status !== 200 || member.status !== 200
      || anonymousBody.collection.id !== collectionId
      || anonymousBody.collection.slug !== publicationSlug
      || !anonymousCache.toLowerCase().includes('public')
      || !memberCache.toLowerCase().includes('private')
      || !memberCache.toLowerCase().includes('no-store')
      || !/(?:^|,)\s*(?:cookie|authorization)\s*(?:,|$)/iu.test(memberVary)
      || !anonymousEtag || !memberEtag || anonymousEtag === memberEtag) {
    throw new Error('Real HTTP responses did not prove anonymous/member cache partitioning');
  }
  return passedProbe({
    anonymous: { status: 200, cacheControl: anonymousCache, etag: anonymousEtag },
    member: { status: 200, cacheControl: memberCache, vary: memberVary, etag: memberEtag },
    isolated: true,
  });
}

async function cursorRotationRestartProbe(): Promise<Phase2RequiredProbeResult> {
  const oldSecret = Buffer.alloc(32, 83).toString('base64');
  const currentSecret = Buffer.alloc(32, 89).toString('base64');
  // @know-n/colp 0.1.1 binds cursors to the collection and the endpoint.
  const snapshotContext = {
    collectionId: 'acceptance-collection',
    resourceId: 'https://colp.example/colp/v0.1/collections/acceptance-collection/snapshot',
    revision: 'content.policy',
    comparatorVersion: 'parent-position-id-v1',
    principal: 'anonymous',
    pageSize: 100,
  };
  const directoryContext = {
    resourceId: 'https://colp.example/colp/v0.1/collections',
    principal: 'anonymous',
    filterDigest: createPublicationDirectoryFilterDigest({}),
    sort: DEFAULT_PUBLICATION_DIRECTORY_SORT,
    limit: 100,
    protocolVersion: '0.1',
  };
  const old = createPublicationCursorKeyring({
    active: { id: 'acceptance-v1', secret: oldSecret },
    retained: [],
  });
  const oldCursor = old.snapshot.sign({ ...snapshotContext, nextPosition: 'after-v1' });
  old.destroy();
  const rotated = createPublicationCursorKeyring({
    active: { id: 'acceptance-v2', secret: currentSecret },
    retained: [{ id: 'acceptance-v1', secret: oldSecret }],
  });
  const retained = rotated.snapshot.verify(oldCursor, snapshotContext);
  const crossPurpose = rotated.directory.verify(oldCursor, directoryContext);
  const currentCursor = rotated.snapshot.sign({ ...snapshotContext, nextPosition: 'after-v2' });
  rotated.destroy();
  const restarted = createPublicationCursorKeyring({
    active: { id: 'acceptance-v2', secret: currentSecret },
    retained: [{ id: 'acceptance-v1', secret: oldSecret }],
  });
  const restartCurrent = restarted.snapshot.verify(currentCursor, snapshotContext);
  const restartRetained = restarted.snapshot.verify(oldCursor, snapshotContext);
  restarted.destroy();
  const retired = createPublicationCursorKeyring({
    active: { id: 'acceptance-v2', secret: currentSecret },
    retained: [],
  });
  const retirement = retired.snapshot.verify(oldCursor, snapshotContext);
  retired.destroy();
  if (!retained.valid || crossPurpose.valid || !restartCurrent.valid
      || !restartRetained.valid || retirement.valid) {
    throw new Error('Production Publication keyring failed rotation/restart/retirement isolation');
  }
  return passedProbe({
    activeKey: 'acceptance-v2',
    retainedKey: 'acceptance-v1',
    retainedCursorAccepted: true,
    restartVerified: true,
    retiredCursorRejected: true,
    crossPurposeRejected: true,
  });
}

async function mutationFenceProbe(
  runtime: DatabaseRuntime,
  thresholdsPath?: string,
): Promise<Phase2RequiredProbeResult> {
  const evidence = await runPostgresPublicationEntryEvidence(runtime, {
    seedFixture: false,
    ...(thresholdsPath ? { thresholdsPath } : {}),
  });
  if (!evidence.pass.overall
      || evidence.fences.contentRevision !== 'snapshot_expired'
      || evidence.fences.policyRevision !== 'snapshot_expired') {
    throw new Error('PostgreSQL Publication mutation/fence evidence did not pass');
  }
  return passedProbe({
    contentRevision: evidence.fences.contentRevision,
    policyRevision: evidence.fences.policyRevision,
    tamperedCursor: evidence.fences.tamperedCursor,
    exactTraversal: evidence.pass.exactTraversal,
    schemaAndSemantics: evidence.pass.schemaAndSemantics,
    pageP95Ms: evidence.traversal.pageLatencyMs.p95,
    fullTraversalMs: evidence.traversal.elapsedMs,
  });
}

async function goneRetentionProbe(
  runtime: DatabaseRuntime,
  implementation: FetchImplementation,
  origin: string,
  config: AppConfig,
): Promise<Phase2RequiredProbeResult> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const collectionId = randomBytes(16).toString('base64url');
  const publicationSlug = `phase2-gone-${suffix}`;
  const rootId = `${collectionId}-root`;
  const deletedAt = new Date();
  const client = await runtime.pool.connect();
  try {
    await client.query('begin');
    await client.query('set constraints all deferred');
    await client.query(
      `insert into resource_id_ledger(resource_id, resource_type)
       values ($1, 'collection'), ($2, 'node')`,
      [collectionId, rootId],
    );
    await client.query(
      `insert into collections
        (id, owner_subject_id, title, kind, visibility, root_node_id, resource_revision,
         content_revision, policy_revision, publication_slug, published_at, deleted_at, updated_at)
       values ($1, 'phase2-gone-owner', 'Phase 2 gone evidence', 'bookmarks', 'public',
               $2, 'r1', 'c1', 'p1', $4, $3, $3, $3)`,
      [collectionId, rootId, deletedAt, publicationSlug],
    );
    await client.query(
      `insert into nodes
        (id, collection_id, kind, is_root, title, visibility, resource_revision,
         children_revision, deleted_at)
       values ($1, $2, 'folder', true, 'Phase 2 gone evidence', 'inherit', 'r1', 'ch1', $3)`,
      [rootId, collectionId, deletedAt],
    );
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  const url = `${origin}/c/${publicationSlug}`;
  const tombstoneHeaders = {
    accept: 'application/vnd.collection-protocol.collection+json;version=0.1',
    'collection-protocol-version': '0.1',
  };
  const get = await implementation(url, { method: 'GET', headers: tombstoneHeaders });
  const head = await implementation(url, { method: 'HEAD', headers: tombstoneHeaders });
  const getBody = await get.json() as { code?: unknown };
  if (get.status !== 410 || head.status !== 410 || (await head.text()).length !== 0
      || getBody.code !== 'https://know-n.com/colp/problems/collection-deleted') {
    throw new Error('Real canonical deletion URL did not retain GET/HEAD 410 evidence');
  }
  const restarted = buildApiApp({
    config,
    readiness: runtime,
    exploreDirectoryRateLimiter: createMemorySearchRateLimiter({
      anonymousMaxRequests: 10_000,
      accountMaxRequests: 10_000,
      windowMs: 60_000,
    }),
    publicationMetadataQuery: {
      reads: createPostgresPublicationMetadataReadPort(runtime),
      origin,
    },
  });
  try {
    const restartedGet = await restarted.inject({
      method: 'GET', url: `/c/${publicationSlug}`, headers: tombstoneHeaders,
    });
    const restartedHead = await restarted.inject({
      method: 'HEAD', url: `/c/${publicationSlug}`, headers: tombstoneHeaders,
    });
    if (restartedGet.statusCode !== 410 || restartedHead.statusCode !== 410
        || restartedHead.body !== '') {
      throw new Error('Canonical 410 evidence did not survive a fresh Fastify composition');
    }
  } finally {
    await restarted.close();
  }
  return passedProbe({
    status: 410,
    headStatus: 410,
    retainedDays: 30,
    durableDeletedAt: deletedAt.toISOString(),
    canonicalUrl: url,
    survivedRestart: true,
  });
}

async function purgeTelemetryProbe(
  runtime: DatabaseRuntime,
  config: AppConfig,
  collectionId: string,
): Promise<Phase2RequiredProbeResult> {
  const state = await runtime.pool.query<{
    title: string;
    resource_revision: string;
    owner_subject_id: string;
  }>(
    `select title, resource_revision, owner_subject_id from collections where id = $1`,
    [collectionId],
  );
  const collection = state.rows[0];
  if (!collection) throw new Error('Purge telemetry target Collection is missing');
  const metrics = new InMemoryMetrics();
  const worker = buildWorker(config, runtime, metrics, {
    publicationCachePurgeProvider: {
      async purge() {
        throw new PublicationCachePurgeProviderError(
          'permanent',
          'acceptance provider rejection',
        );
      },
    },
  });
  const commandId = randomUUID();
  // Keep the fixture's canonical payload in sync while padding the revision
  // before the title change. Canonical mutation validates both authorities.
  const paddedContentRevision = generateRevisionToken();
  await runtime.pool.query(
    `update collections
       set content_revision = $2,
           payload_json = jsonb_set(payload_json, '{contentRevision}', to_jsonb($2::text))
     where id = $1`,
    [collectionId, paddedContentRevision],
  );
  const outcome = await createPostgresCanonicalMutationUnitOfWork(runtime.db, { metrics })
    .execute((ports) => updateCollectionMetadataCanonical(ports, {
      actor: {
        principalId: 'phase2-acceptance-owner',
        principalType: 'account',
        subjectId: collection.owner_subject_id,
      },
      command: {
        commandId,
        fingerprint: createHash('sha256').update(commandId).digest('hex'),
      },
      collectionId,
      ifMatch: collection.resource_revision,
      patch: { title: `P2 purge ${commandId.slice(0, 8)}` },
      productOrigin: config.productOrigin,
    }));
  if (outcome.kind !== 'updated' || !worker.outbox) {
    throw new Error('Canonical mutation did not create a worker-observable purge event');
  }
  const readiness = worker.outbox.projectionReadiness();
  for (let attempt = 0; attempt < 64 && await worker.outbox.runOnce(); attempt += 1) {
    // Drain the finite fixture queue through the real lease/route path.
  }
  const row = await runtime.pool.query<{ state: string; attempt_count: number }>(
    `select state, attempt_count from outbox_events
      where handler_name = $1 and aggregate_id = $2
      order by commit_ordinal desc limit 1`,
    [PUBLICATION_CACHE_PURGE_HANDLER_NAME, collectionId],
  );
  const purge = row.rows[0];
  const latency = metrics.observations('publication.cache_purge.latency_ms');
  const queueAge = metrics.observations('publication.cache_purge.queue_age_ms');
  const attempts = metrics.observations('publication.cache_purge.attempt');
  if (!readiness.publicationCachePurge.allDurable
      || purge?.state !== 'dead_letter'
      || metrics.get('publication.cache_purge.failure') < 1
      || metrics.get('publication.cache_purge.permanent_failure') < 1
      || metrics.get('publication.cache_purge.dead_letter') < 1
      || latency.length < 1 || queueAge.length < 1 || attempts.length < 1) {
    throw new Error('Real worker did not emit complete CDN purge failure telemetry');
  }
  return passedProbe({
    routeDurable: true,
    finalState: purge.state,
    attemptCount: purge.attempt_count,
    failureCount: metrics.get('publication.cache_purge.failure'),
    permanentFailureCount: metrics.get('publication.cache_purge.permanent_failure'),
    deadLetterCount: metrics.get('publication.cache_purge.dead_letter'),
    latencyMs: latency,
    queueAgeMs: queueAge,
    attempts,
  });
}

function passedProbe(detail: Phase2JsonValue): Phase2RequiredProbeResult {
  assertJsonValue(detail, 'probe.detail');
  return Object.freeze({ passed: true, detail: immutableJson(detail) });
}

function validateExpectations(
  expectations: Phase2PublicationAcceptanceExpectations,
): Phase2PublicationAcceptanceExpectations {
  if (!expectations || !Number.isSafeInteger(expectations.expectedSnapshotNodes)
      || expectations.expectedSnapshotNodes < 10_000) {
    throw new RangeError('Phase 2 acceptance expectedSnapshotNodes must be an integer >= 10000');
  }
  for (const name of ['maxRequestP95Ms', 'maxSnapshotTraversalMs'] as const) {
    const value = expectations[name];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new RangeError(`Phase 2 acceptance ${name} must be a positive finite number`);
    }
  }
  return Object.freeze({ ...expectations });
}

function assertPostgresEvidence(value: Phase2PostgresEvidence): void {
  if (!value || value.engine !== 'postgresql'
      || typeof value.version !== 'string' || value.version.trim() === ''
      || typeof value.database !== 'string' || value.database.trim() === '') {
    throw new Error('PostgreSQL readiness probe returned incomplete evidence');
  }
}

function exactManifestUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('Phase 2 manifestUrl must be an absolute URL');
  }
  const loopbackHttp = url.protocol === 'http:'
    && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' && !loopbackHttp) {
    throw new TypeError('Phase 2 manifestUrl must use https (loopback http is allowed)');
  }
  if (url.username || url.password || url.search || url.hash
      || url.pathname !== '/.well-known/collection-protocol') {
    throw new TypeError('Phase 2 manifestUrl must be the exact discovery URL without userinfo/query/fragment');
  }
  return url;
}

function exactOrigin(value: string): string {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new TypeError('Known Phase 2 probe origin must be absolute');
  }
  if (origin.origin !== value || origin.username || origin.password) {
    throw new TypeError('Known Phase 2 probe origin must be an exact origin without userinfo');
  }
  return origin.origin;
}

function expandCollectionEndpoint(template: string, collectionId: string): string {
  return template.replace('{collectionId}', encodeURIComponent(collectionId)).split('?', 1)[0]!;
}

function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function sha256Hex(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`${name} must be a lowercase SHA-256 hex digest`);
  }
  return value;
}

function percentile(values: readonly number[], ratio: number): number {
  if (values.length === 0) throw new Error('Phase 2 acceptance captured no HTTP latency samples');
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)]!;
}

function assertJsonValue(value: unknown, path: string): asserts value is Phase2JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} contains a non-finite number`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonValue(entry, `${path}[${index}]`));
    return;
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} must contain only plain JSON objects`);
    }
    for (const [key, entry] of Object.entries(value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        throw new TypeError(`${path} contains an unsafe key`);
      }
      assertJsonValue(entry, `${path}.${key}`);
    }
    return;
  }
  throw new TypeError(`${path} is not JSON serializable`);
}

function immutableJson<Value>(value: Value): Value {
  return deepFreeze(structuredClone(value)) as Value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const primitive = JSON.stringify(value);
    if (primitive === undefined) throw new TypeError('Evidence payload is not canonical JSON');
    return primitive;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

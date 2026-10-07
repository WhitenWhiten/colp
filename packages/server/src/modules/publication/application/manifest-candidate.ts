import { createValidatorRegistry, validateWireDocument } from '@know-n/colp/schema';
import { validateManifestSemantics } from '@know-n/colp/semantic';
import type { Manifest, ManifestEndpoints, ManifestV02, ServiceUrl } from '@know-n/colp/types';
import {
  assertPhase2PublicationProfileClaims,
  type Phase2PublicationProfileClaims,
} from './profile-claim-gate.js';
import {
  assertPhase3SyncProfileClaims,
  TOMBSTONE_RETENTION_BOUNDS,
  type Phase3SyncProfileClaims,
} from '../../sync/index.js';
import { version } from '../../../version.js';

const KNOWN_SYNC_RETIRE_MANIFEST_EXTENSION = 'https://known.example/extensions/sync-retire';

const SELF_HOSTED_EDITION_FEATURE_KEYS = ['transport', 'cloud', 'edition'] as const;

export interface SelfHostedManifestFeatures {
  readonly transport: 'https' | 'insecure-http';
  readonly cloud: false;
  readonly edition: { readonly name: 'colp-server'; readonly version: string };
}

/** Server version recorded by `scripts/write-version.mjs`. */
export function colpServerPackageVersion(): string {
  return version.server;
}

/**
 * Edition keys for `KNOWN_EDITION=self-hosted` only. Absent means the hosted
 * manifest stays on the protocol feature set.
 */
export function selfHostedManifestFeatures(
  env: NodeJS.ProcessEnv = process.env,
): SelfHostedManifestFeatures | null {
  if (env.KNOWN_EDITION !== 'self-hosted') return null;
  return {
    transport: env.COLP_INSECURE_HTTP === 'true' ? 'insecure-http' : 'https',
    cloud: false,
    edition: { name: 'colp-server', version: colpServerPackageVersion() },
  };
}

/** Drops G3 edition keys so COLP schema validation still sees a protocol manifest. */
export function manifestWithoutSelfHostedEditionFeatures<T>(manifest: T): T {
  const mounts = (manifest as { mounts?: ReadonlyArray<{ features?: object }> }).mounts;
  if (!mounts?.some((mount) => mountHasEditionFeatures(mount.features))) return manifest;
  const copy = structuredClone(manifest) as T & {
    mounts: Array<{ features?: Record<string, unknown> }>;
  };
  for (const mount of copy.mounts) {
    if (mount.features === undefined) continue;
    for (const key of SELF_HOSTED_EDITION_FEATURE_KEYS) delete mount.features[key];
  }
  return copy;
}

/** Writes edition keys onto the publication mount when `KNOWN_EDITION=self-hosted`. */
export function applySelfHostedManifestFeatures<T>(manifest: T): T {
  const features = selfHostedManifestFeatures();
  if (features === null) return manifest;
  const copy = structuredClone(manifest) as T & {
    mounts: Array<{ features: Record<string, unknown> }>;
  };
  const mount = copy.mounts[0];
  if (mount === undefined) return manifest;
  mount.features = { ...mount.features, ...features };
  return copy;
}

function mountHasEditionFeatures(features: object | undefined): boolean {
  if (features === undefined) return false;
  const record = features as Record<string, unknown>;
  return SELF_HOSTED_EDITION_FEATURE_KEYS.some((key) => Object.hasOwn(record, key));
}

export const PUBLICATION_MEDIA_TYPES = Object.freeze({
  manifest: 'application/vnd.collection-protocol.manifest+json;version=0.1',
  directory: 'application/vnd.collection-protocol.catalog+json;version=0.1',
  collection: 'application/vnd.collection-protocol.collection+json;version=0.1',
  snapshot: 'application/vnd.collection-protocol.snapshot+json;version=0.1',
  problem: 'application/problem+json',
});

export type PublicationEndpointName = 'directory' | 'collection' | 'snapshot' | 'syncSessions' | 'syncSnapshot' | 'syncPush' | 'syncPull' | 'syncEffectPages' | 'syncAck' | 'syncConflict';

export interface PublicationManifestConfig {
  readonly origin: string;
  readonly mountPath: string;
  readonly serverUuid: string;
  readonly title: string;
  readonly maxPageSize: number;
  readonly maxSnapshotNodes: number;
  readonly endpoints: Readonly<Record<'directory' | 'collection' | 'snapshot', string>
    & Partial<Record<'syncSessions' | 'syncSnapshot' | 'syncPush' | 'syncPull' | 'syncEffectPages' | 'syncAck' | 'syncConflict', string>>>;
  readonly syncRetire?: { readonly href: string };
  readonly sync?: {
    readonly multiCollectionSessions: false;
    readonly maxBatchOperations: 1;
    readonly cursorRetentionSeconds: number;
  };
}

export interface PublicationManifestCandidate {
  readonly manifest: Manifest;
  readonly claimedProfiles: readonly string[];
  readonly mediaTypes: typeof PUBLICATION_MEDIA_TYPES;
  readonly endpointTemplates: PublicationManifestConfig['endpoints'];
}

export interface PublicationManifestCandidateV02
  extends Omit<PublicationManifestCandidate, 'manifest'> {
  readonly manifest: ManifestV02;
}

const validators = createValidatorRegistry();
const endpointVariables: Readonly<Record<PublicationEndpointName, readonly string[]>> = Object.freeze({
  directory: Object.freeze([]),
  collection: Object.freeze(['collectionId']),
  snapshot: Object.freeze(['collectionId']),
  syncSessions: Object.freeze([]),
  syncSnapshot: Object.freeze([]),
  syncPush: Object.freeze([]),
  syncPull: Object.freeze([]),
  syncEffectPages: Object.freeze(['effectId', 'pageNumber']),
  syncAck: Object.freeze([]),
  syncConflict: Object.freeze(['conflictId']),
});

/**
 * Derives the cache-projection `claimedProfiles` label from a validated manifest profile list.
 *
 * Cache-projection rationale: the published Manifest ETag is body-derived (the real manifest
 * bytes are hashed), so `claimedProfiles` is only an internal cache-partition label
 * (`manifest-discovery-unclaimed` vs `manifest-discovery-<profiles>`), not protocol semantics.
 * The baseline core-only manifest (`['core']`) keeps the stable "unclaimed" partition key;
 * any Profile claim always appends a profile, so the label then carries the full validated
 * profile list and can never misclassify a real claim as unclaimed.
 */
export function deriveClaimedProfiles(profiles: readonly string[]): readonly string[] {
  return profiles.length === 1 ? [] : profiles;
}

/** Builds a validated candidate without turning package support into deployment claims. */
export function createPublicationManifestCandidate(
  config: PublicationManifestConfig,
  implementedEndpoints: readonly PublicationEndpointName[] = [],
  profileClaims?: Phase2PublicationProfileClaims,
  syncProfileClaims?: Phase3SyncProfileClaims,
): PublicationManifestCandidate {
  assertConfig(config);
  if (profileClaims !== undefined) assertPhase2PublicationProfileClaims(profileClaims);
  if (syncProfileClaims !== undefined) assertPhase3SyncProfileClaims(syncProfileClaims);
  if (syncProfileClaims !== undefined && config.sync === undefined) {
    throw new Error('Publication Sync Profile claim requires Sync Manifest capability configuration');
  }
  const implemented = new Set(implementedEndpoints);
  if (implemented.size !== implementedEndpoints.length) {
    throw new Error('Publication implemented endpoint declarations must be unique');
  }
  const endpoints: ManifestEndpoints & Partial<Record<PublicationEndpointName, string>> = {};
  for (const name of implemented) {
    if (!(name in endpointVariables)) throw new Error(`Unknown Publication endpoint: ${String(name)}`);
    const endpoint = config.endpoints[name];
    if (typeof endpoint !== 'string') throw new Error(`Publication endpoint ${name} is not configured`);
    if (name !== 'syncEffectPages') endpoints[name] = endpoint as never;
  }
  const profiles = ['core', ...(profileClaims ? ['publication'] : []),
    ...(syncProfileClaims ? ['sync'] : [])] as Manifest['mounts'][number]['profiles'];
  const manifest: Manifest = {
    protocol: 'https://know-n.com/colp/spec/0.1',
    protocolVersions: implemented.has('syncEffectPages') ? ['0.1', '0.2'] : ['0.1'],
    serverId: `${config.origin}/` as Manifest['serverId'],
    serverUuid: config.serverUuid,
    title: config.title,
    mounts: [{
      id: 'publication',
      baseUrl: `${config.origin}${config.mountPath}` as Manifest['mounts'][number]['baseUrl'],
      // Endpoint completeness is not deployment evidence for a Profile claim.
      profiles,
      endpoints,
      features: {
        bookmarkUrls: {
          acceptedSchemes: ['http', 'https'] as unknown as NonNullable<Manifest['mounts'][number]['features']['bookmarkUrls']>['acceptedSchemes'],
        },
        ...(syncProfileClaims ? { sync: {
          multiCollectionSessions: config.sync!.multiCollectionSessions,
        } } : {}),
      },
      auth: ['syncSessions', 'syncSnapshot', 'syncPush', 'syncPull', 'syncEffectPages', 'syncAck', 'syncConflict']
        .some((name) => implemented.has(name as PublicationEndpointName))
        ? {
            anonymousRead: true,
            apiKeys: false,
            oauth: true,
            protectedResourceMetadata: `${config.origin}/.well-known/oauth-protected-resource` as ServiceUrl,
          }
        : { anonymousRead: true, apiKeys: false, oauth: false },
      limits: {
        maxPageSize: config.maxPageSize,
        maxSnapshotNodes: config.maxSnapshotNodes,
        minPollIntervalSeconds: 60,
        recommendedPollIntervalSeconds: 300,
        ...(syncProfileClaims ? {
          maxSyncBatchOperations: config.sync!.maxBatchOperations,
          syncCursorRetentionSeconds: config.sync!.cursorRetentionSeconds,
        } : {}),
      },
    }],
  };
  if (config.syncRetire) {
    (manifest.mounts[0] as Record<string, unknown>)[KNOWN_SYNC_RETIRE_MANIFEST_EXTENSION]
      = createSyncRetireManifestExtension(config.syncRetire.href);
  }
  const validation = validateWireDocument<Manifest, unknown>(
    validators,
    'manifest',
    manifest,
    validateManifestSemantics,
  );
  if (!validation.valid) {
    throw new Error(`Publication Manifest candidate failed COLP ${validation.stage} validation`);
  }
  return deepFreeze({
    manifest: applySelfHostedManifestFeatures(validation.value),
    claimedProfiles: deriveClaimedProfiles(profiles),
    mediaTypes: PUBLICATION_MEDIA_TYPES,
    endpointTemplates: { ...config.endpoints },
  });
}

/** Builds the COLP 0.2 discovery representation with its effect-page template at top level. */
export function createPublicationManifestCandidateV02(
  config: PublicationManifestConfig,
  implementedEndpoints: readonly PublicationEndpointName[] = [],
  profileClaims?: Phase2PublicationProfileClaims,
  syncProfileClaims?: Phase3SyncProfileClaims,
): PublicationManifestCandidateV02 {
  if (!implementedEndpoints.includes('syncEffectPages') || !config.endpoints.syncEffectPages) {
    throw new Error('COLP 0.2 Publication Manifest requires the syncEffectPages endpoint');
  }
  const base = createPublicationManifestCandidate(
    config, implementedEndpoints, profileClaims, syncProfileClaims,
  );
  const protocolManifest = manifestWithoutSelfHostedEditionFeatures(base.manifest);
  const manifest: ManifestV02 = {
    ...protocolManifest,
    protocol: 'https://know-n.com/colp/spec/0.2',
    protocolVersions: ['0.1', '0.2'],
    syncEffectPages: config.endpoints.syncEffectPages as unknown as ManifestV02['syncEffectPages'],
  };
  const validation = validators.validate('manifestV02', manifest);
  if (!validation.valid) {
    throw new Error('Publication Manifest 0.2 candidate failed COLP structural validation');
  }
  return deepFreeze({ ...base, manifest: applySelfHostedManifestFeatures(manifest) });
}

function assertConfig(config: PublicationManifestConfig): void {
  const origin = parseExactOrigin(config.origin);
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && isLoopback(origin.hostname))) {
    throw new Error('Publication origin must use https (http is allowed only for loopback)');
  }
  if (!/^\/[A-Za-z0-9._~/-]*\/$/u.test(config.mountPath) || config.mountPath.includes('//')) {
    throw new Error('Publication mount path must be an absolute path ending in /');
  }
  if (!Number.isSafeInteger(config.maxPageSize) || config.maxPageSize < 1 || config.maxPageSize > 500) {
    throw new Error('Publication max page size must be between 1 and 500');
  }
  if (!Number.isSafeInteger(config.maxSnapshotNodes) || config.maxSnapshotNodes < config.maxPageSize) {
    throw new Error('Publication max snapshot nodes must cover at least one page');
  }
  if (config.sync !== undefined && (config.sync.multiCollectionSessions !== false
      || config.sync.maxBatchOperations !== 1
      || !Number.isSafeInteger(config.sync.cursorRetentionSeconds)
      || config.sync.cursorRetentionSeconds < TOMBSTONE_RETENTION_BOUNDS.minSeconds)) {
    throw new Error('Publication Sync Manifest capability configuration is invalid');
  }
  for (const name of Object.keys(endpointVariables) as PublicationEndpointName[]) {
    const template = config.endpoints[name];
    if ((name === 'syncSessions' || name === 'syncSnapshot' || name === 'syncPush' || name === 'syncPull' || name === 'syncAck'
        || name === 'syncConflict' || name === 'syncEffectPages') && template === undefined) continue;
    if (typeof template !== 'string') throw new Error(`Publication ${name} endpoint is required`);
    let endpointUrl: URL;
    try {
      endpointUrl = new URL(template.replace(/\{[^{}]+\}/gu, 'value'));
    } catch {
      throw new Error(`Publication ${name} endpoint must be an absolute URL template`);
    }
    const variables = [...template.matchAll(/\{([^{}]+)\}/gu)].map((match) => match[1]).sort();
    if (variables.join('\0') !== endpointVariables[name].join('\0')) {
      throw new Error(`Publication ${name} endpoint has invalid template variables`);
    }
    if (endpointUrl.origin !== origin.origin || endpointUrl.username || endpointUrl.password) {
      throw new Error(`Publication ${name} endpoint must stay on the configured origin`);
    }
  }
}

function parseExactOrigin(value: string): URL {
  try {
    const url = new URL(value);
    if (url.origin !== value || url.username || url.password) throw new Error();
    return url;
  } catch {
    throw new Error('Publication origin must be an exact absolute origin');
  }
}

function isLoopback(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(hostname.toLowerCase());
}

function createSyncRetireManifestExtension(href: string) {
  let url: URL;
  try { url = new URL(href); } catch { throw new TypeError('Sync retire extension href must be absolute'); }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '') {
    throw new TypeError('Sync retire extension href must be a credential-free HTTPS URL');
  }
  return Object.freeze({
    href: url.href,
    method: 'DELETE' as const,
    requiredHeaders: Object.freeze([
      'Authorization', 'Origin', 'Known-Sync-Session', 'Idempotency-Key',
    ] as const),
    requestBody: false as const,
    successStatus: 204 as const,
  });
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

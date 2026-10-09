import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import {
  McpReadRequestContextError,
  McpResourceNotFoundError,
  type Mcp20260728CacheMetadata,
  type McpAuthorizationBinding,
  type McpReadResource,
  type McpResourceListInput,
  type McpResourceListItem,
  type McpResourceListResult,
  type McpResourceProvenance,
  type McpTrustedReadRequestContext,
} from '@know-n/colp/mcp';
import {
  createPublicationDirectoryFilterDigest,
  DEFAULT_PUBLICATION_DIRECTORY_SORT,
} from '@know-n/colp/server';
import type { AccessPolicyFactsPort } from '../access-policy/index.js';
import { requireMcpAccountSubjectId } from './account-context.js';
import {
  assessSharedExposureScope,
  assertSharedExposureScopeIneligible,
  type DenyByDefaultExposure,
  type SharedExposureFactsPort,
} from '../exposure/index.js';
import {
  PublicationDirectoryCursorError,
  PublicationMetadataNotFoundError,
  getPublicationCollectionMetadata,
  getPublicationDirectoryPage,
  type PublicationDirectoryFilter,
  type PublicationDirectoryQueryPorts,
  type PublicationMetadataQueryPorts,
  type PublicationPrincipal,
} from '../publication/index.js';
import type {
  McpReadCollectionResourceCursorKeyConfig,
  McpReadFeatureConfig,
  McpReadFeatureConfigAssertOptions,
} from './config.js';
import { PHASE4B_MCP_PUBLIC_READ_CACHE_TTL_MS } from './read-cache.js';
import { createPhase4bMcpResourceIdentity } from './resource-identity.js';
import {
  MCP_OAUTH_SCOPE_READ_OWN,
  MCP_OAUTH_SCOPE_READ_PUBLIC,
} from './scope-requirements.js';

export const PHASE4B_MCP_COLLECTION_RESOURCE_MIME_TYPE =
  'application/vnd.collection-protocol.collection+json' as const;
export const PHASE4B_MCP_COLLECTION_RESOURCE_COMPARATOR_VERSION =
  'mcp-collection-resource-list-v1' as const;
export const PHASE4B_MCP_COLLECTION_RESOURCE_DEFAULT_PAGE_SIZE = 100;
export const PHASE4B_MCP_COLLECTION_RESOURCE_MAX_PAGE_SIZE = 500;
/** Truncated collection summary for MCP Resource `description`. */
export const PHASE4B_MCP_COLLECTION_RESOURCE_DESCRIPTION_MAX_CHARS = 240;

const CURSOR_PREFIX = 'mcr1' as const;
const CURSOR_PATTERN = /^mcr1\.([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/u;
const CURSOR_PURPOSE = 'known/mcp/collection-resource-list/v1';
const CURSOR_SALT = Buffer.from('known/mcp/collection-resource-list/v1', 'utf8');
const CURSOR_INFO = Buffer.from('list', 'utf8');

export interface Phase4bMcpCollectionResourceCursorKeyringOptions {
  readonly active: McpReadCollectionResourceCursorKeyConfig;
  readonly retained: readonly McpReadCollectionResourceCursorKeyConfig[];
  readonly ttlMs: number;
  readonly now?: () => Date;
}

export interface Phase4bMcpCollectionResourceCursorScope {
  readonly principal: string;
  readonly securityEpoch: string;
  readonly filterDigest: string;
  readonly filter: Readonly<PublicationDirectoryFilter>;
  readonly pageSize: number;
  readonly comparator: string;
  readonly policyRevision: string;
  readonly nextPosition: string;
}

export interface Phase4bMcpCollectionResourceCursorPayload
  extends Phase4bMcpCollectionResourceCursorScope {
  readonly v: 1;
  readonly expiresAt: number;
}

export type Phase4bMcpCollectionResourceCursorVerification =
  | { readonly valid: true; readonly payload: Phase4bMcpCollectionResourceCursorPayload }
  | { readonly valid: false };

export interface Phase4bMcpCollectionResourceCursorKeyring {
  readonly destroyed: boolean;
  readonly activeKeyId: string;
  sign(scope: Phase4bMcpCollectionResourceCursorScope): string;
  verify(cursor: string): Phase4bMcpCollectionResourceCursorVerification;
  destroy(): void;
}

export interface Phase4bMcpCollectionResourceProjectionOptions {
  readonly config: McpReadFeatureConfig;
  readonly directoryQuery: PublicationDirectoryQueryPorts;
  readonly metadataQuery: PublicationMetadataQueryPorts;
  readonly accessPolicy: AccessPolicyFactsPort;
  readonly cursorKeys: Phase4bMcpCollectionResourceCursorKeyring;
  readonly now?: () => Date;
  readonly pageSize?: number;
  readonly policyRevisionFor?: (input: {
    readonly principal: string;
    readonly securityEpoch: string;
    readonly filterDigest: string;
    readonly pageSize: number;
    readonly comparator: string;
  }) => string | Promise<string>;
  /**
   * P4A-R06: the MCP projection depends on the exposure-eligibility gate
   * through the approved facts port (logical facts only); deny-by-default
   * means no private Attachment can ever be served as an MCP resource.
   */
  readonly sharedExposure: SharedExposureFactsPort;
  /** Same P4 re-assert options `loadConfig` used; omit for production-strict. */
  readonly assertOptions?: McpReadFeatureConfigAssertOptions;
}

export type Phase4bMcpCollectionResourceContentProjection = Readonly<{
  readonly mimeType: string;
  readonly text: string;
  readonly provenance: McpResourceProvenance;
}>;

export type Phase4bMcpCollectionResourceReadResult = Readonly<{
  readonly contents: readonly Phase4bMcpCollectionResourceContentProjection[];
}>;

export interface Phase4bMcpCollectionResourceProjection {
  readonly listResources: (
    input: Readonly<McpResourceListInput>,
    context: McpTrustedReadRequestContext,
  ) => Promise<McpResourceListResult>;
  readonly readResource: (
    input: Readonly<{ readonly resource: McpReadResource }>,
    context: McpTrustedReadRequestContext,
  ) => Promise<Phase4bMcpCollectionResourceReadResult>;
  readonly cacheForList: (
    input: Readonly<McpResourceListInput>,
    context: McpTrustedReadRequestContext,
  ) => Promise<Mcp20260728CacheMetadata>;
  readonly cacheForRead: (
    input: Readonly<{ readonly resource: McpReadResource }>,
    context: McpTrustedReadRequestContext,
  ) => Promise<Mcp20260728CacheMetadata>;
}

interface ImportedCursorKey {
  readonly id: string;
  readonly key: Buffer;
}

const invalidCursorVerification: Phase4bMcpCollectionResourceCursorVerification =
  Object.freeze({ valid: false });

/**
 * MCP-specific opaque list cursor keyring. The token is independently signed
 * and rotated; Publication/Product/Sync cursor implementations are never used
 * as the MCP wire cursor.
 */
export function createPhase4bMcpCollectionResourceCursorKeyring(
  options: Phase4bMcpCollectionResourceCursorKeyringOptions,
): Phase4bMcpCollectionResourceCursorKeyring {
  if (!isRecord(options)) throw cursorConfigError();
  const ttlMs = readOwnData(options, 'ttlMs', cursorConfigError) as number;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw cursorConfigError();
  const rawNow = readOptionalData(options, 'now');
  const clock = rawNow === undefined ? () => new Date() : rawNow as () => Date;
  if (typeof clock !== 'function') throw cursorConfigError();
  const normalized = normalizeCursorKeys(options);
  const imported = normalized.map(importCursorKey);
  const active = imported[0]!;
  let destroyed = false;

  const sign = (scope: Phase4bMcpCollectionResourceCursorScope): string => {
    if (destroyed) throw new Error('MCP Collection Resource cursor keyring is destroyed');
    const payload: Phase4bMcpCollectionResourceCursorPayload = Object.freeze({
      ...scope,
      v: 1,
      expiresAt: clock().getTime() + ttlMs,
    });
    const body = Buffer.from(canonicalJson(payload), 'utf8').toString('base64url');
    const signed = `${CURSOR_PREFIX}.${active.id}.${body}`;
    return `${signed}.${createHmac('sha256', active.key).update(signed, 'ascii').digest('base64url')}`;
  };

  const verify = (cursor: string): Phase4bMcpCollectionResourceCursorVerification => {
    if (destroyed || typeof cursor !== 'string') return invalidCursorVerification;
    const match = CURSOR_PATTERN.exec(cursor);
    if (match === null) return invalidCursorVerification;
    const importedKey = imported.find((candidate) => candidate.id === match[1]);
    if (importedKey === undefined) return invalidCursorVerification;
    const signed = `${CURSOR_PREFIX}.${match[1]}.${match[2]}`;
    const expectedMac = createHmac('sha256', importedKey.key).update(signed, 'ascii').digest();
    const suppliedMac = Buffer.from(match[3]!, 'base64url');
    const macValid = suppliedMac.length === expectedMac.length && timingSafeEqual(suppliedMac, expectedMac);
    expectedMac.fill(0);
    suppliedMac.fill(0);
    if (!macValid) return invalidCursorVerification;
    let decoded: unknown;
    try {
      const bytes = Buffer.from(match[2]!, 'base64url');
      if (bytes.toString('base64url') !== match[2]) return invalidCursorVerification;
      decoded = JSON.parse(bytes.toString('utf8')) as unknown;
      bytes.fill(0);
    } catch {
      return invalidCursorVerification;
    }
    const payload = readCursorPayload(decoded);
    if (payload === undefined) return invalidCursorVerification;
    if (!Number.isSafeInteger(payload.expiresAt) || payload.expiresAt <= clock().getTime()) {
      return invalidCursorVerification;
    }
    return Object.freeze({ valid: true, payload });
  };

  const keyring: Phase4bMcpCollectionResourceCursorKeyring = Object.freeze({
    get destroyed() { return destroyed; },
    activeKeyId: active.id,
    sign,
    verify,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const importedKey of imported) importedKey.key.fill(0);
    },
  });
  return keyring;
}

function normalizeCursorKeys(
  options: Phase4bMcpCollectionResourceCursorKeyringOptions,
): readonly McpReadCollectionResourceCursorKeyConfig[] {
  const active = readOwnData(options, 'active', cursorConfigError);
  const retainedRaw = readOwnData(options, 'retained', cursorConfigError);
  if (!isRecord(active) || !Array.isArray(retainedRaw) || retainedRaw.length > 8) {
    throw cursorConfigError();
  }
  const all = [active, ...retainedRaw].map((key, index) => {
    if (!isRecord(key)) throw cursorConfigError();
    const id = readOwnData(key, 'id', cursorConfigError) as string;
    const secret = readOwnData(key, 'secret', cursorConfigError) as string;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(id)) throw cursorConfigError();
    if (typeof secret !== 'string') throw cursorConfigError();
    const bytes = Buffer.from(secret, 'base64');
    const canonical = bytes.toString('base64');
    if (bytes.byteLength < 32 || canonical !== secret) {
      bytes.fill(0);
      throw cursorConfigError();
    }
    bytes.fill(0);
    return Object.freeze({ id, secret });
  });
  if (new Set(all.map((key) => key.id)).size !== all.length
    || new Set(all.map((key) => key.secret)).size !== all.length) {
    throw cursorConfigError();
  }
  return Object.freeze(all);
}

function importCursorKey(config: McpReadCollectionResourceCursorKeyConfig): ImportedCursorKey {
  const secret = Buffer.from(config.secret, 'base64');
  try {
    const key = Buffer.from(hkdfSync('sha256', secret, CURSOR_SALT, CURSOR_INFO, 32));
    return Object.freeze({ id: config.id, key });
  } finally {
    secret.fill(0);
  }
}

function readCursorPayload(value: unknown): Phase4bMcpCollectionResourceCursorPayload | undefined {
  if (!isRecord(value)) return undefined;
  const v = readCursorOwnData(value, 'v') as number;
  const principal = readCursorOwnData(value, 'principal') as string;
  const securityEpoch = readCursorOwnData(value, 'securityEpoch') as string;
  const filterDigest = readCursorOwnData(value, 'filterDigest') as string;
  const filterValue = readCursorOwnData(value, 'filter');
  const pageSize = readCursorOwnData(value, 'pageSize') as number;
  const comparator = readCursorOwnData(value, 'comparator') as string;
  const policyRevision = readCursorOwnData(value, 'policyRevision') as string;
  const expiresAt = readCursorOwnData(value, 'expiresAt') as number;
  const nextPosition = readCursorOwnData(value, 'nextPosition') as string;
  const filter = isCanonicalFilter(filterValue) ? filterValue : undefined;
  if (v !== 1
    || typeof principal !== 'string' || principal.length === 0
    || typeof securityEpoch !== 'string' || securityEpoch.length === 0
    || typeof filterDigest !== 'string' || filterDigest.length === 0
    || filter === undefined
    || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > PHASE4B_MCP_COLLECTION_RESOURCE_MAX_PAGE_SIZE
    || typeof comparator !== 'string' || comparator.length === 0
    || typeof policyRevision !== 'string' || policyRevision.length === 0
    || !Number.isSafeInteger(expiresAt)
    || typeof nextPosition !== 'string' || nextPosition.length === 0) {
    return undefined;
  }
  return Object.freeze({
    v,
    principal,
    securityEpoch,
    filterDigest,
    filter: Object.freeze(filter),
    pageSize,
    comparator,
    policyRevision,
    expiresAt,
    nextPosition,
  });
}

function readCursorOwnData(value: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor === undefined || !('value' in descriptor)) return undefined;
  return descriptor.value;
}

function isCanonicalFilter(value: unknown): value is Readonly<PublicationDirectoryFilter> {
  if (!isRecord(value)) return false;
  const allowed = new Set(['tag', 'creator', 'kind', 'updatedSince', 'q']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return false;
    const candidate = value[key];
    if (typeof candidate !== 'string' || candidate.length === 0) return false;
  }
  return true;
}

/**
 * Creates the R08 host projection. It reuses the Phase 2 Directory and
 * Collection Metadata queries plus the current access-policy facts port; it
 * does not create an MCP read model or MCP-only ACL store.
 */
export function createPhase4bMcpCollectionResourceProjection(
  options: Phase4bMcpCollectionResourceProjectionOptions,
): Phase4bMcpCollectionResourceProjection {
  if (!isRecord(options)) throw new TypeError('MCP Collection Resource projection options are required.');
  const config = readOwnData(options, 'config', projectionConfigError) as McpReadFeatureConfig;
  const directoryQuery = readOwnData(
    options,
    'directoryQuery',
    projectionConfigError,
  ) as PublicationDirectoryQueryPorts;
  const metadataQuery = readOwnData(
    options,
    'metadataQuery',
    projectionConfigError,
  ) as PublicationMetadataQueryPorts;
  const accessPolicy = readOwnData(options, 'accessPolicy', projectionConfigError) as AccessPolicyFactsPort;
  const sharedExposure = readOwnData(
    options,
    'sharedExposure',
    projectionConfigError,
  ) as SharedExposureFactsPort;
  const cursorKeys = readOwnData(
    options,
    'cursorKeys',
    projectionConfigError,
  ) as Phase4bMcpCollectionResourceCursorKeyring;
  const nowValue = readOptionalData(options, 'now');
  const now = nowValue === undefined ? () => new Date() : nowValue as () => Date;
  if (typeof now !== 'function') throw projectionConfigError();
  const pageSizeValue = readOptionalData(options, 'pageSize') as number | undefined;
  const requestedPageSize = pageSizeValue === undefined
    ? PHASE4B_MCP_COLLECTION_RESOURCE_DEFAULT_PAGE_SIZE
    : pageSizeValue;
  if (!Number.isSafeInteger(requestedPageSize) || requestedPageSize < 1
    || requestedPageSize > PHASE4B_MCP_COLLECTION_RESOURCE_MAX_PAGE_SIZE) {
    throw projectionConfigError();
  }
  const configuredMax = isRecord(directoryQuery) ? (directoryQuery as { maxPageSize?: unknown }).maxPageSize : undefined;
  const directoryMax = configuredMax === undefined
    ? PHASE4B_MCP_COLLECTION_RESOURCE_MAX_PAGE_SIZE
    : Number(configuredMax);
  if (!Number.isSafeInteger(directoryMax) || directoryMax < 1) throw projectionConfigError();
  const pageSize = Math.min(requestedPageSize, directoryMax);
  const policyRevisionForValue = readOptionalData(options, 'policyRevisionFor');
  const policyRevisionFor = policyRevisionForValue === undefined
    ? undefined
    : policyRevisionForValue as ProjectionState['policyRevisionFor'];
  if (policyRevisionFor !== undefined && typeof policyRevisionFor !== 'function') throw projectionConfigError();
  if (!isRecord(config) || !isRecord(cursorKeys)) throw projectionConfigError();

  const assertOptionsValue = readOptionalData(options, 'assertOptions');
  if (
    assertOptionsValue !== undefined
    && (typeof assertOptionsValue !== 'object' || assertOptionsValue === null
      || Array.isArray(assertOptionsValue))
  ) {
    throw projectionConfigError();
  }
  const identity = createPhase4bMcpResourceIdentity(
    config,
    (assertOptionsValue ?? {}) as McpReadFeatureConfigAssertOptions,
  );
  const state: ProjectionState = Object.freeze({
    config,
    directoryQuery,
    metadataQuery,
    accessPolicy,
    sharedExposure,
    cursorKeys,
    now,
    pageSize,
    policyRevisionFor,
    identity,
  });

  return Object.freeze({
    listResources: (input: Readonly<McpResourceListInput>, context: McpTrustedReadRequestContext) =>
      projectList(state, input, context),
    readResource: (input: Readonly<{ readonly resource: McpReadResource }>, context: McpTrustedReadRequestContext) =>
      projectRead(state, input, context),
    cacheForList: (input: Readonly<McpResourceListInput>, context: McpTrustedReadRequestContext) =>
      projectListCache(state, input, context),
    cacheForRead: (input: Readonly<{ readonly resource: McpReadResource }>, context: McpTrustedReadRequestContext) =>
      projectReadCache(state, input, context),
  });
}

async function projectList(
  state: Readonly<ProjectionState>,
  input: Readonly<McpResourceListInput>,
  context: McpTrustedReadRequestContext,
): Promise<McpResourceListResult> {
  const principal = principalFromContext(context);
  const principalScopeValue = principalScope(principal);
  const securityEpoch = context.binding.securityEpoch;
  const comparator = PHASE4B_MCP_COLLECTION_RESOURCE_COMPARATOR_VERSION;
  const pageSize = state.pageSize;
  let filter: Readonly<PublicationDirectoryFilter> = Object.freeze({});
  let continuationPolicyRevision: string | undefined;

  if (input.cursor !== undefined) {
    const verification = state.cursorKeys.verify(input.cursor);
    if (!verification.valid) throw cursorError();
    const payload = verification.payload;
    assertCursorBinding(payload, principalScopeValue, securityEpoch, pageSize, comparator);
    filter = payload.filter;
    const filterDigest = createPublicationDirectoryFilterDigest(filter);
    if (filterDigest !== payload.filterDigest) throw cursorError();
    continuationPolicyRevision = payload.policyRevision;
    const publicationCursor = state.directoryQuery.cursors.directory.sign({
      resourceId: `${state.directoryQuery.origin}/colp/v0.1/collections`,
      principal: payload.principal,
      filterDigest: payload.filterDigest,
      sort: DEFAULT_PUBLICATION_DIRECTORY_SORT,
      limit: payload.pageSize,
      protocolVersion: '0.1',
      nextPosition: payload.nextPosition,
    });
    try {
      const page = await getPublicationDirectoryPage(state.directoryQuery, {
        principal,
        query: {
          ...filter,
          limit: pageSize,
          cursor: publicationCursor,
        },
      });
      return buildListPage(state, page, principalScopeValue, securityEpoch, filter, pageSize,
        comparator, continuationPolicyRevision, input.cursor);
    } catch (error) {
      if (error instanceof PublicationDirectoryCursorError) throw cursorError();
      throw error;
    }
  }

  // Directory sort is always DEFAULT_PUBLICATION_DIRECTORY_SORT
  // (`updatedAt DESC, id ASC`); the query API has no sort field. First page
  // and continuation cursors therefore share the same comparator.
  const page = await getPublicationDirectoryPage(state.directoryQuery, {
    principal,
    query: { limit: pageSize },
  });
  return buildListPage(state, page, principalScopeValue, securityEpoch, filter, pageSize,
    comparator, undefined, undefined);
}

async function buildListPage(
  state: Readonly<ProjectionState>,
  page: Awaited<ReturnType<typeof getPublicationDirectoryPage>>,
  principalScopeValue: string,
  securityEpoch: string,
  filter: Readonly<PublicationDirectoryFilter>,
  pageSize: number,
  comparator: string,
  continuationPolicyRevision: string | undefined,
  continuationCursor: string | undefined,
): Promise<McpResourceListResult> {
  const filterDigest = createPublicationDirectoryFilterDigest(filter);
  const policyRevision = await resolvePolicyRevision(state, {
    principal: principalScopeValue,
    securityEpoch,
    filterDigest,
    pageSize,
    comparator,
  });
  if (continuationCursor !== undefined && policyRevision !== continuationPolicyRevision) {
    throw cursorError();
  }
  const resources: McpResourceListItem[] = page.directory.collections.map((collection) =>
    projectListItem(state, collection));
  let nextCursor: string | undefined;
  if (page.nextCursor !== null) {
    const cursorContext = {
      resourceId: `${state.directoryQuery.origin}/colp/v0.1/collections`,
      principal: principalScopeValue,
      filterDigest,
      sort: DEFAULT_PUBLICATION_DIRECTORY_SORT,
      limit: pageSize,
      protocolVersion: '0.1',
    };
    const verification = state.directoryQuery.cursors.directory.verify(page.nextCursor, cursorContext);
    if (!verification.valid) throw cursorError();
    nextCursor = state.cursorKeys.sign({
      principal: principalScopeValue,
      securityEpoch,
      filterDigest,
      filter,
      pageSize,
      comparator,
      policyRevision,
      nextPosition: verification.nextPosition,
    });
  }
  return Object.freeze({
    resources: Object.freeze(resources),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  });
}

async function projectRead(
  state: Readonly<ProjectionState>,
  input: Readonly<{ readonly resource: McpReadResource }>,
  context: McpTrustedReadRequestContext,
): Promise<Phase4bMcpCollectionResourceReadResult> {
  const resource = input.resource;
  if (resource.kind !== 'collection-metadata') throw new McpResourceNotFoundError();
  const principal = principalFromContext(context);
  let result: Awaited<ReturnType<typeof getPublicationCollectionMetadata>>;
  try {
    result = await getPublicationCollectionMetadata(state.metadataQuery, {
      collectionId: resource.collectionId,
      principal,
    });
  } catch (error) {
    if (error instanceof PublicationMetadataNotFoundError) throw new McpResourceNotFoundError();
    throw error;
  }
  if (result.kind !== 'metadata') throw new McpResourceNotFoundError();
  // This metadata resource has no attachment candidates; do not scan its history.
  const exposure: readonly DenyByDefaultExposure[] = await assessSharedExposureScope(state.sharedExposure, {
    collectionId: resource.collectionId, blobIds: [],
  }, { signal: context.abortSignal });
  assertSharedExposureScopeIneligible(exposure);
  if (principal.kind === 'account') {
    const facts = await state.accessPolicy.loadCollectionFacts({
      collectionId: resource.collectionId,
      actorSubjectId: requireMcpAccountSubjectId(context.authorization),
    });
    if (facts === null || facts.deleted
      || facts.collectionId !== resource.collectionId
      || facts.visibility !== result.metadata.collection.visibility) {
      throw new McpResourceNotFoundError();
    }
  }
  return Object.freeze({
    contents: Object.freeze([
      Object.freeze({
        mimeType: PHASE4B_MCP_COLLECTION_RESOURCE_MIME_TYPE,
        text: JSON.stringify(result.metadata),
        provenance: Object.freeze({ origin: 'internal' }),
      }),
    ]),
  });
}

async function projectListCache(
  _state: Readonly<ProjectionState>,
  _input: Readonly<McpResourceListInput>,
  context: McpTrustedReadRequestContext,
): Promise<Mcp20260728CacheMetadata> {
  return context.binding.kind === 'anonymous' ? publicReadCache() : privateReadCache();
}

async function projectReadCache(
  state: Readonly<ProjectionState>,
  input: Readonly<{ readonly resource: McpReadResource }>,
  context: McpTrustedReadRequestContext,
): Promise<Mcp20260728CacheMetadata> {
  if (context.binding.kind !== 'anonymous') {
    return privateReadCache();
  }
  try {
    const result = await getPublicationCollectionMetadata(state.metadataQuery, {
      collectionId: input.resource.collectionId,
      principal: { kind: 'anonymous' },
    });
    if (result.kind === 'metadata'
      && result.projection === 'public'
      && result.metadata.collection.visibility === 'public') {
      return publicReadCache();
    }
  } catch {
    // Cache declarations are conservative when authority cannot be confirmed.
  }
  // Unlisted exact-URI reads stay private; that is intentional, not a public leak.
  return privateReadCache();
}

function publicReadCache(): Mcp20260728CacheMetadata {
  return Object.freeze({
    ttlMs: PHASE4B_MCP_PUBLIC_READ_CACHE_TTL_MS,
    cacheScope: 'public',
  });
}

function privateReadCache(): Mcp20260728CacheMetadata {
  return Object.freeze({ ttlMs: 0, cacheScope: 'private' });
}

interface ProjectionState {
  readonly config: McpReadFeatureConfig;
  readonly directoryQuery: PublicationDirectoryQueryPorts;
  readonly metadataQuery: PublicationMetadataQueryPorts;
  readonly accessPolicy: AccessPolicyFactsPort;
  readonly sharedExposure: SharedExposureFactsPort;
  readonly cursorKeys: Phase4bMcpCollectionResourceCursorKeyring;
  readonly now: () => Date;
  readonly pageSize: number;
  readonly policyRevisionFor?: (input: {
    readonly principal: string;
    readonly securityEpoch: string;
    readonly filterDigest: string;
    readonly pageSize: number;
    readonly comparator: string;
  }) => string | Promise<string>;
  readonly identity: ReturnType<typeof createPhase4bMcpResourceIdentity>;
}

function projectListItem(
  state: Readonly<ProjectionState>,
  collection: {
    readonly id: string;
    readonly title: string;
    readonly summary?: string;
    readonly nodeCount: number;
    readonly updatedAt: string;
  },
): McpResourceListItem {
  const description = truncateCollectionDescription(collection.summary);
  return Object.freeze({
    uri: state.identity.collectionMetadata(collection.id),
    name: collection.title,
    mimeType: PHASE4B_MCP_COLLECTION_RESOURCE_MIME_TYPE,
    provenance: Object.freeze({ origin: 'internal' }),
    ...(description === undefined ? {} : { description }),
    _meta: Object.freeze({
      nodeCount: collection.nodeCount,
      updatedAt: collection.updatedAt,
    }),
  });
}

function truncateCollectionDescription(summary: string | undefined): string | undefined {
  if (typeof summary !== 'string') return undefined;
  const normalized = summary.trim();
  if (normalized.length === 0) return undefined;
  if (normalized.length <= PHASE4B_MCP_COLLECTION_RESOURCE_DESCRIPTION_MAX_CHARS) return normalized;
  return `${normalized.slice(0, PHASE4B_MCP_COLLECTION_RESOURCE_DESCRIPTION_MAX_CHARS - 1).trimEnd()}…`;
}

function assertCursorBinding(
  payload: Phase4bMcpCollectionResourceCursorPayload,
  principal: string,
  securityEpoch: string,
  pageSize: number,
  comparator: string,
): void {
  if (payload.v !== 1
    || payload.principal !== principal
    || payload.securityEpoch !== securityEpoch
    || payload.pageSize !== pageSize
    || payload.comparator !== comparator) {
    throw cursorError();
  }
}

async function resolvePolicyRevision(
  state: Readonly<ProjectionState>,
  input: {
    readonly principal: string;
    readonly securityEpoch: string;
    readonly filterDigest: string;
    readonly pageSize: number;
    readonly comparator: string;
  },
): Promise<string> {
  if (state.policyRevisionFor !== undefined) return state.policyRevisionFor(input);
  return createHash('sha256')
    .update(canonicalJson(input), 'utf8')
    .digest('base64url');
}

function principalFromBinding(
  binding: McpAuthorizationBinding,
  authorization: Readonly<Record<string, unknown>>,
): PublicationPrincipal {
  if (binding.kind === 'anonymous') return Object.freeze({ kind: 'anonymous' });
  return Object.freeze({
    kind: 'account',
    principalId: binding.principalId,
    subjectId: requireMcpAccountSubjectId(authorization),
  });
}

function principalFromContext(
  context: McpTrustedReadRequestContext,
): PublicationPrincipal {
  // `mcp:read:public` authenticates the caller but does not grant member
  // projection access.  Publication's account principal intentionally
  // includes membership, so downgrade public-only callers to anonymous before
  // every directory/metadata query.
  if (
    context.binding.kind === 'authenticated'
    && context.scope.includes(MCP_OAUTH_SCOPE_READ_PUBLIC)
    && !context.scope.includes(MCP_OAUTH_SCOPE_READ_OWN)
  ) {
    return Object.freeze({ kind: 'anonymous' });
  }
  return principalFromBinding(context.binding, context.authorization);
}

function principalScope(principal: PublicationPrincipal): string {
  return principal.kind === 'anonymous' ? 'anonymous' : `account:${principal.principalId}`;
}

function cursorError(): McpReadRequestContextError {
  return new McpReadRequestContextError();
}

function projectionConfigError(): TypeError {
  return new TypeError('Invalid MCP Collection Resource projection configuration.');
}

function cursorConfigError(): TypeError {
  return new TypeError('Invalid MCP Collection Resource cursor keyring configuration.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOwnData(value: object, name: string, fail: () => Error): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor === undefined || !('value' in descriptor)) throw fail();
  return descriptor.value;
}

function readOptionalData(value: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor === undefined || !('value' in descriptor)) return undefined;
  return descriptor.value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError('MCP Collection Resource cursor scope must be canonical JSON');
  return encoded;
}

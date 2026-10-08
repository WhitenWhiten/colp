import {
  createPublicationRepresentationEtag,
  evaluatePublicationConditionalGet,
  mergePublicationDiscoveryHeaders,
  PUBLICATION_MANIFEST_DISCOVERY_PATH,
  PUBLICATION_MANIFEST_MEDIA_TYPE,
} from '@know-n/colp/server';
import { createValidatorRegistry, validateWireDocument } from '@know-n/colp/schema';
import { validateManifestSemantics } from '@know-n/colp/semantic';
import type { Manifest } from '@know-n/colp/types';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PublicationConfig } from '../../bootstrap/config.js';
import {
  createPublicationManifestCandidate,
  createPublicationManifestCandidateV02,
  applySelfHostedManifestFeatures,
  manifestWithoutSelfHostedEditionFeatures,
  assertPhase2PublicationProfileClaimController,
  deriveClaimedProfiles,
  type Phase2PublicationProfileClaimController,
  type Phase2PublicationProfileClaims,
} from '../../modules/publication/index.js';
import {
  assertPhase3SyncProfileClaimController,
  type Phase3SyncProfileClaimController,
  type Phase3SyncProfileClaims,
} from '../../modules/sync/index.js';
import {
  assertPhase4bMcpWriteProfileClaimController,
  createMcpReadManifestCandidate,
  assertPhase4bMcpReadProfileClaimController,
  type McpReadFeatureConfig,
  type McpReadManifestCandidateOptions,
  type Phase4bMcpReadProfileClaimController,
  type Phase4bMcpReadProfileClaims,
  type Phase4bMcpWriteProfileClaimController,
  type Phase4bMcpWriteProfileClaims,
} from '../../modules/mcp/index.js';
import { sendPublicationProblem } from './publication-snapshot-routes.js';
import { negotiatePublicationRead } from './publication-read-negotiation.js';

type ManifestProtocolVersion = '0.1' | '0.2';
const MANIFEST_PROTOCOL_VERSIONS: readonly ManifestProtocolVersion[] = ['0.1', '0.2'];
const MANIFEST_BASE_MEDIA_TYPE = PUBLICATION_MANIFEST_MEDIA_TYPE.split(';', 1)[0]!;

export function registerPublicationManifestRoutes(
  app: FastifyInstance,
  config: PublicationConfig,
  profileClaims?: Phase2PublicationProfileClaims,
  profileClaimController?: Phase2PublicationProfileClaimController,
  syncProfileClaims?: Phase3SyncProfileClaims,
  syncProfileClaimController?: Phase3SyncProfileClaimController,
  mcpReadConfig?: McpReadFeatureConfig,
  mcpReadProfileClaims?: Phase4bMcpReadProfileClaims,
  mcpReadProfileClaimController?: Phase4bMcpReadProfileClaimController,
  mcpWriteProfileClaims?: Phase4bMcpWriteProfileClaims,
  mcpWriteProfileClaimController?: Phase4bMcpWriteProfileClaimController,
  mcpAssertOptions: McpReadManifestCandidateOptions = {},
): void {
  if (profileClaims !== undefined && profileClaimController !== undefined) {
    throw new TypeError('Publication Manifest accepts either fixed claims or a claim controller');
  }
  if (profileClaimController !== undefined) {
    assertPhase2PublicationProfileClaimController(profileClaimController);
  }
  if (syncProfileClaims !== undefined && syncProfileClaimController !== undefined) {
    throw new TypeError('Publication Manifest accepts either fixed Sync claims or a Sync claim controller');
  }
  if (syncProfileClaimController !== undefined) {
    assertPhase3SyncProfileClaimController(syncProfileClaimController);
  }
  if (mcpReadProfileClaims !== undefined && mcpReadProfileClaimController !== undefined) {
    throw new TypeError('Publication Manifest accepts either fixed MCP Read claims or a claim controller');
  }
  if (mcpReadProfileClaimController !== undefined) {
    assertPhase4bMcpReadProfileClaimController(mcpReadProfileClaimController);
  }
  if ((mcpReadProfileClaims !== undefined || mcpReadProfileClaimController !== undefined)
    && mcpReadConfig === undefined) {
    throw new TypeError('MCP Read Manifest claims require the MCP Read feature config');
  }
  if (mcpWriteProfileClaims !== undefined && mcpWriteProfileClaimController !== undefined) {
    throw new TypeError('Publication Manifest accepts either fixed MCP Write claims or a Write claim controller');
  }
  if (mcpWriteProfileClaimController !== undefined) {
    assertPhase4bMcpWriteProfileClaimController(mcpWriteProfileClaimController);
  }
  if ((mcpWriteProfileClaims !== undefined || mcpWriteProfileClaimController !== undefined)
    && mcpReadConfig === undefined) {
    throw new TypeError('MCP Write Manifest claims require the MCP Read feature config');
  }
  const representation = (version: ManifestProtocolVersion) => createManifestRepresentation(
    config,
    profileClaims ?? profileClaimController?.current(),
    syncProfileClaims ?? syncProfileClaimController?.current(),
    mcpReadConfig,
    mcpReadProfileClaims ?? mcpReadProfileClaimController?.current(),
    mcpWriteProfileClaims ?? mcpWriteProfileClaimController?.current(),
    version,
    mcpAssertOptions,
  );
  const supportedVersions: readonly ManifestProtocolVersion[] = config.endpoints.syncEffectPages
    ? MANIFEST_PROTOCOL_VERSIONS : ['0.1'];

  app.route({
    method: ['GET', 'HEAD'],
    url: PUBLICATION_MANIFEST_DISCOVERY_PATH,
    config: { productTransport: { allowedQuery: [], cacheControl: 'public-revalidate' } },
    handler: async (request, reply) => {
      const version = negotiateManifestVersion(request, supportedVersions);
      if (version === null) {
        return sendPublicationProblem(reply, request.method, {
          code: 'unsupported_version', recovery: { supportedVersions: [...supportedVersions] },
        });
      }
      const { body, etag, headers } = representation(version);
      writeHeaders(reply, headers);
      reply.header('Vary', mergeVary(reply.getHeader('Vary'), manifestVary(request)));
      const conditional = evaluatePublicationConditionalGet({
        ifNoneMatch: singleHeader(request.headers['if-none-match']),
        etag,
      });
      if (conditional.status === 304) return reply.code(304).send();
      reply.code(200);
      return request.method === 'HEAD' ? reply.send() : reply.send(body);
    },
  });
}

function createManifestRepresentation(
  config: PublicationConfig,
  profileClaims?: Phase2PublicationProfileClaims,
  syncProfileClaims?: Phase3SyncProfileClaims,
  mcpReadConfig?: McpReadFeatureConfig,
  mcpReadProfileClaims?: Phase4bMcpReadProfileClaims,
  mcpWriteProfileClaims?: Phase4bMcpWriteProfileClaims,
  version: ManifestProtocolVersion = '0.1',
  mcpAssertOptions: McpReadManifestCandidateOptions = {},
): {
  readonly body: Buffer;
  readonly etag: string;
  readonly headers: Readonly<Record<string, string>>;
} {
  const implementedEndpoints = ['directory', 'collection', 'snapshot', ...(config.endpoints.syncSessions
      ? ['syncSessions' as const] : []), ...(config.endpoints.syncSnapshot
      ? ['syncSnapshot' as const] : []), ...(config.endpoints.syncPush
      ? ['syncPush' as const] : []), ...(config.endpoints.syncConflict
      ? ['syncConflict' as const] : []), ...(config.endpoints.syncPull
      ? ['syncPull' as const] : []), ...(config.endpoints.syncEffectPages
      ? ['syncEffectPages' as const] : []), ...(config.endpoints.syncAck
      ? ['syncAck' as const] : [])] as const;
  const candidate = version === '0.2'
    ? createPublicationManifestCandidateV02(
      config, implementedEndpoints, profileClaims, syncProfileClaims,
    )
    : createPublicationManifestCandidate(
      config, implementedEndpoints, profileClaims, syncProfileClaims,
    );
  let manifest = candidate.manifest;
  let claimedProfiles = candidate.claimedProfiles;
  if (mcpReadConfig !== undefined) {
    const mcpCandidate = createMcpReadManifestCandidate(
      mcpReadConfig,
      mcpReadProfileClaims,
      mcpWriteProfileClaims,
      mcpAssertOptions,
    );
    const protocolManifest = manifestWithoutSelfHostedEditionFeatures(manifest);
    const combined = {
      ...protocolManifest,
      mounts: [...protocolManifest.mounts, mcpCandidate.manifest.mounts[0]],
    } as Manifest;
    const validation = version === '0.2'
      ? createValidatorRegistry().validate('manifestV02', combined)
      : validateWireDocument(
        createValidatorRegistry(),
        'manifest',
        combined,
        validateManifestSemantics,
      );
    if (!validation.valid) {
      throw new Error('Combined Publication/MCP Manifest failed COLP validation');
    }
    manifest = applySelfHostedManifestFeatures(combined);
    const allProfiles = [...new Set(combined.mounts.flatMap((mount) => mount.profiles))];
    claimedProfiles = deriveClaimedProfiles(allProfiles);
  }
  const mediaType = `${MANIFEST_BASE_MEDIA_TYPE};version=${version}`;
  const body = Buffer.from(JSON.stringify(manifest), 'utf8');
  const etag = createPublicationRepresentationEtag({
    representation: body,
    revision: 'manifest',
    projectionKey: claimedProfiles.length === 0
      ? 'manifest-discovery-unclaimed'
      : `manifest-discovery-${claimedProfiles.join('-')}`,
    queryContract: 'none',
    query: {},
    negotiatedMediaType: mediaType,
    protocolVersion: version,
  });
  const headers = mergePublicationDiscoveryHeaders({
    'Cache-Control': 'public, max-age=300',
    'Content-Length': String(body.byteLength),
    'Content-Type': mediaType,
    ETag: etag,
  });
  return Object.freeze({ body, etag, headers });
}

function negotiateManifestVersion(
  request: FastifyRequest,
  supportedVersions: readonly ManifestProtocolVersion[],
): ManifestProtocolVersion | null {
  for (const version of supportedVersions) {
    if (negotiatePublicationRead({
      accept: request.headers.accept,
      protocolVersion: request.headers['collection-protocol-version'],
      mediaType: MANIFEST_BASE_MEDIA_TYPE,
      version,
    })) return version;
  }
  return null;
}

function manifestVary(request: FastifyRequest): readonly string[] {
  const names = ['Accept', 'Collection-Protocol-Version'];
  if (request.headers.origin !== undefined) names.push('Origin');
  return names;
}

function singleHeader(value: string | readonly string[] | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

function writeHeaders(reply: FastifyReply, headers: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(headers)) reply.header(name, value);
}

function mergeVary(
  current: string | number | string[] | undefined,
  additions: readonly string[],
): string {
  const values = new Map<string, string>();
  const existing = Array.isArray(current) ? current : current === undefined ? [] : [String(current)];
  for (const value of [...existing.flatMap((entry) => entry.split(',')), ...additions]) {
    const trimmed = value.trim();
    if (trimmed !== '') values.set(trimmed.toLowerCase(), trimmed);
  }
  if (values.has('*')) return '*';
  return [...values.values()].join(', ');
}

import { createValidatorRegistry, validateWireDocument } from '../schema/index.js';
import { validateManifestSemantics, type SemanticIssue } from '../semantic/index.js';
import type { Manifest, ManifestMount } from '../types/index.js';
import { createMcpResourceUriCodec, type McpReadResource } from './resource-uri.js';
import {
  createMcpReadToolGateway,
  type CollectionReadApplicationServicePort,
  type McpReadToolGateway,
} from './collections-get.js';
import type { CollectionSnapshotLinkApplicationServicePort } from './collections-get-snapshot.js';
import { snapshotMcpData } from './safe-data.js';

export type McpReadMountConfigurationErrorCode =
  | 'invalid_manifest'
  | 'mcp_read_mount_not_found'
  | 'mcp_read_mount_mismatch'
  | 'missing_read_application_service'
  | 'anonymous_read_not_enabled'
  | 'missing_public_resource_access_service';

export class McpReadMountConfigurationError extends TypeError {
  readonly code: McpReadMountConfigurationErrorCode;
  readonly details: readonly unknown[];

  constructor(
    code: McpReadMountConfigurationErrorCode,
    message: string,
    details: readonly unknown[] = [],
  ) {
    super(message);
    this.name = 'McpReadMountConfigurationError';
    this.code = code;
    this.details = Object.freeze([...details]);
  }
}

export class McpAnonymousResourceUnavailableError extends Error {
  readonly code = 'anonymous_resource_unavailable' as const;

  constructor() {
    super('Anonymous MCP Resource is unavailable.');
    this.name = 'McpAnonymousResourceUnavailableError';
  }
}

export interface McpReadMountAdapterOptions {
  /** Selects exactly one read mount; implicit selection is deliberately unsupported. */
  readonly mountId: string;
  /** Required only when the selected mount advertises read-only Tools. */
  readonly applicationService?: CollectionReadApplicationServicePort;
  /**
   * Optional own-data snapshot link port. When Tools are enabled and this is present,
   * the mount gateway also publishes `collections.get_snapshot`.
   */
  readonly snapshotLinkService?: CollectionSnapshotLinkApplicationServicePort;
}

export interface McpResourceOnlyMountAdapter {
  readonly endpoint: string;
  readonly resources: true;
}

export interface McpReadToolsMountAdapter {
  readonly endpoint: string;
  readonly resources: true;
  /**
   * Gateway read Tool surface: always `collections.get`.
   * Also includes `collections.get_snapshot` when mount options supply `snapshotLinkService`.
   */
  readonly tools: McpReadToolGateway;
}

export type McpReadMountAdapter = McpResourceOnlyMountAdapter | McpReadToolsMountAdapter;

export interface McpPublicResourceAccessPort {
  /** Resolves an already-authorized public projection; private and unknown Resources reject. */
  readonly readPublicResource: (
    input: Readonly<{ resource: McpReadResource }>,
  ) => unknown | PromiseLike<unknown>;
}

export interface McpAnonymousReadExposureOptions {
  /** Selects exactly one read mount; implicit or cross-mount selection is unsupported. */
  readonly mountId: string;
  readonly publicAccess: McpPublicResourceAccessPort;
}

export interface McpAnonymousReadExposure {
  readonly endpoint: string;
  readonly resources: true;
  readonly readResource: (uri: string) => Promise<unknown>;
}

const manifestValidators = createValidatorRegistry();

/**
 * Resolves one validated mcp-read Manifest mount into its runtime exposure.
 * Schema and profile rules remain owned by the canonical validators.
 */
export function createMcpReadMountAdapter(
  manifest: unknown,
  options: McpReadMountAdapterOptions,
): McpReadMountAdapter {
  const validation = validateWireDocument<Manifest, SemanticIssue>(
    manifestValidators,
    'manifest',
    manifest,
    validateManifestSemantics,
  );
  if (!validation.valid) {
    const details = validation.stage === 'structural' ? validation.errors : validation.issues;
    throw new McpReadMountConfigurationError(
      'invalid_manifest',
      `Cannot expose an MCP read mount from a Manifest that failed ${validation.stage} validation.`,
      details,
    );
  }

  const mount = selectReadMount(validation.value, readOwnedMountId(options));
  const endpoint = mount.endpoints.mcp;
  const mcpFeatures = mount.features.mcp;

  // These are projection postconditions, not a second implementation of the
  // canonical Manifest rules. They also fail closed if a hostile accessor
  // changes the object after validation.
  if (
    !mount.profiles.includes('mcp-read')
    || typeof endpoint !== 'string'
    || mcpFeatures?.resources !== true
    || typeof mcpFeatures.tools !== 'boolean'
  ) {
    throw new McpReadMountConfigurationError(
      'mcp_read_mount_mismatch',
      'The selected mcp-read mount no longer matches its validated endpoint and capabilities.',
    );
  }

  if (!mcpFeatures.tools) {
    return Object.freeze({
      endpoint,
      resources: true,
    });
  }

  const applicationService = options.applicationService;
  if (applicationService === undefined) {
    throw new McpReadMountConfigurationError(
      'missing_read_application_service',
      'An mcp-read mount with Tools enabled requires a Collection read application service.',
    );
  }

  const snapshotLinkService = readOptionalSnapshotLinkService(options);
  const gatewayOptions = snapshotLinkService === undefined
    ? undefined
    : Object.freeze({
      snapshotLink: Object.freeze({
        manifest: Object.freeze({ serverUuid: validation.value.serverUuid }),
        applicationService: snapshotLinkService,
      }),
    });

  return Object.freeze({
    endpoint,
    resources: true,
    tools: createMcpReadToolGateway(applicationService, gatewayOptions),
  });
}

/** Domain-facing name for the same validated read-mount adapter. */
export const createMcpReadExposure = createMcpReadMountAdapter;

/**
 * Creates the optional anonymous, Resource-only surface for one exact mcp-read mount.
 * Public visibility remains an application-service decision; this adapter owns no ACL rules.
 * Successful projections are returned as deeply frozen own-data snapshots (same hardening as Tools).
 */
export function createMcpAnonymousReadExposure(
  manifest: unknown,
  options: McpAnonymousReadExposureOptions,
): McpAnonymousReadExposure {
  const validation = validateWireDocument<Manifest, SemanticIssue>(
    manifestValidators,
    'manifest',
    manifest,
    validateManifestSemantics,
  );
  if (!validation.valid) {
    const details = validation.stage === 'structural' ? validation.errors : validation.issues;
    throw new McpReadMountConfigurationError(
      'invalid_manifest',
      `Cannot expose anonymous MCP Resources from a Manifest that failed ${validation.stage} validation.`,
      details,
    );
  }

  assertExactOwnDataSurface(options, ['mountId', 'publicAccess']);
  const mountId = readOwnedAnonymousOption(options, 'mountId');
  if (typeof mountId !== 'string') {
    throw new McpReadMountConfigurationError(
      'mcp_read_mount_not_found',
      'Anonymous MCP exposure options must own a string mountId data property.',
    );
  }
  const accessPort = readPublicResourceAccessPort(options);
  const mount = selectOwnedAnonymousReadMount(validation.value, mountId);
  const endpoint = readOwnDataProperty(readOwnDataProperty(mount, 'endpoints'), 'mcp');
  const features = readOwnDataProperty(readOwnDataProperty(mount, 'features'), 'mcp');
  const resources = readOwnDataProperty(features, 'resources');
  const tools = readOwnDataProperty(features, 'tools');
  const anonymousRead = readOwnDataProperty(readOwnDataProperty(mount, 'auth'), 'anonymousRead');

  if (typeof endpoint !== 'string' || resources !== true || typeof tools !== 'boolean') {
    throw new McpReadMountConfigurationError(
      'mcp_read_mount_mismatch',
      'The selected anonymous mcp-read mount no longer matches its validated endpoint and capabilities.',
    );
  }
  if (anonymousRead !== true) {
    throw new McpReadMountConfigurationError(
      'anonymous_read_not_enabled',
      'The selected mcp-read mount does not enable anonymous reads.',
    );
  }

  const uriCodec = createMcpResourceUriCodec(validation.value);
  const readResource = async (...args: [uri: string]): Promise<unknown> => {
    if (args.length !== 1) throw unavailableAnonymousResource();
    try {
      const resource = uriCodec.parse(args[0]);
      const input = Object.freeze({ resource });
      const result = await Reflect.apply(accessPort.read, accessPort.receiver, [input]);
      if (result === undefined) throw unavailableAnonymousResource();
      // Detach and freeze so callers cannot mutate shared application projections.
      return snapshotMcpData(result);
    } catch {
      throw unavailableAnonymousResource();
    }
  };

  // Tools are intentionally absent even when this exact mount advertises them.
  return Object.freeze({ endpoint, resources: true, readResource });
}

/** Alternate word order retained for callers that lead with the anonymous transport mode. */
export const createAnonymousMcpReadExposure = createMcpAnonymousReadExposure;

function readOwnedMountId(options: McpReadMountAdapterOptions): string {
  if (typeof options !== 'object' || options === null) {
    throw new McpReadMountConfigurationError(
      'mcp_read_mount_not_found',
      'MCP read exposure options must own a mountId data property.',
    );
  }
  const descriptor = Object.getOwnPropertyDescriptor(options, 'mountId');
  if (descriptor === undefined || !('value' in descriptor) || typeof descriptor.value !== 'string') {
    throw new McpReadMountConfigurationError(
      'mcp_read_mount_not_found',
      'MCP read exposure options must own a string mountId data property.',
    );
  }
  return descriptor.value;
}

function readOptionalSnapshotLinkService(
  options: McpReadMountAdapterOptions,
): CollectionSnapshotLinkApplicationServicePort | undefined {
  if (typeof options !== 'object' || options === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(options, 'snapshotLinkService');
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor) || descriptor.enumerable !== true) {
    throw new McpReadMountConfigurationError(
      'missing_read_application_service',
      'snapshotLinkService must be an own enumerable data property when provided.',
    );
  }
  if (descriptor.value === undefined) return undefined;
  if (typeof descriptor.value !== 'object' || descriptor.value === null) {
    throw new McpReadMountConfigurationError(
      'missing_read_application_service',
      'snapshotLinkService must be a Collection snapshot link application service object.',
    );
  }
  return descriptor.value as CollectionSnapshotLinkApplicationServicePort;
}

function selectReadMount(manifest: Manifest, mountId: string): ManifestMount {
  const selected = manifest.mounts.find((mount) => mount.id === mountId);
  if (selected === undefined) {
    throw new McpReadMountConfigurationError(
      'mcp_read_mount_not_found',
      `Manifest does not declare mount ${mountId}.`,
    );
  }
  if (!selected.profiles.includes('mcp-read')) {
    throw new McpReadMountConfigurationError(
      'mcp_read_mount_mismatch',
      `Manifest mount ${mountId} does not declare the mcp-read profile.`,
    );
  }
  return selected;
}

function readOwnedAnonymousOption(
  options: McpAnonymousReadExposureOptions,
  name: keyof McpAnonymousReadExposureOptions,
): unknown {
  if (typeof options !== 'object' || options === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(options, name);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

function readPublicResourceAccessPort(options: McpAnonymousReadExposureOptions): {
  readonly receiver: object;
  readonly read: (
    input: Readonly<{ resource: McpReadResource }>,
  ) => unknown | PromiseLike<unknown>;
} {
  const candidate = readOwnedAnonymousOption(options, 'publicAccess');
  if (typeof candidate !== 'object' || candidate === null) {
    throw new McpReadMountConfigurationError(
      'missing_public_resource_access_service',
      'Anonymous MCP exposure requires a public Resource access application service.',
    );
  }
  assertExactOwnDataSurface(candidate, ['readPublicResource']);
  const descriptor = Object.getOwnPropertyDescriptor(candidate, 'readPublicResource');
  if (descriptor === undefined || !('value' in descriptor) || typeof descriptor.value !== 'function') {
    throw new McpReadMountConfigurationError(
      'missing_public_resource_access_service',
      'The public Resource access service must own a readPublicResource function.',
    );
  }
  return Object.freeze({
    receiver: candidate,
    read: descriptor.value,
  });
}

function assertExactOwnDataSurface(candidate: unknown, expected: readonly string[]): void {
  if (typeof candidate !== 'object' || candidate === null) {
    throw new McpReadMountConfigurationError(
      'missing_public_resource_access_service',
      'Anonymous MCP exposure requires an exact own-data configuration surface.',
    );
  }
  const keys = Reflect.ownKeys(candidate);
  if (
    keys.length !== expected.length
    || expected.some((name) => !keys.includes(name))
    || keys.some((key) => typeof key !== 'string')
  ) {
    throw new McpReadMountConfigurationError(
      'missing_public_resource_access_service',
      'Anonymous MCP exposure requires an exact own-data configuration surface.',
    );
  }
  for (const name of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(candidate, name);
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new McpReadMountConfigurationError(
        'missing_public_resource_access_service',
        'Anonymous MCP exposure requires an exact own-data configuration surface.',
      );
    }
  }
}

function unavailableAnonymousResource(): McpAnonymousResourceUnavailableError {
  return new McpAnonymousResourceUnavailableError();
}

function selectOwnedAnonymousReadMount(manifest: Manifest, mountId: string): ManifestMount {
  const mounts = readOwnDataProperty(manifest, 'mounts');
  if (!Array.isArray(mounts)) {
    throw new McpReadMountConfigurationError(
      'mcp_read_mount_not_found',
      'The validated Manifest no longer owns its mounts configuration.',
    );
  }

  for (let index = 0; index < mounts.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(mounts, String(index));
    if (descriptor === undefined || !('value' in descriptor)) continue;
    const candidate = descriptor.value;
    if (typeof candidate !== 'object' || candidate === null) continue;
    if (readOwnDataProperty(candidate, 'id') !== mountId) continue;
    const profiles = readOwnDataProperty(candidate, 'profiles');
    if (!ownArrayIncludes(profiles, 'mcp-read')) {
      throw new McpReadMountConfigurationError(
        'mcp_read_mount_mismatch',
        'The selected Manifest mount does not own the mcp-read profile.',
      );
    }
    return candidate as ManifestMount;
  }

  throw new McpReadMountConfigurationError(
    'mcp_read_mount_not_found',
    'The validated Manifest does not own the selected mount.',
  );
}

function readOwnDataProperty(candidate: unknown, name: string): unknown {
  if (typeof candidate !== 'object' || candidate === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(candidate, name);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

function ownArrayIncludes(candidate: unknown, expected: string): boolean {
  if (!Array.isArray(candidate)) return false;
  for (let index = 0; index < candidate.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
    if (descriptor !== undefined && 'value' in descriptor && descriptor.value === expected) return true;
  }
  return false;
}

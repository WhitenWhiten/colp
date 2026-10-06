/**
 * MCP-0007: mcp-write mount exposure — Tools required, with mcp-read + publisher
 * profile dependency closure. Fail closed when deps are missing or tools=false.
 */

import { createValidatorRegistry, validateWireDocument } from '../schema/index.js';
import { validateManifestSemantics, type SemanticIssue } from '../semantic/index.js';
import type { Manifest, ManifestMount } from '../types/index.js';
import type { McpChangePlanCommitTransaction } from './change-plan.js';
import {
  createMcpWriteToolGateway,
  type McpWriteToolGateway,
  type McpWriteToolGatewayOptions,
  type McpWriteTransportRequirements,
} from './write-tools.js';

export type McpWriteMountConfigurationErrorCode =
  | 'invalid_manifest'
  | 'mcp_write_mount_not_found'
  | 'mcp_write_mount_mismatch'
  | 'missing_profile_dependency'
  | 'tools_not_enabled'
  | 'missing_write_tool_options';

export class McpWriteMountConfigurationError extends TypeError {
  readonly code: McpWriteMountConfigurationErrorCode;
  readonly details: readonly unknown[];

  constructor(
    code: McpWriteMountConfigurationErrorCode,
    message: string,
    details: readonly unknown[] = [],
  ) {
    super(message);
    this.name = 'McpWriteMountConfigurationError';
    this.code = code;
    this.details = Object.freeze([...details]);
  }
}

export interface McpWriteMountAdapterOptions<
  Transaction extends McpChangePlanCommitTransaction = McpChangePlanCommitTransaction,
> {
  /** Selects exactly one write mount; implicit selection is deliberately unsupported. */
  readonly mountId: string;
  /** Write Tool gateway options (change plan ports, optional key tools). */
  readonly writeTools: McpWriteToolGatewayOptions<Transaction>;
}

export interface McpWriteMountAdapter {
  readonly endpoint: string;
  readonly resources: true;
  readonly tools: McpWriteToolGateway;
  readonly profiles: readonly string[];
  /** Host HTTP adapter contract; raw bodies must be rejected before JSON parsing. */
  readonly transportRequirements: McpWriteTransportRequirements;
}

const manifestValidators = createValidatorRegistry();

/**
 * Resolves one validated mcp-write Manifest mount into its runtime write exposure.
 * Schema and profile dependency rules remain owned by the canonical validators;
 * this adapter fail-closes if the selected mount no longer matches after validation.
 */
export function createMcpWriteMountAdapter<
  Transaction extends McpChangePlanCommitTransaction,
>(
  manifest: unknown,
  options: McpWriteMountAdapterOptions<Transaction>,
): McpWriteMountAdapter {
  const validation = validateWireDocument<Manifest, SemanticIssue>(
    manifestValidators,
    'manifest',
    manifest,
    validateManifestSemantics,
  );
  if (!validation.valid) {
    const details = validation.stage === 'structural' ? validation.errors : validation.issues;
    throw new McpWriteMountConfigurationError(
      'invalid_manifest',
      `Cannot expose an MCP write mount from a Manifest that failed ${validation.stage} validation.`,
      details,
    );
  }

  const mountId = readOwnedMountId(options);
  const mount = selectWriteMount(validation.value, mountId);
  const endpoint = mount.endpoints.mcp;
  const mcpFeatures = mount.features.mcp;
  const profiles = Object.freeze([...mount.profiles]);

  // Projection postconditions — fail closed if a hostile accessor mutated state.
  if (
    !profiles.includes('mcp-write')
    || typeof endpoint !== 'string'
    || mcpFeatures?.resources !== true
  ) {
    throw new McpWriteMountConfigurationError(
      'mcp_write_mount_mismatch',
      'The selected mcp-write mount no longer matches its validated endpoint and capabilities.',
    );
  }

  // MCP-0007: write mounts must declare mcp-read + publisher dependencies.
  if (!profiles.includes('mcp-read') || !profiles.includes('publisher')) {
    throw new McpWriteMountConfigurationError(
      'missing_profile_dependency',
      'Profile mcp-write requires profiles mcp-read and publisher on the same mount.',
    );
  }

  // MCP-0007: write mounts must enable Tools.
  if (mcpFeatures.tools !== true) {
    throw new McpWriteMountConfigurationError(
      'tools_not_enabled',
      'Profile mcp-write requires features.mcp.tools=true.',
    );
  }

  const writeToolOptions = readWriteToolOptions(options);
  const tools = createMcpWriteToolGateway(writeToolOptions);

  return Object.freeze({
    endpoint,
    resources: true as const,
    tools,
    profiles,
    transportRequirements: tools.transportRequirements,
  });
}

/** Domain-facing name for the same validated write-mount adapter. */
export const createMcpWriteExposure = createMcpWriteMountAdapter;

/**
 * Returns true when a tool name is a write-surface tool (not a pure read tool).
 * Used to assert mcp-read mounts never advertise write tools.
 */
export function isMcpWriteToolName(name: string): boolean {
  if (typeof name !== 'string') return false;
  if (
    name === 'changes.plan'
    || name === 'changes.commit'
    || name === 'changes.cancel'
    || name === 'keys.create'
    || name === 'keys.rotate'
    || name === 'keys.revoke'
  ) {
    return true;
  }
  // Common write tool prefixes from the MCP profile surface.
  const writePrefixes = [
    'collections.create',
    'collections.update',
    'collections.delete',
    'nodes.create',
    'nodes.update',
    'nodes.move',
    'nodes.delete',
    'annotations.create',
    'annotations.update',
    'attachments.create',
    'attachments.update',
    'relations.create',
    'relations.update',
    'access.',
    'rate_limits.',
    'release.publish',
    'sync.push',
    'sync.mirror',
    'sync.resolve_conflict',
  ];
  return writePrefixes.some((prefix) => name === prefix || name.startsWith(prefix));
}

function readOwnedMountId(
  options: Pick<McpWriteMountAdapterOptions, 'mountId'>,
): string {
  if (typeof options !== 'object' || options === null) {
    throw new McpWriteMountConfigurationError(
      'mcp_write_mount_not_found',
      'MCP write exposure options must own a mountId data property.',
    );
  }
  const descriptor = Object.getOwnPropertyDescriptor(options, 'mountId');
  if (descriptor === undefined || !('value' in descriptor) || typeof descriptor.value !== 'string') {
    throw new McpWriteMountConfigurationError(
      'mcp_write_mount_not_found',
      'MCP write exposure options must own a string mountId data property.',
    );
  }
  return descriptor.value;
}

function readWriteToolOptions<
  Transaction extends McpChangePlanCommitTransaction,
>(
  options: McpWriteMountAdapterOptions<Transaction>,
): McpWriteToolGatewayOptions<Transaction> {
  if (typeof options !== 'object' || options === null) {
    throw new McpWriteMountConfigurationError(
      'missing_write_tool_options',
      'MCP write exposure requires writeTools options.',
    );
  }
  const descriptor = Object.getOwnPropertyDescriptor(options, 'writeTools');
  if (descriptor === undefined || !('value' in descriptor) || typeof descriptor.value !== 'object' || descriptor.value === null) {
    throw new McpWriteMountConfigurationError(
      'missing_write_tool_options',
      'MCP write exposure requires an own-data writeTools options object.',
    );
  }
  return descriptor.value as McpWriteToolGatewayOptions<Transaction>;
}

function selectWriteMount(manifest: Manifest, mountId: string): ManifestMount {
  const selected = manifest.mounts.find((mount) => mount.id === mountId);
  if (selected === undefined) {
    throw new McpWriteMountConfigurationError(
      'mcp_write_mount_not_found',
      `Manifest does not declare mount ${mountId}.`,
    );
  }
  if (!selected.profiles.includes('mcp-write')) {
    throw new McpWriteMountConfigurationError(
      'mcp_write_mount_mismatch',
      `Manifest mount ${mountId} does not declare the mcp-write profile.`,
    );
  }
  return selected;
}

import { getLevelOneUriTemplateVariables } from '../schema/index.js';
import { MCP_PROTOCOL_VERSION } from '../shared/mcp-protocol-version.js';
import type { Manifest } from '../types/index.js';
import {
  endpointContracts,
  type EndpointKey,
  profileDependencies,
  profileRequiredEndpoints,
  type ProtocolProfile,
} from './endpoint-contracts.js';
import type { SemanticIssue, SemanticValidationResult } from './index.js';

function issue(code: string, path: string, message: string): SemanticIssue {
  return { code, path, message };
}

const protocolProfiles = new Set<unknown>(Object.keys(profileDependencies));

export function validateManifestSemantics(manifest: Manifest): SemanticValidationResult {
  const issues: SemanticIssue[] = [];
  const mountIds = new Set<string>();

  manifest.mounts.forEach((mount, mountIndex) => {
    const mountPath = `/mounts/${mountIndex}`;
    const profiles: ProtocolProfile[] = [];
    (mount.profiles as readonly unknown[]).forEach((profile, profileIndex) => {
      if (!protocolProfiles.has(profile)) {
        issues.push(
          issue(
            'invalid_profile',
            `${mountPath}/profiles/${profileIndex}`,
            `Profile ${String(profile)} is not valid in a Manifest.`,
          ),
        );
        return;
      }
      profiles.push(profile as ProtocolProfile);
    });
    if (mountIds.has(mount.id)) {
      issues.push(issue('duplicate_mount_id', `${mountPath}/id`, `Mount ID ${mount.id} is reused.`));
    }
    mountIds.add(mount.id);

    const endpointEntries = Object.entries(mount.endpoints) as [EndpointKey, string][];
    for (const [endpointKey, template] of endpointEntries) {
      const contract = endpointContracts[endpointKey];
      const variables = getLevelOneUriTemplateVariables(template);
      if (variables === null) {
        issues.push(
          issue(
            'invalid_endpoint_template',
            `${mountPath}/endpoints/${endpointKey}`,
            `Endpoint ${endpointKey} is not an absolute RFC 6570 Level 1 service template.`,
          ),
        );
        continue;
      }
      const expected = [...contract.variables].sort();
      if (variables.join('\u0000') !== expected.join('\u0000')) {
        issues.push(
          issue(
            'invalid_endpoint_variables',
            `${mountPath}/endpoints/${endpointKey}`,
            `Endpoint ${endpointKey} uses [${variables.join(', ')}], expected [${expected.join(', ')}].`,
          ),
        );
      }
    }

    for (const profile of profiles) {
      for (const dependency of profileDependencies[profile]) {
        if (!profiles.includes(dependency)) {
          issues.push(
            issue(
              'missing_profile_dependency',
              `${mountPath}/profiles`,
              `Profile ${profile} requires profile ${dependency}.`,
            ),
          );
        }
      }
      for (const endpointKey of profileRequiredEndpoints[profile]) {
        if (!(endpointKey in mount.endpoints)) {
          issues.push(
            issue(
              'missing_profile_endpoint',
              `${mountPath}/endpoints`,
              `Profile ${profile} requires endpoint ${endpointKey}.`,
            ),
          );
        }
      }
    }

    const hasMcpRead = profiles.includes('mcp-read');
    const hasMcpWrite = profiles.includes('mcp-write');
    if ((hasMcpRead || hasMcpWrite) && mount.features.mcp?.resources !== true) {
      issues.push(
        issue(
          'missing_mcp_resources_capability',
          `${mountPath}/features/mcp/resources`,
          'Profiles mcp-read and mcp-write require the MCP Resources capability.',
        ),
      );
    }
    if ((hasMcpRead || hasMcpWrite) && mount.features.mcp?.protocolVersion !== MCP_PROTOCOL_VERSION) {
      issues.push(
        issue(
          'invalid_mcp_protocol_version',
          `${mountPath}/features/mcp/protocolVersion`,
          `MCP profiles require features.mcp.protocolVersion ${MCP_PROTOCOL_VERSION}.`,
        ),
      );
    }
    if (hasMcpWrite && mount.features.mcp?.tools !== true) {
      issues.push(
        issue(
          'missing_mcp_tools_capability',
          `${mountPath}/features/mcp/tools`,
          'Profile mcp-write requires the MCP Tools capability.',
        ),
      );
    }
  });

  return issues.length === 0
    ? { valid: true, issues: [] }
    : { valid: false, issues: Object.freeze(issues) };
}

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

import * as rootApi from '../../src/index.js';
import {
  MCP_PROTOCOL_VERSION,
  supportedMcpProtocolVersions,
} from '../../src/mcp/protocol-version.js';
import { createValidatorRegistry } from '../../src/schema/index.js';
import { validateManifestSemantics } from '../../src/semantic/index.js';
import type { Manifest } from '../../src/types/index.js';
import { mcpMigrationProtocolVersion } from '../../scripts/lib/conformance-evidence.mjs';

const repositoryRoot = resolve(import.meta.dirname, '..', '..', '..', '..');
const packageRoot = resolve(import.meta.dirname, '..', '..');
const profileDocPath = resolve(repositoryRoot, 'protocol', 'docs', '05-mcp-profile.md');
const registryPath = resolve(packageRoot, 'fixtures', 'protocol', 'requirements.yaml');
const generatedTypesPath = resolve(packageRoot, 'src', 'types', 'generated.ts');
const examplesRoot = resolve(packageRoot, 'fixtures', 'protocol', 'examples');

const officialLinks = [
  'https://modelcontextprotocol.io/specification/2026-07-28/changelog',
  'https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http',
  'https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning',
  'https://modelcontextprotocol.io/specification/2026-07-28/server/discover',
  'https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions',
  'https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr',
] as const;

const rejectionHeading = '## 27. 迁移说明与拒绝样例';

/** Terms that must never appear as positive Modern contract outside the rejection section. */
const legacyTerms = [
  '2025-11-25',
  'initialize',
  'notifications/initialized',
  'Mcp-Session-Id',
  'MCP-Session-Id',
  'MCP Session',
  'resources/subscribe',
  'resources/unsubscribe',
  'Last-Event-ID',
  'logging/setLevel',
  'ping',
  'GET  /collections/-/mcp',
  'DELETE /collections/-/mcp',
] as const;

async function readJson<T>(...segments: readonly string[]): Promise<T> {
  return JSON.parse(await readFile(resolve(examplesRoot, ...segments), 'utf8')) as T;
}

describe('MCP 2026-07-28 normative baseline (COLP-MCP-02)', () => {
  it('publishes a single frozen 2026-07-28 protocol version constant [evidence:mcp.protocol-version-constant]', () => {
    expect(MCP_PROTOCOL_VERSION).toBe('2026-07-28');
    expect(supportedMcpProtocolVersions).toEqual(['2026-07-28']);
    expect(Object.isFrozen(supportedMcpProtocolVersions)).toBe(true);
    expect(MCP_PROTOCOL_VERSION).toBe(mcpMigrationProtocolVersion);
    // COLP-MCP-12: MCP wire-version metadata lives on /mcp (and the versioned
    // subpath), never on the package root.
    expect(rootApi as Record<string, unknown>).not.toHaveProperty('MCP_PROTOCOL_VERSION');
    expect(rootApi as Record<string, unknown>).not.toHaveProperty('supportedMcpProtocolVersions');
  });

  it('references the official 2026-07-28 specification links in the MCP Profile [evidence:mcp.normative-modern-links]', async () => {
    const source = await readFile(profileDocPath, 'utf8');
    for (const link of officialLinks) {
      expect(source, link).toContain(link);
    }
  });

  it('describes the per-request _meta request context [evidence:mcp.request-context-meta]', async () => {
    const source = await readFile(profileDocPath, 'utf8');
    expect(source).toContain('io.modelcontextprotocol/protocolVersion');
    expect(source).toContain('io.modelcontextprotocol/clientCapabilities');
    expect(source).toContain('clientInfo');
    expect(source).toContain('serverInfo');
  });

  it('defines standard and custom request headers [evidence:mcp.headers-contract]', async () => {
    const source = await readFile(profileDocPath, 'utf8');
    expect(source).toContain('Mcp-Method');
    expect(source).toContain('Mcp-Name');
    expect(source).toContain('Mcp-Param-');
    expect(source).toContain('x-mcp-header');
    expect(source).toContain('=?base64?...?=');
    expect(source).toContain('RFC 9110');
  });

  it('defines the modern subscriptions/listen contract [evidence:mcp.listen-contract]', async () => {
    const source = await readFile(profileDocPath, 'utf8');
    expect(source).toContain('subscriptions/listen');
    expect(source).toContain('notifications/subscriptions/acknowledged');
    expect(source).toContain('resourceSubscriptions');
  });

  it('defines the MRTR input_required contract [evidence:mcp.mrtr-contract]', async () => {
    const source = await readFile(profileDocPath, 'utf8');
    expect(source).toContain('input_required');
    expect(source).toContain('requestState');
    expect(source).toContain('inputRequests');
  });

  it('defines the JSON Schema 2020-12 tool schema budget [evidence:mcp.schema-budget]', async () => {
    const source = await readFile(profileDocPath, 'utf8');
    expect(source).toContain('JSON Schema 2020-12');
    expect(source).toContain('$ref');
    expect(source).toContain('structuredContent');
  });

  it('binds OAuth client credentials to the issuer [evidence:mcp.oauth-issuer-binding]', async () => {
    const authDocPath = resolve(
      repositoryRoot,
      'protocol',
      'docs',
      '04-auth-security-rate-limit.md',
    );
    const source = await readFile(authDocPath, 'utf8');
    expect(source).toContain('RFC 9207');
    expect(source).toContain('iss');
    expect(source).toContain('application_type');
    expect(source).toContain('issuer');
  });
  it('keeps legacy MCP semantics only inside the migration rejection section [evidence:mcp.normative-old-semantics-rejected]', async () => {
    const source = await readFile(profileDocPath, 'utf8');
    const rejectionIndex = source.indexOf(rejectionHeading);
    expect(rejectionIndex).toBeGreaterThanOrEqual(0);

    const normative = source.slice(0, rejectionIndex);
    for (const term of legacyTerms) {
      expect(normative, `legacy term ${term} escaped the rejection section`).not.toContain(term);
    }

    const rejection = source.slice(rejectionIndex);
    expect(rejection).toContain('initialize');
    expect(rejection).toContain('Mcp-Session-Id');
    expect(rejection).toContain('Last-Event-ID');
  });

  it('requires features.mcp.protocolVersion to be the exact 2026-07-28 const [evidence:mcp.manifest-protocol-version]', async () => {
    const registry = createValidatorRegistry();
    const manifest = await readJson<Manifest>('public-manifest.json');

    expect(registry.validate('manifest', manifest).valid).toBe(true);
    expect(validateManifestSemantics(manifest)).toEqual({ valid: true, issues: [] });

    const missing = structuredClone(manifest) as Manifest;
    delete (missing.mounts[0]!.features.mcp as unknown as Record<string, unknown>).protocolVersion;
    expect(registry.validate('manifest', missing).valid).toBe(false);

    const stale = structuredClone(manifest) as Manifest;
    (stale.mounts[0]!.features.mcp as unknown as Record<string, unknown>).protocolVersion =
      '2025-11-25';
    expect(registry.validate('manifest', stale).valid).toBe(false);
    const staleSemantics = validateManifestSemantics(stale);
    expect(staleSemantics.valid).toBe(false);
    if (!staleSemantics.valid) {
      expect(staleSemantics.issues.some((item) => item.code === 'invalid_mcp_protocol_version')).toBe(
        true,
      );
    }
  });

  it('registers only modern MCP contract requirements in the registry [evidence:mcp.registry-modern-baseline]', async () => {
    const registry = parseYaml(await readFile(registryPath, 'utf8')) as {
      requirements: ReadonlyArray<{
        id: string;
        profile: string;
        requirement: string;
      }>;
    };
    const mcpRecords = registry.requirements.filter(
      (record) => record.profile === 'mcp-read' || record.profile === 'mcp-write',
    );
    expect(mcpRecords.length).toBeGreaterThanOrEqual(16);
    for (const record of mcpRecords) {
      expect(['mcp-read', 'mcp-write'], record.id).toContain(record.profile);
    }

    const requirementText = mcpRecords.map((record) => record.requirement).join('\n');
    for (const topic of [
      'server/discover',
      'Mcp-Method',
      'subscriptions/listen',
      'resultType',
      'requestState',
      'input_required',
      'protocolVersion',
      'Mcp-Param',
      'cacheScope',
    ] as const) {
      expect(requirementText, topic).toContain(topic);
    }

    const rejectionRecord = mcpRecords.find((record) => record.id === 'MCP-0024');
    expect(rejectionRecord).toBeDefined();
    expect(rejectionRecord!.requirement).toContain('initialize');

    for (const record of mcpRecords) {
      if (record.id === 'MCP-0024') continue;
      for (const term of legacyTerms) {
        expect(record.requirement, `${record.id} must not positively require ${term}`).not.toContain(
          term,
        );
      }
    }

    const allRequirementText = registry.requirements
      .map((record) => record.requirement)
      .join('\n');
    expect(allRequirementText).toContain('iss');
  });

  it('reflects the const protocol version in generated TypeScript types [evidence:mcp.generated-types-protocol-version]', async () => {
    const source = await readFile(generatedTypesPath, 'utf8');
    expect(source).toContain("protocolVersion: '2026-07-28'");
    expect(source).not.toContain('mcpSessionId');
  });

  it('keeps canonical examples on the modern wire contract [evidence:mcp.modern-examples]', async () => {
    const publicManifest = await readJson<{
      mounts: ReadonlyArray<{
        features: { mcp: { protocolVersion: string; resources: boolean; tools: boolean } };
      }>;
    }>('public-manifest.json');
    expect(publicManifest.mounts[0]!.features.mcp).toEqual({
      protocolVersion: '2026-07-28',
      resources: true,
      tools: true,
    });

    const toolsList = await readJson<{
      result: { resultType: string; ttlMs: number; cacheScope: string };
    }>('mcp-tools-list.json');
    expect(toolsList.result.resultType).toBe('complete');
    expect(toolsList.result.cacheScope).toBe('public');
    expect(Number.isInteger(toolsList.result.ttlMs)).toBe(true);
    expect(toolsList.result.ttlMs).toBeGreaterThan(0);
  });
});

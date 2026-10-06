import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createValidatorRegistry } from '../../src/schema/index.js';
import { validateManifestSemantics } from '../../src/semantic/index.js';
import type { Manifest } from '../../src/types/index.js';

const fixturesPath = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');

async function fixture(name: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(resolve(fixturesPath, name), 'utf8')) as Record<string, any>;
}

describe('Access Policy contract', () => {
  const registry = createValidatorRegistry();

  it('requires implicit full-chain inheritance and rejects the legacy inherit switch', async () => {
    const accessPolicy = await fixture('access-policy.json');
    expect(registry.validate('accessPolicy', accessPolicy).valid).toBe(true);

    accessPolicy.inherit = false;
    expect(registry.validate('accessPolicy', accessPolicy).valid).toBe(false);
    expect(registry.validate('accessPolicyPatch', { visibility: 'private' }).valid).toBe(true);
    expect(registry.validate('accessPolicyPatch', { inherit: false }).valid).toBe(false);
  });
});

describe('MCP Manifest capability contract [evidence:schema.mcp-read-resource-only]', () => {
  const registry = createValidatorRegistry();

  it('accepts a Resource-only mcp-read mount [evidence:schema.mcp-read-resource-only]', async () => {
    const manifest = await fixture('public-manifest.json');
    manifest.mounts[0].profiles = ['core', 'mcp-read'];
    manifest.mounts[0].features.mcp = { protocolVersion: '2026-07-28', resources: true, tools: false };

    expect(registry.validate('manifest', manifest).valid).toBe(true);
  });

  it.each([
    ['Resource-only', true, 'https://alice.example/collections/-/mcp', true],
    ['Tools-enabled read', true, 'https://alice.example/collections/-/mcp', true],
    ['Resources disabled', false, 'https://alice.example/collections/-/mcp', false],
    ['MCP endpoint missing', true, undefined, false],
  ] as const)(
    'keeps schema and semantic results aligned for %s mcp-read manifests [evidence:schema.mcp-read-resource-only]',
    async (label, resources, endpoint, expectedValid) => {
      const manifest = await fixture('public-manifest.json') as Manifest;
      const mount = manifest.mounts[0]!;
      mount.profiles = ['core', 'mcp-read'];
      mount.features.mcp = { protocolVersion: '2026-07-28', resources, tools: label === 'Tools-enabled read' };
      if (endpoint === undefined) delete mount.endpoints.mcp;
      else (mount.endpoints as unknown as { mcp: unknown }).mcp = endpoint;

      expect(registry.validate('manifest', manifest).valid).toBe(expectedValid);
      expect(validateManifestSemantics(manifest).valid).toBe(expectedValid);
    },
  );

  it('rejects mcp-write when Tools are disabled', async () => {
    const manifest = await fixture('public-manifest.json');
    manifest.mounts[0].features.mcp = { protocolVersion: '2026-07-28', resources: true, tools: false };

    expect(registry.validate('manifest', manifest).valid).toBe(false);
  });

  it('retains the mcp-read and publisher dependencies for mcp-write', async () => {
    const manifest = await fixture('public-manifest.json');
    manifest.mounts[0].profiles = ['core', 'mcp-write'];
    manifest.mounts[0].features.mcp = { protocolVersion: '2026-07-28', resources: true, tools: true };

    expect(registry.validate('manifest', manifest).valid).toBe(false);
  });
});

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { validateManifestSemantics } from '../../src/semantic/index.js';
import type { Manifest } from '../../src/types/index.js';

const fixturePath = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples', 'public-manifest.json');

async function fixture(): Promise<Manifest> {
  return JSON.parse(await readFile(fixturePath, 'utf8')) as Manifest;
}

describe('manifest semantics', () => {
  it('accepts the canonical manifest', async () => {
    expect(validateManifestSemantics(await fixture())).toEqual({ valid: true, issues: [] });
  });

  it('accepts a Resource-only mcp-read mount', async () => {
    const manifest = await fixture();
    manifest.mounts[0]!.profiles = ['core', 'mcp-read'];
    manifest.mounts[0]!.features.mcp = { protocolVersion: '2026-07-28', resources: true, tools: false };

    expect(validateManifestSemantics(manifest)).toEqual({ valid: true, issues: [] });
  });

  it('rejects mcp-write without the Tools capability', async () => {
    const manifest = await fixture();
    manifest.mounts[0]!.features.mcp = { protocolVersion: '2026-07-28', resources: true, tools: false };

    const result = validateManifestSemantics(manifest);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.some((item) => item.code === 'missing_mcp_tools_capability')).toBe(true);
    }
  });

  it('rejects mcp-write without its profile dependencies', async () => {
    const manifest = await fixture();
    manifest.mounts[0]!.profiles = ['core', 'mcp-write'];
    manifest.mounts[0]!.features.mcp = { protocolVersion: '2026-07-28', resources: true, tools: true };

    const result = validateManifestSemantics(manifest);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.filter((item) => item.code === 'missing_profile_dependency')).toHaveLength(2);
    }
  });

  it('rejects wrong and missing endpoint variables', async () => {
    const manifest = await fixture();
    manifest.mounts[0]!.endpoints.node =
      'https://alice.example/collections/c/{collectionId}/nodes/{annotationId}' as never;
    const result = validateManifestSemantics(manifest);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.issues[0]?.code).toBe('invalid_endpoint_variables');
  });

  it('rejects duplicate mount IDs', async () => {
    const manifest = await fixture();
    manifest.mounts.push(structuredClone(manifest.mounts[0]!));
    const result = validateManifestSemantics(manifest);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.issues.some((item) => item.code === 'duplicate_mount_id')).toBe(true);
  });

  it('reports missing endpoints that schema-independent callers require', async () => {
    const manifest = await fixture();
    delete manifest.mounts[0]!.endpoints.syncAck;
    const result = validateManifestSemantics(manifest);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.issues.some((item) => item.code === 'missing_profile_endpoint')).toBe(true);
  });

  it('rejects malformed endpoint templates semantically', async () => {
    const manifest = await fixture();
    manifest.mounts[0]!.endpoints.node = 'https://alice.example/bad path/{nodeId}' as never;
    const result = validateManifestSemantics(manifest);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.issues.some((item) => item.code === 'invalid_endpoint_template')).toBe(true);
  });
});

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import * as rootApi from '../../src/index.js';
import {
  MCP_PROTOCOL_VERSION,
  supportedMcpProtocolVersions,
} from '../../src/mcp/protocol-version.js';
import { createValidatorRegistry } from '../../src/schema/index.js';
import { validateManifestSemantics } from '../../src/semantic/index.js';
import type { Manifest } from '../../src/types/index.js';

const packageRoot = resolve(import.meta.dirname, '..', '..');
const generatedTypesPath = resolve(packageRoot, 'src', 'types', 'generated.ts');
const examplesRoot = resolve(packageRoot, 'fixtures', 'protocol', 'examples');

async function readJson<T>(...segments: readonly string[]): Promise<T> {
  return JSON.parse(await readFile(resolve(examplesRoot, ...segments), 'utf8')) as T;
}

describe('MCP 2026-07-28 protocol baseline', () => {
  it('publishes a single frozen 2026-07-28 protocol version constant [evidence:mcp.protocol-version-constant]', () => {
    expect(MCP_PROTOCOL_VERSION).toBe('2026-07-28');
    expect(supportedMcpProtocolVersions).toEqual(['2026-07-28']);
    expect(Object.isFrozen(supportedMcpProtocolVersions)).toBe(true);
    // COLP-MCP-12: MCP wire-version metadata lives on /mcp (and the versioned
    // subpath), never on the package root.
    expect(rootApi as Record<string, unknown>).not.toHaveProperty('MCP_PROTOCOL_VERSION');
    expect(rootApi as Record<string, unknown>).not.toHaveProperty('supportedMcpProtocolVersions');
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

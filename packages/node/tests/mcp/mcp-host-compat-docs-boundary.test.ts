/**
 * T-11: host compatibility is outside the COLP Profile. Pin ARCHITECTURE /
 * MCP_SDK_POLICY host-compat boundary and freeze `/mcp` package exports.
 * Do not weaken mcp-2026-07-28-sdk-lock-contract.test.ts.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const packageRoot = resolve(import.meta.dirname, '..', '..');

type PackageJson = {
  readonly exports?: Readonly<Record<string, unknown>>;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
};

const MCP_EXPORT = Object.freeze({
  types: {
    import: './dist/mcp/index.d.ts',
    require: './dist/mcp/index.d.cts',
  },
  import: './dist/mcp/index.js',
  require: './dist/mcp/index.cjs',
});

const MCP_2026_07_28_EXPORT = Object.freeze({
  types: {
    import: './dist/mcp/2026-07-28/index.d.ts',
    require: './dist/mcp/2026-07-28/index.d.cts',
  },
  import: './dist/mcp/2026-07-28/index.js',
  require: './dist/mcp/2026-07-28/index.cjs',
});

describe('host MCP compatibility stays outside COLP Profile claims', () => {
  it('ARCHITECTURE.md allows a host surface outside the Profile endpoint', async () => {
    const architecture = await readFile(resolve(packageRoot, 'docs', 'ARCHITECTURE.md'), 'utf8');
    expect(architecture).toContain('product compatibility surface');
    expect(architecture).toContain('outside the Profile endpoint');
    expect(architecture).toContain('must not enter Manifest');
    expect(architecture).toContain('Profile claims');
    expect(architecture).toContain('conformance evidence');
    expect(architecture).toContain('2026-07-28');
    expect(architecture).toContain('@collection-protocol/node/mcp');
    expect(architecture).toContain('@collection-protocol/node/mcp/2026-07-28');
  });

  it('MCP_SDK_POLICY.md records the host-compat boundary and profile review', async () => {
    const policy = await readFile(resolve(packageRoot, 'docs', 'MCP_SDK_POLICY.md'), 'utf8');
    expect(policy).toContain('product compatibility surface');
    expect(policy).toContain('outside the Profile endpoint');
    expect(policy).toContain('must not enter Manifest');
    expect(policy).toContain('Profile claims');
    expect(policy).toContain('conformance evidence');
    expect(policy).toContain('2026-07-28');
    expect(policy).toContain('protocol/docs/05-mcp-profile.md');
    expect(policy).toContain('已检查、无需改');
    expect(policy).not.toContain('@modelcontextprotocol/node');
  });

  it('keeps /mcp and /mcp/2026-07-28 exports and check:mcp-legacy-absence unchanged', async () => {
    const pkg = JSON.parse(
      await readFile(resolve(packageRoot, 'package.json'), 'utf8'),
    ) as PackageJson;
    expect(pkg.exports?.['./mcp']).toEqual(MCP_EXPORT);
    expect(pkg.exports?.['./mcp/2026-07-28']).toEqual(MCP_2026_07_28_EXPORT);
    expect(pkg.scripts?.['check:mcp-legacy-absence']).toBe(
      'node scripts/check-mcp-legacy-absence.mjs',
    );
    expect(pkg.dependencies?.['@modelcontextprotocol/node']).toBeUndefined();
  });
});

/**
 * Freezes the `/mcp` package exports. Host compatibility surfaces live outside
 * the COLP Profile (see docs/MCP_SDK_POLICY.md).
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

describe('MCP package exports', () => {
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

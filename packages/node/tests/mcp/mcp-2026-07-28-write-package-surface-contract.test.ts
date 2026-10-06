/**
 * COLP-MCP-13: Modern MCP Write package surface + Read-only consumer
 * regression (tests-first).
 *
 * Hard gates:
 * - `/mcp` and `/mcp/2026-07-28` add the implemented Modern Write adapter
 *   surface (factory + result/status/port types) to the COLP-MCP-12 Read
 *   surface without removing any Read API key (Read key set stays a subset);
 * - the internal Write Gateway module (`src/mcp/write-tools.ts`) and the
 *   pre-Modern write factories stay absent from both entries;
 * - source scans find no Legacy Session wire symbols in the Write adapter;
 * - `npm pack --dry-run` still includes the packed `dist/mcp` artifacts and
 *   never the fixture host / reference client (skipped unless `dist/mcp`
 *   exists; the CI package job builds first). The same listing must include
 *   the host-boundary docs and must omit `tests/fixtures/mcp-2026-07-28`.
 *
 * Dist-gated (skipped unless a prior `npm run build` emitted `dist/mcp`):
 * - packed ESM and CJS runtimes expose the same key set including the Modern
 *   Write API with Read keys intact.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import * as mcpApi from '../../src/mcp/index.js';
import * as mcpVersionedApi from '../../src/mcp/2026-07-28/index.js';

const execFileAsync = promisify(execFile);
const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const packageRoot = resolve(import.meta.dirname, '..', '..');
const distMcpDir = join(packageRoot, 'dist', 'mcp');
const distVersionedMcpDir = join(distMcpDir, '2026-07-28');
const distPresent = existsSync(join(distMcpDir, 'index.js'));

/** Every COLP-MCP-12 Read + shared key must survive the Write addition. */
const READ_SURFACE_KEYS = [
  'MCP_PROTOCOL_VERSION',
  'supportedMcpProtocolVersions',
  'createAnonymousPublicBinding',
  'createAuthenticatedBinding',
  'mapStdioEvidenceToAuthenticatedBinding',
  'snapshotMcpAuthorizationBinding',
  'requireAuthenticatedWriteBinding',
  'createMcpStatelessReadCore',
  'requireTrustedReadRequestContext',
  'createMcpStatelessToolCore',
  'snapshotMcpChangeSignal',
  'createMcp20260728RequestContext',
  'requireMcp20260728RequestContext',
  'createMcp20260728DiscoverResult',
  'createMcp20260728Result',
  'normalizeMcp20260728Error',
  'createMcp20260728ResourceAdapter',
  'createMcp20260728ReadToolAdapter',
  'createMcp20260728SubscriptionsListenAdapter',
  'assertMcpSchemaWithinBudget',
  'MCP_SDK_PROTOCOL_VERSION',
  'enforceOAuthPkce',
  'enforceOAuthAuthorizationResponseIss',
  'buildOAuthDcrClientMetadata',
] as const;

/** New Modern Write API keys added by COLP-MCP-13 (additive). */
const WRITE_SURFACE_KEYS = [
  'createMcp20260728WriteToolAdapter',
  'Mcp20260728WriteRequestStateError',
  'createChangePlanService',
  'McpChangePlanError',
] as const;

/** Legacy / Session-oriented / old write-factory symbols that must stay absent. */
const LEGACY_WRITE_SYMBOLS = [
  'McpSessionBinding',
  'McpReadResourceServerSession',
  'createMcpReadResourceServer',
  'createMcpStdioCredentialBinding',
  'McpStdioCredentialBinding',
  'subscribeResource',
  'unsubscribeResource',
  'createMcpWriteExposure',
  'createMcpWriteMountAdapter',
  'createMcpWriteToolGateway',
  'createInMemoryPlanStore',
  'McpTrustedWriteRequestContext',
] as const;

function present(api: Readonly<Record<string, unknown>>, keys: readonly string[]): string[] {
  return keys.filter((key) => !(key in api));
}

function absent(api: Readonly<Record<string, unknown>>, keys: readonly string[]): string[] {
  return keys.filter((key) => key in api);
}

describe('MCP 2026-07-28 Modern Write package surface', () => {
  it('ships host-boundary docs in files and keeps src/tests/coverage out of the tarball whitelist', () => {
    const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      files?: readonly string[];
    };

    expect(packageJson.files).toContain('dist');
    expect(packageJson.files).toContain('docs/HOST_INTEGRATION_BOUNDARY.md');
    expect(packageJson.files).toContain('docs/SECURITY_COMPOSITION.md');
    expect(packageJson.files).toContain('docs/SYNC_HOST_COMPOSITION.md');
    for (const excluded of [
      'src',
      'src/',
      'tests',
      'tests/',
      'coverage',
      'coverage/',
      'docs',
      'docs/',
      'docs/progress',
      'docs/audits',
    ] as const) {
      expect(packageJson.files, excluded).not.toContain(excluded);
    }
  });

  it('exposes the Modern Write API on both supported entries without dropping a Read key', () => {
    for (const [label, api] of [
      ['/mcp', mcpApi],
      ['/mcp/2026-07-28', mcpVersionedApi],
    ] as const) {
      expect(present(api, READ_SURFACE_KEYS), `${label} Read key presence`).toEqual([]);
      expect(present(api, WRITE_SURFACE_KEYS), `${label} Write key presence`).toEqual([]);
      expect(absent(api, LEGACY_WRITE_SYMBOLS), `${label} Legacy write absence`).toEqual([]);
    }
  });

  it('keeps both entries key-identical (versioned entry re-exports /mcp)', () => {
    expect(Object.keys(mcpVersionedApi).sort()).toEqual(Object.keys(mcpApi).sort());
  });

  it('keeps the Modern Write adapter out of the package root', () => {
    const rootSource = readFileSync(join(packageRoot, 'src', 'index.ts'), 'utf8');
    expect(rootSource).not.toContain('Mcp20260728WriteToolAdapter');
    expect(rootSource).not.toContain('createMcp20260728WriteToolAdapter');
    expect(mcpApi).not.toHaveProperty('McpWriteToolGateway');
  });

  it('contains no Legacy MCP wire symbol in the Modern Write adapter source', () => {
    const writeSource = readFileSync(
      join(packageRoot, 'src', 'mcp', '2026-07-28', 'write.ts'),
      'utf8',
    );
    expect(writeSource).not.toMatch(
      /\bMcpSessionBinding\b|\bMcpReadResourceServerSession\b|\bMcp-Session-Id\b|\bLast-Event-ID\b|\bsessionId\b/u,
    );
  });

  it.skipIf(!distPresent)(
    'when dist/ exists, pack includes the MCP dist artifacts and never the fixture host',
    async () => {
      const { stdout, stderr } = await execFileAsync(npmExecutable, ['pack', '--dry-run'], {
        cwd: packageRoot,
        shell: process.platform === 'win32',
      });
      const output = `${stdout}\n${stderr}`;
      for (const artifact of [
        'dist/mcp/index.js',
        'dist/mcp/index.cjs',
        'dist/mcp/index.d.ts',
        'dist/mcp/index.d.cts',
        'dist/mcp/2026-07-28/index.js',
        'dist/mcp/2026-07-28/index.cjs',
        'dist/mcp/2026-07-28/index.d.ts',
        'dist/mcp/2026-07-28/index.d.cts',
        'docs/HOST_INTEGRATION_BOUNDARY.md',
        'docs/SECURITY_COMPOSITION.md',
        'docs/SYNC_HOST_COMPOSITION.md',
      ]) {
        expect(output, artifact).toContain(artifact);
      }
      expect(output).not.toContain('fixture-host');
      expect(output).not.toContain('reference-client');
      expect(output).not.toContain('tests/fixtures/mcp-2026-07-28');
      expect(output).not.toContain('docs/progress');
      expect(output).not.toContain('docs/audits');
    },
    120_000,
  );

  it.skipIf(!distPresent)(
    'when dist/ exists, packed ESM/CJS runtime parity includes Write keys',
    async () => {
      const require = createRequire(import.meta.url);
      for (const [label, dir] of [
        ['default /mcp', distMcpDir],
        ['versioned /mcp/2026-07-28', distVersionedMcpDir],
      ] as const) {
        const esm = (await import(join(dir, 'index.js'))) as Record<string, unknown>;
        const cjs = require(join(dir, 'index.cjs')) as Record<string, unknown>;
        expect(Object.keys(esm).sort(), `${label} ESM/CJS key parity`).toEqual(
          Object.keys(cjs).sort(),
        );
        expect(present(esm, READ_SURFACE_KEYS), `${label} packed Read presence`).toEqual([]);
        expect(present(esm, WRITE_SURFACE_KEYS), `${label} packed Write presence`).toEqual([]);
        expect(absent(esm, LEGACY_WRITE_SYMBOLS), `${label} packed Legacy absence`).toEqual([]);
      }
      for (const declaration of ['index.d.ts', 'index.d.cts']) {
        const source = readFileSync(join(distMcpDir, declaration), 'utf8');
        for (const typeName of [
          'Mcp20260728WriteToolAdapter',
          'Mcp20260728WriteToolAdapterOptions',
          'Mcp20260728WritePlanStatusPort',
          'createMcp20260728WriteToolAdapter',
        ]) {
          expect(source, `${declaration} must declare ${typeName}`).toContain(typeName);
        }
        for (const legacy of ['McpSessionBinding', 'McpReadResourceServerSession', 'Mcp-Session-Id']) {
          expect(source, `${declaration} must not contain ${legacy}`).not.toContain(legacy);
        }
      }
    },
    60_000,
  );
});

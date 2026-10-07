/**
 * COLP-MCP-12: Modern MCP Read package surface contract.
 *
 * Hard gates (no prior build required):
 * - the package root (`src/index.ts`) no longer re-exports MCP adapters,
 *   factories, or wire-version metadata;
 * - `src/mcp/index.ts` (the default `/mcp` entry) exports the completed
 *   Modern Read + shared surface and no Legacy/Session-oriented symbols;
 * - `src/mcp/2026-07-28/index.ts` (the explicit versioned entry) exposes the
 *   exact same surface as the default entry;
 * - `package.json` exports map adds `./mcp` and `./mcp/2026-07-28` with the
 *   standard types import/require + ESM/CJS shape, and adds no deep subpaths
 *   (deep imports are blocked by the exports map);
 * - `tsup.config.ts` registers the `mcp/index` and `mcp/2026-07-28/index`
 *   entries;
 * - source / declaration / tarball scans find no Legacy MCP wire symbol
 *   (`McpSessionBinding`, `McpReadResourceServerSession`, old subscription
 *   methods, `Mcp-Session-Id`, `Last-Event-ID`, the old stdio factory);
 * - `npm pack --dry-run` includes the new dist artifacts and never the
 *   fixture host / reference client (skipped unless `dist/mcp` exists; the CI
 *   package job builds first, so release-evidence never records a packed pass).
 *   The same packed listing must include the host-boundary docs
 *   (`docs/HOST_INTEGRATION_BOUNDARY.md`, `docs/SECURITY_COMPOSITION.md`,
 *   `docs/SYNC_HOST_COMPOSITION.md`).
 *
 * Dist-gated (skipped unless a prior `npm run build` emitted `dist/mcp`):
 * - packed ESM and CJS runtimes both expose the same key set with the Modern
 *   API present and Legacy symbols absent;
 * - `.d.ts` / `.d.cts` declarations contain the key Modern type names and no
 *   Legacy wire symbols.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import * as rootApi from '../../src/index.js';
import * as mcpApi from '../../src/mcp/index.js';
import * as mcpVersionedApi from '../../src/mcp/2026-07-28/index.js';

const execFileAsync = promisify(execFile);
const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const packageRoot = resolve(import.meta.dirname, '..', '..');
const distMcpDir = join(packageRoot, 'dist', 'mcp');
const distVersionedMcpDir = join(distMcpDir, '2026-07-28');
const distPresent = existsSync(join(distMcpDir, 'index.js'));

/** Key Modern Read + shared APIs every supported entry must expose. */
const MODERN_READ_APIS = [
  // stable version metadata
  'MCP_PROTOCOL_VERSION',
  'supportedMcpProtocolVersions',
  // shared authorization (COLP-MCP-04)
  'createAnonymousPublicBinding',
  'createAuthenticatedBinding',
  'mapApiKeyEvidenceToAuthenticatedBinding',
  'mapOAuthEvidenceToAuthenticatedBinding',
  'mapServiceEvidenceToAuthenticatedBinding',
  'mapStdioEvidenceToAuthenticatedBinding',
  'snapshotMcpAuthorizationBinding',
  'requireAuthenticatedWriteBinding',
  // shared stateless cores / change signal (COLP-MCP-07/11)
  'createMcpStatelessReadCore',
  'requireTrustedReadRequestContext',
  'createMcpStatelessToolCore',
  'snapshotMcpChangeSignal',
  // request / discovery / result (COLP-MCP-08)
  'createMcp20260728RequestContext',
  'requireMcp20260728RequestContext',
  'createMcp20260728DiscoverResult',
  'createMcp20260728Result',
  'normalizeMcp20260728Error',
  // Resource + Read Tool adapters (COLP-MCP-09)
  'createMcp20260728ResourceAdapter',
  'createMcp20260728ReadToolAdapter',
  // subscriptions/listen (COLP-MCP-11)
  'createMcp20260728SubscriptionsListenAdapter',
  // schema budget + SDK boundary
  'assertMcpSchemaWithinBudget',
  'MCP_SDK_PROTOCOL_VERSION',
  // OAuth client security (COLP-MCP-10)
  'enforceOAuthPkce',
  'enforceOAuthAuthorizationResponseIss',
  'buildOAuthDcrClientMetadata',
] as const;

/** Legacy / Session-oriented / old-factory symbols that must never be exported. */
const LEGACY_MCP_SYMBOLS = [
  'McpSessionBinding',
  'McpExposureOptions',
  'McpReadResourceServerSession',
  'createMcpReadResourceServer',
  'createMcpReadResourceGateway',
  'createMcpResourceServer',
  'createMcpStdioCredentialBinding',
  'McpStdioCredentialBinding',
  'McpStdioCredentialConfigurationError',
  'subscribeResource',
  'unsubscribeResource',
  'createMcpReadExposure',
  'createMcpAnonymousReadExposure',
  'createMcpReadMountAdapter',
  'createMcpReadToolGateway',
  'createMcpReadClient',
  'createCollectionsGetTool',
  'createCollectionsGetSnapshotTool',
  'createInMemoryPlanStore',
  'createMcpWriteExposure',
  'createMcpWriteMountAdapter',
  'createMcpWriteToolGateway',
  'initialize',
] as const;

/** MCP API names removed from the package root by COLP-MCP-12 (representative). */
const ROOT_ABSENT_MCP_SYMBOLS = [
  'MCP_PROTOCOL_VERSION',
  'supportedMcpProtocolVersions',
  'McpSessionBinding',
  'createMcpReadToolGateway',
  'createMcpReadExposure',
  'createMcpReadClient',
  'createMcpStdioCredentialBinding',
  'createMcpWriteExposure',
  'createMcpWriteMountAdapter',
  'createMcpWriteToolGateway',
  'createChangePlanService',
  'createMcpResourceUriCodec',
  'createMcpResourceTemplates',
  'createMcpStatelessReadCore',
  'createMcpStatelessToolCore',
  'createMcp20260728RequestContext',
  'createMcp20260728ResourceAdapter',
  'createMcp20260728ReadToolAdapter',
  'createMcp20260728SubscriptionsListenAdapter',
  'enforceOAuthPkce',
  'mapStdioEvidenceToAuthenticatedBinding',
  'snapshotMcpAuthorizationBinding',
  'McpToolInputError',
  'McpStdioCredentialConfigurationError',
] as const;

type ExportConditionMap = {
  readonly types?: {
    readonly import?: string;
    readonly require?: string;
  };
  readonly import?: string;
  readonly require?: string;
};

function absent(surface: Record<string, unknown>, names: readonly string[]): string[] {
  return names.filter((name) => name in surface);
}

function present(surface: Record<string, unknown>, names: readonly string[]): string[] {
  return names.filter((name) => !(name in surface));
}

describe('MCP 2026-07-28 Read package surface (COLP-MCP-12)', () => {
  it('publishes ./mcp and ./mcp/2026-07-28 in package.json exports with the standard shape and no deep subpaths', () => {
    const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      exports: Record<string, ExportConditionMap | string>;
      files?: readonly string[];
    };

    for (const key of ['./mcp', './mcp/2026-07-28'] as const) {
      expect(packageJson.exports[key], key).toEqual({
        types: {
          import: `./dist/${key.slice(2)}/index.d.ts`,
          require: `./dist/${key.slice(2)}/index.d.cts`,
        },
        import: `./dist/${key.slice(2)}/index.js`,
        require: `./dist/${key.slice(2)}/index.cjs`,
      });
    }

    // No other new subpath and no deep path under the MCP entries: importing
    // `@know-n/colp/mcp/2026-07-28/<file>` must fail to resolve.
    const unexpected = Object.keys(packageJson.exports).filter(
      (key) =>
        key !== './mcp'
        && key !== './mcp/2026-07-28'
        && (key.startsWith('./mcp/') || key.includes('fixtures') || key.includes('mcp-2026-07-28')),
    );
    expect(unexpected).toEqual([]);
    expect(packageJson.files).toContain('dist');
    expect(packageJson.files).toContain('README.md');
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
      'docs/progress/',
      'docs/audits',
      'docs/audits/',
    ] as const) {
      expect(packageJson.files, excluded).not.toContain(excluded);
    }
  });

  it('registers the mcp/index and mcp/2026-07-28/index tsup entries', () => {
    const tsupSource = readFileSync(join(packageRoot, 'tsup.config.ts'), 'utf8');
    expect(tsupSource).toMatch(/['"]mcp\/index['"]\s*:\s*['"]src\/mcp\/index\.ts['"]/);
    expect(tsupSource).toMatch(/['"]mcp\/2026-07-28\/index['"]\s*:\s*['"]src\/mcp\/2026-07-28\/index\.ts['"]/);
  });

  it('exposes every key Modern Read API from the default /mcp entry', () => {
    const missing = present(mcpApi as unknown as Record<string, unknown>, [...MODERN_READ_APIS]);
    expect(missing).toEqual([]);
  });

  it('keeps Legacy / Session-oriented / old-factory symbols absent from the default /mcp entry', () => {
    const leaked = absent(mcpApi as unknown as Record<string, unknown>, [...LEGACY_MCP_SYMBOLS]);
    expect(leaked).toEqual([]);
  });

  it('exposes the exact same surface from the explicit /mcp/2026-07-28 entry', () => {
    const defaultKeys = Object.keys(mcpApi).sort();
    const versionedKeys = Object.keys(mcpVersionedApi).sort();
    expect(versionedKeys).toEqual(defaultKeys);
    const missing = present(
      mcpVersionedApi as unknown as Record<string, unknown>,
      [...MODERN_READ_APIS],
    );
    expect(missing).toEqual([]);
    const leaked = absent(
      mcpVersionedApi as unknown as Record<string, unknown>,
      [...LEGACY_MCP_SYMBOLS],
    );
    expect(leaked).toEqual([]);
  });

  it('no longer re-exports MCP adapters from the package root (runtime)', () => {
    const root = rootApi as unknown as Record<string, unknown>;
    const leaked = absent(root, [...ROOT_ABSENT_MCP_SYMBOLS]);
    expect(leaked).toEqual([]);
  });

  it('no longer imports the MCP boundary from the package root (source)', () => {
    const source = readFileSync(join(packageRoot, 'src', 'index.ts'), 'utf8');
    expect(source).not.toContain("from './mcp/index.js'");
  });

  it('keeps cross-profile stable metadata on the root entry', () => {
    expect(rootApi.protocolVersion).toBe('0.1');
    expect(rootApi.packageStatus).toBe('development');
    expect([...rootApi.supportedProfiles]).toEqual([
      'core',
      'publication',
      'publisher',
      'feed',
      'sync',
      'mcp-read',
      'mcp-write',
    ]);
  });

  it('contains no Legacy MCP wire symbol in the Modern source or security client module', () => {
    const legacySourcePattern =
      /\bMcpSessionBinding\b|\bMcpReadResourceServerSession\b|\bcreateMcpReadResourceServer\b|\bcreateMcpStdioCredentialBinding\b|\bMcpStdioCredentialBinding\b|\bsubscribeResource\b|\bunsubscribeResource\b|\bMcpSessionId\b|\bsessionId\b/u;
    for (const file of [
      join(packageRoot, 'src', 'mcp', 'index.ts'),
      join(packageRoot, 'src', 'mcp', '2026-07-28', 'index.ts'),
    ]) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(legacySourcePattern);
    }
    for (const file of ['index.ts', 'protocol-version.ts', 'read-mount.ts', 'read-client.ts']) {
      const source = readFileSync(join(packageRoot, 'src', 'mcp', file), 'utf8');
      expect(source, `src/mcp/${file}`).not.toMatch(
        /\bMcpSessionBinding\b|\bMcpReadResourceServerSession\b|\bcreateMcpReadResourceServer\b|\bcreateMcpStdioCredentialBinding\b|\bMcpStdioCredentialBinding\b|\bsubscribeResource\b|\bunsubscribeResource\b/u,
      );
    }
    const oauthSource = readFileSync(
      join(packageRoot, 'src', 'security', 'mcp-oauth-client.ts'),
      'utf8',
    );
    expect(oauthSource).not.toMatch(
      /\bMcpSessionBinding\b|\bMcpReadResourceServerSession\b|\bMcp-Session-Id\b|\bLast-Event-ID\b/u,
    );
  });

  it('blocks deep imports under the MCP entries through the exports map', () => {
    const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>;
    };
    for (const blocked of [
      './mcp/index',
      './mcp/index.js',
      './mcp/2026-07-28/index',
      './mcp/2026-07-28/index.js',
      './mcp/2026-07-28/request-context',
      './mcp/2026-07-28/request-context.js',
      './mcp/2026-07-28/sdk-boundary',
      './mcp/shared/authorization',
    ] as const) {
      expect(Object.hasOwn(packageJson.exports, blocked), blocked).toBe(false);
    }
  });

  it.skipIf(!distPresent)(
    'when dist/ exists, pack includes the new MCP dist artifacts and never the fixture host',
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
    'when dist/ exists, packed ESM/CJS runtime + declaration consistency matches the Modern Read surface',
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
        const missing = present(esm, [...MODERN_READ_APIS]);
        expect(missing, `${label} ESM key presence`).toEqual([]);
        const leakedEsm = absent(esm, [...LEGACY_MCP_SYMBOLS]);
        expect(leakedEsm, `${label} ESM legacy absence`).toEqual([]);
        const leakedCjs = absent(cjs, [...LEGACY_MCP_SYMBOLS]);
        expect(leakedCjs, `${label} CJS legacy absence`).toEqual([]);
      }
      for (const declaration of ['index.d.ts', 'index.d.cts']) {
        const source = readFileSync(join(distMcpDir, declaration), 'utf8');
        for (const typeName of [
          'Mcp20260728RequestContext',
          'Mcp20260728ResourceAdapter',
          'Mcp20260728ReadToolAdapter',
          'Mcp20260728SubscriptionsListenAdapter',
          'McpAuthorizationBinding',
          'createMcp20260728RequestContext',
        ]) {
          expect(source, `${declaration} must declare ${typeName}`).toContain(typeName);
        }
        for (const legacy of [
          'McpSessionBinding',
          'McpReadResourceServerSession',
          'createMcpStdioCredentialBinding',
          'McpStdioCredentialBinding',
          'subscribeResource',
          'unsubscribeResource',
          'Mcp-Session-Id',
          'Last-Event-ID',
          'McpSessionId',
        ]) {
          expect(source, `${declaration} must not contain ${legacy}`).not.toContain(legacy);
        }
      }
    },
    30_000,
  );
});

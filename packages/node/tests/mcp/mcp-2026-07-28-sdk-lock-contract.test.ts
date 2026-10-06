import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  MCP_PROTOCOL_VERSION,
  supportedMcpProtocolVersions,
} from '../../src/mcp/protocol-version.js';
import * as sdkBoundary from '../../src/mcp/2026-07-28/sdk-boundary.js';

const execFileAsync = promisify(execFile);
const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const packageRoot = resolve(import.meta.dirname, '..', '..');
const policyDocPath = resolve(packageRoot, 'docs', 'MCP_SDK_POLICY.md');
const distPresent = existsSync(join(packageRoot, 'dist', 'index.js'));

type PackageJson = {
  readonly name?: string;
  readonly version?: string;
  readonly engines?: Readonly<Record<string, string>>;
  readonly files?: readonly string[];
  readonly exports?: Readonly<Record<string, unknown>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
};

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

async function collectFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(full)));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

const TEXT_EXTENSIONS = /\.(?:[cm]?[jt]sx?|json|ya?ml)$/u;

describe('MCP 2026-07-28 SDK lock contract (COLP-MCP-03)', () => {
  it('pins the exact upstream MCP SDK versions with core as the only production MCP dependency', async () => {
    const pkg = await readJson<PackageJson>(resolve(packageRoot, 'package.json'));

    expect(pkg.dependencies?.['@modelcontextprotocol/core']).toBe('2.0.0');
    expect(pkg.devDependencies?.['@modelcontextprotocol/client']).toBe('2.0.0');
    expect(pkg.devDependencies?.['@modelcontextprotocol/server']).toBe('2.0.0');
    expect(pkg.dependencies?.['@modelcontextprotocol/client']).toBeUndefined();
    expect(pkg.dependencies?.['@modelcontextprotocol/server']).toBeUndefined();
    expect(pkg.devDependencies?.['@modelcontextprotocol/core']).toBeUndefined();

    for (const section of [
      pkg.peerDependencies ?? {},
      pkg.optionalDependencies ?? {},
    ] as const) {
      for (const name of Object.keys(section)) {
        expect(name).not.toMatch(/^@modelcontextprotocol\//u);
      }
    }
  });

  it('locks the SDK in the package lockfile at exact 2.0.0 and never depends on the legacy monolith', async () => {
    const lockText = await readFile(resolve(packageRoot, 'package-lock.json'), 'utf8');
    const lock = JSON.parse(lockText) as {
      readonly packages?: Readonly<Record<string, { version?: string }>>;
    };

    const root = lock.packages?.[''];
    expect(root).toBeDefined();
    expect(root?.version).toBe('0.0.0-development');

    for (const name of [
      'node_modules/@modelcontextprotocol/core',
      'node_modules/@modelcontextprotocol/client',
      'node_modules/@modelcontextprotocol/server',
    ] as const) {
      expect(lock.packages?.[name]?.version, name).toBe('2.0.0');
    }
    expect(lock.packages?.['node_modules/@modelcontextprotocol/sdk']).toBeUndefined();
    expect(lockText).not.toContain('@modelcontextprotocol/sdk');
    expect(lockText).toContain('core-2.0.0.tgz');
    expect(lockText).toContain('client-2.0.0.tgz');
    expect(lockText).toContain('server-2.0.0.tgz');
  });

  it('resolves the modern core schema vocabulary in both ESM and CJS', async () => {
    const core = await import('@modelcontextprotocol/core');
    for (const name of [
      'DiscoverRequestSchema',
      'DiscoverResultSchema',
      'SubscriptionsListenRequestSchema',
      'SubscriptionsListenResultSchema',
      'SubscriptionsListenResultMetaSchema',
      'SubscriptionsAcknowledgedNotificationSchema',
      'SubscriptionFilterSchema',
      'ResourceUpdatedNotificationSchema',
      'ResourceListChangedNotificationSchema',
      'ToolListChangedNotificationSchema',
      'PromptListChangedNotificationSchema',
      'RequestMetaSchema',
      'ResultSchema',
      'ImplementationSchema',
      'ResultMetaObjectSchema',
      'ToolSchema',
      'ResourceSchema',
      'ResourceTemplateSchema',
      'ListResourcesResultSchema',
      'ListResourceTemplatesResultSchema',
      'ReadResourceResultSchema',
      'ListToolsResultSchema',
      'CallToolResultSchema',
      'OAuthClientInformationSchema',
      'OAuthClientInformationFullSchema',
      'OAuthClientMetadataSchema',
      'OAuthClientRegistrationErrorSchema',
      'OAuthErrorResponseSchema',
      'OAuthMetadataSchema',
      'OAuthProtectedResourceMetadataSchema',
      'OAuthTokenRevocationRequestSchema',
      'OAuthTokensSchema',
      'OpenIdProviderDiscoveryMetadataSchema',
      'OpenIdProviderMetadataSchema',
    ] as const) {
      const schema = core[name] as { safeParse?: unknown } | undefined;
      expect(schema, name).toBeDefined();
      expect(typeof schema?.safeParse, name).toBe('function');
    }

    const coreCjs = createRequire(import.meta.url)('@modelcontextprotocol/core') as Record<
      string,
      unknown
    >;
    for (const name of ['DiscoverRequestSchema', 'DiscoverResultSchema', 'ResultSchema'] as const) {
      expect(coreCjs[name], `CJS ${name}`).toBeDefined();
    }
  });

  it('resolves the harness client/server packages as dev-only dependencies', async () => {
    const client = await import('@modelcontextprotocol/client');
    expect(client.Client).toBeTypeOf('function');
    expect(client.StreamableHTTPClientTransport).toBeTypeOf('function');
    expect(client.InMemoryTransport).toBeTypeOf('function');

    const server = await import('@modelcontextprotocol/server');
    expect(server.createMcpHandler).toBeTypeOf('function');
    expect(server.McpServer).toBeTypeOf('function');
    expect(server.InMemoryTransport).toBeTypeOf('function');
  });

  it('keeps the COLP protocol constant authoritative over the SDK legacy version constants', async () => {
    expect(MCP_PROTOCOL_VERSION).toBe('2026-07-28');
    expect(supportedMcpProtocolVersions).toEqual(['2026-07-28']);
    expect(Object.isFrozen(supportedMcpProtocolVersions)).toBe(true);

    const coreInternal = await import('@modelcontextprotocol/core/internal');
    expect(coreInternal.PROTOCOL_VERSION_META_KEY).toBe('io.modelcontextprotocol/protocolVersion');
    expect(coreInternal.SUBSCRIPTION_ID_META_KEY).toBe('io.modelcontextprotocol/subscriptionId');
    expect(coreInternal.CLIENT_CAPABILITIES_META_KEY).toBe(
      'io.modelcontextprotocol/clientCapabilities',
    );

    // The SDK's public SUPPORTED_PROTOCOL_VERSIONS is the legacy `initialize`
    // interop list and intentionally never carries the modern revision; COLP
    // must not derive its supported set from it. The modern era is negotiated
    // through server/discover, which the reference-harness contract verifies.
    expect(Array.isArray(coreInternal.SUPPORTED_PROTOCOL_VERSIONS)).toBe(true);
    expect(coreInternal.SUPPORTED_PROTOCOL_VERSIONS).toContain('2025-11-25');
    expect(coreInternal.SUPPORTED_PROTOCOL_VERSIONS).not.toContain('2026-07-28');
    expect(coreInternal.LATEST_PROTOCOL_VERSION).toBe('2025-11-25');

    expect(sdkBoundary.MCP_SDK_PROTOCOL_VERSION).toBe(MCP_PROTOCOL_VERSION);
    expect(sdkBoundary.MCP_SDK_CORE_VERSION).toBe('2.0.0');
    expect('SUPPORTED_PROTOCOL_VERSIONS' in sdkBoundary).toBe(false);
    expect('LATEST_PROTOCOL_VERSION' in sdkBoundary).toBe(false);
  });

  it('freezes the SDK schema/meta-key/type allowlists to match the policy document', async () => {
    for (const allowlist of [
      sdkBoundary.MCP_SDK_SCHEMA_ALLOWLIST,
      sdkBoundary.MCP_SDK_META_KEY_ALLOWLIST,
      sdkBoundary.MCP_SDK_PUBLIC_TYPE_ALLOWLIST,
    ] as const) {
      expect(Object.isFrozen(allowlist)).toBe(true);
    }
    expect(sdkBoundary.MCP_SDK_SCHEMA_ALLOWLIST).toEqual([
      'DiscoverRequestSchema',
      'DiscoverResultSchema',
      'SubscriptionsListenRequestSchema',
      'SubscriptionsListenResultSchema',
      'SubscriptionsListenResultMetaSchema',
      'SubscriptionsAcknowledgedNotificationSchema',
      'SubscriptionFilterSchema',
      'ResourceUpdatedNotificationSchema',
      'ResourceListChangedNotificationSchema',
      'ToolListChangedNotificationSchema',
      'PromptListChangedNotificationSchema',
      'RequestMetaSchema',
      'ResultSchema',
      'ImplementationSchema',
      'ResultMetaObjectSchema',
      'ToolSchema',
      'ResourceSchema',
      'ResourceTemplateSchema',
      'ListResourcesResultSchema',
      'ListResourceTemplatesResultSchema',
      'ReadResourceResultSchema',
      'ListToolsResultSchema',
      'CallToolResultSchema',
      'OAuthClientInformationSchema',
      'OAuthClientInformationFullSchema',
      'OAuthClientMetadataSchema',
      'OAuthClientRegistrationErrorSchema',
      'OAuthErrorResponseSchema',
      'OAuthMetadataSchema',
      'OAuthProtectedResourceMetadataSchema',
      'OAuthTokenRevocationRequestSchema',
      'OAuthTokensSchema',
      'OpenIdProviderDiscoveryMetadataSchema',
      'OpenIdProviderMetadataSchema',
    ]);
    expect(sdkBoundary.MCP_SDK_META_KEY_ALLOWLIST).toEqual([
      'PROTOCOL_VERSION_META_KEY',
      'SUBSCRIPTION_ID_META_KEY',
      'CLIENT_CAPABILITIES_META_KEY',
      'CLIENT_INFO_META_KEY',
      'SERVER_INFO_META_KEY',
      'LOG_LEVEL_META_KEY',
      'TRACEPARENT_META_KEY',
      'TRACESTATE_META_KEY',
      'BAGGAGE_META_KEY',
    ]);
    expect(sdkBoundary.MCP_SDK_PUBLIC_TYPE_ALLOWLIST).toEqual([
      'DiscoverRequest',
      'DiscoverResult',
      'SubscriptionsListenRequest',
      'SubscriptionsListenResult',
      'SubscriptionsAcknowledgedNotification',
      'ResourceUpdatedNotification',
      'ResourceListChangedNotification',
      'ToolListChangedNotification',
      'PromptListChangedNotification',
      'RequestMeta',
      'ResultMetaObject',
      'Implementation',
      'Tool',
      'Resource',
      'ResourceTemplate',
      'ListResourcesResult',
      'ListResourceTemplatesResult',
      'ReadResourceResult',
      'ListToolsResult',
      'CallToolResult',
    ]);

    const policy = await readFile(policyDocPath, 'utf8');
    for (const name of [
      ...sdkBoundary.MCP_SDK_SCHEMA_ALLOWLIST,
      ...sdkBoundary.MCP_SDK_PUBLIC_TYPE_ALLOWLIST,
    ]) {
      expect(policy, `policy must list ${name}`).toContain(name);
    }
  });

  it('requires Node 22 and satisfies the SDK engines floor', async () => {
    const pkg = await readJson<PackageJson>(resolve(packageRoot, 'package.json'));
    expect(pkg.engines?.node).toMatch(/^>=22/u);

    const major = Number(process.versions.node.split('.')[0]);
    expect(major).toBeGreaterThanOrEqual(22);

    const corePkg = await readJson<PackageJson>(
      resolve(packageRoot, 'node_modules', '@modelcontextprotocol', 'core', 'package.json'),
    );
    expect(corePkg.engines?.node).toMatch(/^>=20/u);
    expect(major).toBeGreaterThanOrEqual(20);
  });

  it('documents the N/N-1 upgrade and security-scan policy and rejects the legacy monolith', async () => {
    const policy = await readFile(policyDocPath, 'utf8');
    expect(policy).toContain('@modelcontextprotocol/core');
    expect(policy).toContain('@modelcontextprotocol/sdk');
    expect(policy).toContain('N/N-1');
    expect(policy).toContain('upgrade');
    expect(policy).toContain('npm audit');
    expect(policy).toContain('fixture-host');

    const roots = ['src', 'tests'] as const;
    for (const root of roots) {
      const files = await collectFiles(resolve(packageRoot, root));
      for (const file of files) {
        if (!TEXT_EXTENSIONS.test(file)) continue;
        const source = await readFile(file, 'utf8');
        // Only actual imports/requires are forbidden; the policy text and the
        // lock-contract assertions themselves may mention the legacy name.
        expect(source, `${file} must not import the legacy SDK monolith`).not.toMatch(
          /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]@modelcontextprotocol\/sdk['"]/u,
        );
      }
    }
  }, 30_000);

  it('keeps the fixture host out of production files and package exports', async () => {
    const pkg = await readJson<PackageJson>(resolve(packageRoot, 'package.json'));
    expect(pkg.files).not.toContain('tests');
    expect(pkg.files).not.toContain('tests/fixtures');
    for (const key of Object.keys(pkg.exports ?? {})) {
      expect(key).not.toContain('fixtures');
      expect(key).not.toContain('mcp-2026-07-28');
    }
  });

  it.skipIf(!distPresent)(
    'when dist/ exists, pack never includes the fixture host or reference client',
    async () => {
      const { stdout, stderr } = await execFileAsync(npmExecutable, ['pack', '--dry-run'], {
        cwd: packageRoot,
        // .cmd shims on Windows require a shell.
        shell: process.platform === 'win32',
      });
      const output = `${stdout}\n${stderr}`;
      expect(output).not.toContain('tests/fixtures/mcp-2026-07-28');
      expect(output).toContain('dist/index.js');
      expect(output).not.toContain('fixture-host');
      expect(output).not.toContain('reference-client');
    },
    120_000,
  );

  it('records the packed-consumer dependency decision in the policy document', async () => {
    const policy = await readFile(policyDocPath, 'utf8');
    expect(policy).toContain('dependencies');
    expect(policy).toContain('devDependencies');
    expect(policy).toContain('peer');
    expect(policy).toContain('pack:check');
    expect(policy).toContain('packed consumer');
  });
});

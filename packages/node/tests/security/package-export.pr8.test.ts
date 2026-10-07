/**
 * PR8 packaging / public-surface smoke test for `./security`.
 *
 * Hard gates (no prior build required):
 * - `package.json` exports map includes `./security` with the same shape as
 *   other public subpaths (types import/require + ESM/CJS runtime paths)
 * - `tsup.config.ts` includes the `security/index` entry
 * - key runtime APIs are importable from `src/security/index.ts`
 *
 * Dist-gated (skipped unless a prior `npm run build` has emitted `dist/security`):
 * - `dist/security` artifacts declared in package.json exports exist
 *
 * Explicit non-claims:
 * - Profile completeness, `supportedProfiles` Security/Publisher claims,
 *   conformance evidence, full HTTP middleware wiring, or SEC-* coverage
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import * as securityApi from '../../src/security/index.js';

import {
  CREDENTIAL_QUERY_PARAMETER_NAMES,
  RATE_LIMIT_BUCKET_IDS,
  classifyRateLimitBucket,
  emitContentIntegrityHeaders,
  enforceOriginFromTransport,
  enforcePublisherStreamableHttpBoundary,
  enforceRateLimitForOperation,
  type HttpsEndpointApplicability,
  type HttpsEndpointDecision,
  type HttpsEndpointDenialReason,
  type HttpsEndpointLocation,
} from '../../src/security/index.js';
import { supportedProfiles } from '../../src/index.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const packageJsonPath = join(packageRoot, 'package.json');
const tsupConfigPath = join(packageRoot, 'tsup.config.ts');
const distSecurityDir = join(packageRoot, 'dist/security');
const distPresent = existsSync(join(distSecurityDir, 'index.js'));
const distSecurityArtifacts = [
  'index.js',
  'index.cjs',
  'index.d.ts',
  'index.d.cts',
] as const;

type ExportConditionMap = {
  readonly types?: {
    readonly import?: string;
    readonly require?: string;
  };
  readonly import?: string;
  readonly require?: string;
};

const HTTPS_DECISION_TYPE_EXPORTS = [
  'HttpsEndpointApplicability',
  'HttpsEndpointDecision',
  'HttpsEndpointDenialReason',
  'HttpsEndpointLocation',
] as const;

/**
 * Type identifiers from mixed `export { type Foo }` and `export type { Foo }`.
 * Value specifiers are omitted.
 */
function publicTypeExportNames(source: string): string[] {
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const names = new Set<string>();

  for (const block of stripped.matchAll(/\bexport\s+type\s*\{([^}]+)\}/gu)) {
    for (const spec of block[1]!.split(',')) {
      const trimmed = spec.trim();
      if (trimmed.length === 0) {
        continue;
      }
      const renamed = trimmed.match(
        /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/u,
      );
      if (renamed !== null) {
        names.add(renamed[2] ?? renamed[1]!);
      }
    }
  }

  for (const block of stripped.matchAll(/\bexport\s*\{([^}]+)\}/gu)) {
    for (const spec of block[1]!.split(',')) {
      const trimmed = spec.trim();
      const typeSpec = trimmed.match(
        /^type\s+([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/u,
      );
      if (typeSpec !== null) {
        names.add(typeSpec[2] ?? typeSpec[1]!);
      }
    }
  }

  return [...names].sort();
}

function publicValueExportNames(source: string): string[] {
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const names = new Set<string>();

  for (const match of stripped.matchAll(
    /\bexport\s+(?:async\s+)?(?:function|const|class|enum)\s+([A-Za-z_$][\w$]*)/gu,
  )) {
    names.add(match[1]!);
  }

  for (const block of stripped.matchAll(/\bexport\s*\{([^}]+)\}/gu)) {
    for (const spec of block[1]!.split(',')) {
      const trimmed = spec.trim();
      if (trimmed.length === 0 || /^type\s+/u.test(trimmed)) {
        continue;
      }
      const renamed = trimmed.match(
        /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/u,
      );
      if (renamed !== null) {
        names.add(renamed[2] ?? renamed[1]!);
      }
    }
  }

  return [...names].sort();
}

describe('security public surface (PR8 package-export smoke)', () => {
  it('publishes ./security in package.json exports with ESM/CJS + types paths', () => {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      exports: Record<string, ExportConditionMap | string>;
      private?: boolean;
      version?: string;
    };

    expect(Object.hasOwn(packageJson.exports, './security')).toBe(true);
    const securityExport = packageJson.exports['./security'];
    expect(securityExport).toEqual({
      types: {
        import: './dist/security/index.d.ts',
        require: './dist/security/index.d.cts',
      },
      import: './dist/security/index.js',
      require: './dist/security/index.cjs',
    });

    // Registry metadata does not change which Profiles the package implements.
    expect(packageJson.private).not.toBe(true);
    expect(packageJson.version).toBe('0.1.0');
    expect([...supportedProfiles]).toEqual([
      'core',
      'publication',
      'publisher',
      'feed',
      'sync',
      'mcp-read',
      'mcp-write',
    ]);
  });

  it('registers security/index as a tsup entry', () => {
    const tsupSource = readFileSync(tsupConfigPath, 'utf8');
    expect(tsupSource).toMatch(/['"]security\/index['"]\s*:\s*['"]src\/security\/index\.ts['"]/);
  });

  it('exposes key APIs from the security index with expected types', () => {
    expect(securityApi).not.toHaveProperty('enforceHttpsEndpoint');
    expect(securityApi).not.toHaveProperty('enforceOriginGuard');
    expect(typeof enforceOriginFromTransport).toBe('function');
    expect(typeof enforceRateLimitForOperation).toBe('function');
    expect(typeof classifyRateLimitBucket).toBe('function');
    expect(typeof emitContentIntegrityHeaders).toBe('function');
    expect(typeof enforcePublisherStreamableHttpBoundary).toBe('function');
    // Frozen string list, not a function.
    expect(typeof CREDENTIAL_QUERY_PARAMETER_NAMES).toBe('object');
    expect(Array.isArray(CREDENTIAL_QUERY_PARAMETER_NAMES)).toBe(true);
  });

  it('lists HTTPS decision types on src/security/index.ts without atomic input or function', () => {
    const securityIndexSource = readFileSync(join(packageRoot, 'src/security/index.ts'), 'utf8');
    const typeExports = publicTypeExportNames(securityIndexSource);
    const valueExports = publicValueExportNames(securityIndexSource);

    expect(typeExports).toEqual(expect.arrayContaining([...HTTPS_DECISION_TYPE_EXPORTS]));
    expect(typeExports).not.toContain('HttpsEndpointInput');
    expect(typeExports).not.toContain('HttpsEndpointTransport');
    expect(valueExports).not.toContain('enforceHttpsEndpoint');
    expect(valueExports).not.toContain('enforceOriginGuard');

    const namedDecision: HttpsEndpointDecision = {
      allowed: false,
      reason: 'https_required',
    };
    const namedReason: HttpsEndpointDenialReason = 'invalid_input';
    const namedApplicability: HttpsEndpointApplicability = 'applicable';
    const namedLocation: HttpsEndpointLocation = 'remote';
    expect(namedDecision.allowed).toBe(false);
    expect(namedReason).toBe('invalid_input');
    expect(namedApplicability).toBe('applicable');
    expect(namedLocation).toBe('remote');
  });

  it('exposes exactly seven canonical RATE_LIMIT_BUCKET_IDS', () => {
    expect(RATE_LIMIT_BUCKET_IDS).toBeInstanceOf(Set);
    expect([...RATE_LIMIT_BUCKET_IDS].sort()).toEqual([
      'publisher:admin-key-management',
      'publisher:anonymous-feed-read',
      'publisher:authenticated-read',
      'publisher:general-write',
      'publisher:mcp-tool-call',
      'publisher:sync-pull',
      'publisher:sync-push',
    ]);
  });

  it.skipIf(!distPresent)(
    'when dist/ exists, pack/dist/security artifacts declared in package.json exports exist',
    () => {
      for (const artifact of distSecurityArtifacts) {
        expect(existsSync(join(distSecurityDir, artifact))).toBe(true);
      }
    },
  );
});

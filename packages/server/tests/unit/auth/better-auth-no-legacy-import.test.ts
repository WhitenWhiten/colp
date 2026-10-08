/**
 * Task E2 unit test: the Better Auth production surface never imports the
 * legacy OIDC/Logto chain (plan §12 Task F1/F2; G1 ADR §11).
 *
 * 假阴性防护:
 * - the evidence is the REAL import graph of the ACTUAL source files
 *   (specifiers resolved to real files, `.js` -> `.ts`), not a grep hit
 *   count: every import/export/dynamic-import specifier of the BA surface is
 *   resolved and compared against the forbidden legacy files;
 * - the whole-graph gate is the REAL `check-import-boundaries.mjs` run
 *   against `src/` (the same script `npm run check:imports` runs), so a new
 *   bypass edge anywhere in src fails this test;
 * - the legacy OIDC boundary file itself is in the forbidden set: the BA
 *   surface may not even reach the single controlled re-export exit;
 * - fixture negative controls prove the scanner and the boundary script both
 *   CATCH a planted violation (the test would fail if the evidence
 *   machinery went silent).
 *
 * 假阳性防护:
 * - files that legitimately compose the legacy chain (bootstrap/api.ts,
 *   transport/auth/browser-auth-routes.ts legacy branches, transport/oidc-
 *   provider.ts itself) are NOT part of the scanned BA surface — scanning
 *   them would produce a false alarm, and their legacy mode is covered by
 *   the F1/F2 suites;
 * - "not imported" is never asserted from a single-file grep: the resolved
 *   import graph of every BA file is computed with the same specifier
 *   resolution the boundary script uses.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const backendRoot = resolve(import.meta.dirname, '../../..');
const checkImportsScript = fileURLToPath(
  new URL('../../../scripts/check-import-boundaries.mjs', import.meta.url),
);

/**
 * The Better Auth production surface: the files the BA runtime, authority,
 * composition and transport contract are built from. The legacy OIDC chain
 * (transport/auth/oidc-provider.ts, the legacy boundary, legacy identity
 * application files and the legacy JWKS client) must be unreachable from
 * every one of them.
 */
const BA_SURFACE_FILES = [
  'src/bootstrap/composition.ts',
  'src/infrastructure/auth/better-auth-runtime.ts',
  'src/infrastructure/auth/cimd-node-fetch.ts',
  'src/infrastructure/auth/loopback-redirect-port.ts',
  'src/infrastructure/auth/oauth-consent-transaction.ts',
  'src/infrastructure/auth/better-auth-session-authority.ts',
  'src/infrastructure/auth/business-account-unit-of-work.ts',
  'src/modules/auth/index.ts',
  'src/modules/auth/better-auth-config.ts',
  'src/modules/auth/application/browser-session-authority.ts',
  'src/modules/auth/application/account-linking.ts',
  'src/modules/auth/application/account-recovery.ts',
  'src/modules/auth/application/business-account-mapping.ts',
  'src/transport/auth/better-auth-routes.ts',
  'src/transport/auth/auth-route-manifest.ts',
] as const;

/** Forbidden legacy OIDC/Logto files (source retention is NOT runtime enablement). */
const FORBIDDEN_LEGACY_FILES = [
  'src/transport/auth/oidc-provider.ts',
  'src/infrastructure/auth/legacy-oidc-boundary.ts',
  'src/infrastructure/identity/jwks-client.ts',
  'src/modules/identity/application/oidc-login-transaction.ts',
  'src/modules/identity/application/ensure-account-from-oidc.ts',
] as const;

/** Resolve every import/export/dynamic-import specifier of one source file. */
function resolveSpecifiers(sourcePath: string, knownFiles: ReadonlySet<string>, root = backendRoot): string[] {
  const source = readFileSync(sourcePath, 'utf8');
  const pattern = /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;
  const resolved: string[] = [];
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier === undefined) continue;
    if (!specifier.startsWith('.')) continue;
    const candidate = resolve(dirname(sourcePath), specifier);
    const choices = specifier.endsWith('.js')
      ? [`${candidate.slice(0, -3)}.ts`, `${candidate.slice(0, -3)}.tsx`]
      : [candidate, `${candidate}.ts`, `${candidate}.tsx`, join(candidate, 'index.ts'), join(candidate, 'index.tsx')];
    const matchFile = choices.find((choice) => knownFiles.has(choice));
    if (matchFile) resolved.push(relative(root, matchFile).split('\\').join('/'));
  }
  return resolved;
}

function walkSource(): string[] {
  const out: string[] = [];
  const stack = [resolve(backendRoot, 'src')];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (/\.(?:ts|tsx|mts|cts)$/.test(entry.name)) out.push(path);
    }
  }
  return out;
}

function createFixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ba-no-legacy-import-'));
  for (const [relative, content] of Object.entries(files)) {
    const path = resolve(dir, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf8');
  }
  return dir;
}

function runCheckImports(root: string): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
  const result = spawnSync(process.execPath, [checkImportsScript, '--root', root], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

test('the resolved import graph of the Better Auth surface contains zero legacy OIDC files', () => {
  // knownFiles carries ABSOLUTE paths (the same contract resolveSpecifiers
  // matches against); resolved output is reported relative to backendRoot.
  const knownFiles = new Set(walkSource());
  const forbidden = new Set(FORBIDDEN_LEGACY_FILES);

  for (const relativePath of BA_SURFACE_FILES) {
    const sourcePath = resolve(backendRoot, relativePath);
    assert.equal(knownFiles.has(sourcePath), true, `BA surface file must exist: ${relativePath}`);
    const resolved = resolveSpecifiers(sourcePath, knownFiles);
    const hits = resolved.filter((file) => forbidden.has(file));
    assert.deepEqual(
      hits,
      [],
      `${relativePath} must not import any legacy OIDC file (resolved graph: ${resolved.join(', ') || 'no local imports'})`,
    );
  }
});

test('the whole-src dependency graph passes the REAL check-import-boundaries gate', () => {
  const result = runCheckImports(resolve(backendRoot, 'src'));
  assert.equal(result.status, 0, `check-import-boundaries must pass on src:\n${result.stderr}`);
  assert.match(result.stdout, /import boundaries: ok/u);
});

test('negative control: the scanner flags a planted legacy import in the BA runtime', () => {
  const fixture = createFixture({
    'transport/auth/oidc-provider.ts': 'export function createOidcProvider(): void {}\n',
    'modules/auth/index.ts': 'export const authSurface = 1;\n',
    'infrastructure/auth/better-auth-runtime.ts':
      "import { createOidcProvider } from '../../transport/auth/oidc-provider.js';\n"
      + 'export const leaked = createOidcProvider;\n',
  });
  try {
    const knownFiles = new Set(walkSource());
    // Plant the fixture files (ABSOLUTE paths — the resolver matches
    // absolute choices) into the known set so the resolver can resolve them.
    const planted = new Set(knownFiles);
    planted.add(resolve(fixture, 'infrastructure/auth/better-auth-runtime.ts'));
    planted.add(resolve(fixture, 'transport/auth/oidc-provider.ts'));
    planted.add(resolve(fixture, 'modules/auth/index.ts'));
    const fixturePath = resolve(fixture, 'infrastructure/auth/better-auth-runtime.ts');
    const resolved = resolveSpecifiers(fixturePath, planted, fixture);
    assert.deepEqual(resolved, ['transport/auth/oidc-provider.ts'], 'the scanner must resolve the planted legacy import');
    assert.equal(FORBIDDEN_LEGACY_FILES.includes(`src/${resolved[0]!}`), true,
      'the resolved target must be a forbidden legacy file');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('negative control: the REAL boundary script rejects a planted BA->legacy import edge', () => {
  const fixture = createFixture({
    'transport/auth/oidc-provider.ts': 'export function createOidcProvider(): void {}\n',
    'modules/auth/index.ts': 'export const authSurface = 1;\n',
    'infrastructure/auth/better-auth-runtime.ts':
      "import { createOidcProvider } from '../../transport/auth/oidc-provider.js';\n"
      + 'export const leaked = createOidcProvider;\n',
  });
  try {
    const result = runCheckImports(fixture);
    assert.notEqual(result.status, 0, 'a planted legacy import inside the BA runtime must violate the graph');
    assert.match(result.stderr, /violates dependency graph/u);
    assert.match(result.stderr, /better-auth-runtime\.ts/u);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

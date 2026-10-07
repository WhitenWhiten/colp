/**
 * Locks the production export surface so dangerous test-only helpers cannot
 * re-enter the package root / sync barrels (SYNC-V-006 packaging).
 *
 * H-16: `./sync` is a first-class package subpath (same shape as
 * `./publisher` / `./feed` / `./security`). Runtime keys of that subpath must
 * match the public value exports of `src/sync/index.ts`. `src/sync/legacy.ts`
 * remains an internal compatibility module, not its own export.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as rootApi from '../../src/index.js';
import * as syncApi from '../../src/sync/index.js';
import * as testingApi from '../../src/testing/index.js';

const evidence = '[evidence:sync.export-surface]';
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const packageJsonPath = join(packageRoot, 'package.json');
const tsupConfigPath = join(packageRoot, 'tsup.config.ts');
const syncIndexPath = join(packageRoot, 'src/sync/index.ts');
const distSyncDir = join(packageRoot, 'dist/sync');
const distPresent = existsSync(join(distSyncDir, 'index.js'));
const distSyncArtifacts = [
  'index.js',
  'index.cjs',
  'index.d.ts',
  'index.d.cts',
] as const;

function distGraphContainsNodeBuiltin(entry: string): boolean {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!existsSync(file)) continue;
    const source = readFileSync(file, 'utf8');
    if (/\bfrom ['"]node:|require\(['"]node:/u.test(source)) return true;
    for (const match of source.matchAll(/(?:from|import)\s*['"](\.[^'"]+)['"]/gu)) {
      stack.push(join(dirname(file), match[1]!));
    }
  }
  return false;
}

const TEST_ONLY_HELPERS = [
  'createUnverifiedReplicaAuthProofForTests',
  'createTestReplicaAuthProof',
] as const;

/** Representative production APIs the `./sync` subpath must expose. */
const REQUIRED_SYNC_APIS = [
  'createSyncHost',
  'coordinateSessionBoundPush',
  'coordinateSessionBoundPull',
  'coordinateSessionBoundSequence',
  'coordinateSessionBoundReplicaLifecycle',
  'createTypedUpdateMergePushPreflight',
  'bindSyncPushBatchId',
  'isVerifiedSyncSession',
  'withRecommendedSnapshotUrlHostPolicy',
  'rejectPrivateOrLocalSnapshotUrl',
  'SYNC_HOST_COMPOSITION_RECIPE',
  'SYNC_HOST_COMPOSITION_NOTES',
] as const;

const FORBIDDEN_BARE_COORDINATORS = [
  'coordinatePushTransaction',
  'coordinateSyncPull',
  'coordinateSequenceOperation',
] as const;

type ExportConditionMap = {
  readonly types?: {
    readonly import?: string;
    readonly require?: string;
  };
  readonly import?: string;
  readonly require?: string;
};

/**
 * Value identifiers from `export { … }` / `export function|const|class|enum`.
 * Type-only specifiers (`type Foo`, `export type`, `export interface`) are omitted
 * so the result can be compared with `Object.keys` of the runtime namespace.
 */
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
      if (renamed === null) {
        continue;
      }
      names.add(renamed[2] ?? renamed[1]!);
    }
  }

  return [...names].sort();
}

describe('Sync production export surface', () => {
  it(`does not re-export createUnverifiedReplicaAuthProofForTests from root or sync barrels ${evidence}`, () => {
    expect(
      Object.prototype.hasOwnProperty.call(rootApi, 'createUnverifiedReplicaAuthProofForTests'),
    ).toBe(false);
    expect(
      Object.prototype.hasOwnProperty.call(syncApi, 'createUnverifiedReplicaAuthProofForTests'),
    ).toBe(false);
    expect(
      'createUnverifiedReplicaAuthProofForTests' in rootApi
        && (rootApi as { createUnverifiedReplicaAuthProofForTests?: unknown })
          .createUnverifiedReplicaAuthProofForTests !== undefined,
    ).toBe(false);
    expect(
      'createUnverifiedReplicaAuthProofForTests' in syncApi
        && (syncApi as { createUnverifiedReplicaAuthProofForTests?: unknown })
          .createUnverifiedReplicaAuthProofForTests !== undefined,
    ).toBe(false);
  });

  it(`keeps createUnverifiedReplicaAuthProofForTests / createTestReplicaAuthProof on testing surface ${evidence}`, () => {
    expect(typeof testingApi.createUnverifiedReplicaAuthProofForTests).toBe('function');
    expect(typeof testingApi.createTestReplicaAuthProof).toBe('function');
    const proof = testingApi.createUnverifiedReplicaAuthProofForTests();
    expect(proof).toMatchObject({
      authenticated: true,
      source: 'unverified-test',
    });
    expect(testingApi.createTestReplicaAuthProof().source).toBe('unverified-test');
  });

  it(`exports isVerifiedSyncSession for runtime brand checks ${evidence}`, () => {
    expect(typeof syncApi.isVerifiedSyncSession).toBe('function');
    expect(syncApi.isVerifiedSyncSession({ status: 'active' })).toBe(false);
  });

  it(`exports withRecommendedSnapshotUrlHostPolicy alongside rejectPrivateOrLocalSnapshotUrl ${evidence}`, () => {
    expect(typeof syncApi.withRecommendedSnapshotUrlHostPolicy).toBe('function');
    expect(typeof syncApi.rejectPrivateOrLocalSnapshotUrl).toBe('function');
  });

  it(`publishes ./sync in package.json exports with ESM/CJS + types paths ${evidence}`, () => {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      exports: Record<string, ExportConditionMap | string>;
    };

    expect(Object.hasOwn(packageJson.exports, './sync')).toBe(true);
    expect(packageJson.exports['./sync']).toEqual({
      types: {
        import: './dist/sync/index.d.ts',
        require: './dist/sync/index.d.cts',
      },
      import: './dist/sync/index.js',
      require: './dist/sync/index.cjs',
    });

    expect(Object.hasOwn(packageJson.exports, './sync/legacy')).toBe(false);
    expect(Object.hasOwn(packageJson.exports, './legacy')).toBe(false);

    expect(packageJson.exports['./sync/unsafe']).toEqual({
      types: {
        import: './dist/sync/unsafe.d.ts',
        require: './dist/sync/unsafe.d.cts',
      },
      import: './dist/sync/unsafe.js',
      require: './dist/sync/unsafe.cjs',
    });

    expect(packageJson.exports['./sync/canonical']).toEqual({
      types: {
        import: './dist/sync/canonical.d.ts',
        require: './dist/sync/canonical.d.cts',
      },
      import: './dist/sync/canonical.js',
      require: './dist/sync/canonical.cjs',
    });
  });

  it(`registers sync/index, sync/canonical, and explicit sync/unsafe tsup entries without a legacy subpath ${evidence}`, () => {
    const tsupSource = readFileSync(tsupConfigPath, 'utf8');
    expect(tsupSource).toMatch(/['"]sync\/index['"]\s*:\s*['"]src\/sync\/index\.ts['"]/);
    expect(tsupSource).toMatch(/['"]sync\/unsafe['"]\s*:\s*['"]src\/sync\/unsafe\.ts['"]/);
    expect(tsupSource).toMatch(/['"]sync\/canonical['"]\s*:\s*['"]src\/sync\/canonical\.ts['"]/);
    expect(tsupSource).not.toMatch(/src\/sync\/legacy\.ts/);
    expect(tsupSource).not.toMatch(/['"]sync\/legacy['"]/);
  });

  it(`keeps the ./sync runtime key set identical to src/sync/index.ts public value exports ${evidence}`, () => {
    const declared = publicValueExportNames(readFileSync(syncIndexPath, 'utf8'));
    const runtime = Object.keys(syncApi).sort();
    expect(runtime).toEqual(declared);

    const missing = REQUIRED_SYNC_APIS.filter((name) => !(name in syncApi));
    expect(missing).toEqual([]);

    for (const helper of TEST_ONLY_HELPERS) {
      expect(syncApi).not.toHaveProperty(helper);
      expect(declared).not.toContain(helper);
    }
    for (const name of FORBIDDEN_BARE_COORDINATORS) {
      expect(syncApi).not.toHaveProperty(name);
      expect(declared).not.toContain(name);
    }
    expect(typeof syncApi.createSyncHost).toBe('function');
  });

  it(`lists sync and sync/canonical among README public subpaths and keeps unsafe off that list ${evidence}`, () => {
    const readme = readFileSync(join(packageRoot, 'README.md'), 'utf8');
    expect(readme).toMatch(/public subpaths are[\s\S]*`sync`/u);
    expect(readme).toMatch(/public subpaths are[\s\S]*`sync\/canonical`/u);
    expect(readme).not.toMatch(/public subpaths are[\s\S]*`sync\/unsafe`/u);
    expect(readme).toContain('@know-n/colp/sync');
    expect(readme).toContain('@know-n/colp/sync/canonical');
  });

  it.skipIf(!distPresent)(
    'when dist/ exists, pack/dist/sync artifacts match the public ./sync runtime key set',
    async () => {
      for (const artifact of distSyncArtifacts) {
        expect(existsSync(join(distSyncDir, artifact))).toBe(true);
      }

      const require = createRequire(import.meta.url);
      const esm = (await import(join(distSyncDir, 'index.js'))) as Record<string, unknown>;
      const cjs = require(join(distSyncDir, 'index.cjs')) as Record<string, unknown>;
      const sourceKeys = Object.keys(syncApi).sort();
      expect(Object.keys(esm).sort()).toEqual(sourceKeys);
      expect(Object.keys(cjs).sort()).toEqual(sourceKeys);

      for (const name of REQUIRED_SYNC_APIS) {
        expect(esm, `dist ESM ${name}`).toHaveProperty(name);
        expect(cjs, `dist CJS ${name}`).toHaveProperty(name);
      }
      for (const helper of TEST_ONLY_HELPERS) {
        expect(esm).not.toHaveProperty(helper);
        expect(cjs).not.toHaveProperty(helper);
      }
      for (const name of FORBIDDEN_BARE_COORDINATORS) {
        expect(esm).not.toHaveProperty(name);
        expect(cjs).not.toHaveProperty(name);
      }

      const unsafeEsm = (await import(join(distSyncDir, 'unsafe.js'))) as Record<string, unknown>;
      const unsafeCjs = require(join(distSyncDir, 'unsafe.cjs')) as Record<string, unknown>;
      for (const name of FORBIDDEN_BARE_COORDINATORS) {
        expect(typeof unsafeEsm[name]).toBe('function');
        expect(typeof unsafeCjs[name]).toBe('function');
      }

      const canonicalEsm = (await import(join(distSyncDir, 'canonical.js'))) as Record<string, unknown>;
      const canonicalCjs = require(join(distSyncDir, 'canonical.cjs')) as Record<string, unknown>;
      expect(typeof canonicalEsm.canonicalOperationDigest).toBe('function');
      expect(typeof canonicalCjs.canonicalOperationDigest).toBe('function');
      expect(canonicalEsm.canonicalOperationDigest).toBe(esm.canonicalOperationDigest);
      expect(distGraphContainsNodeBuiltin(join(distSyncDir, 'canonical.js'))).toBe(false);
    },
    // Import the complete built graph in both module formats under coverage.
    30_000,
  );
});

it('keeps trusted lifecycle/maintenance exports distinct from unsafe data-plane coordinators', () => {
  for (const name of ['coordinateSessionBootstrap', 'coordinateTombstonePurge',
    'coordinateReplicaDueExpiry', 'coordinateReplicaLifecycle'] as const) {
    expect(typeof syncApi[name]).toBe('function');
  }
  for (const name of FORBIDDEN_BARE_COORDINATORS) expect(name in syncApi).toBe(false);
});

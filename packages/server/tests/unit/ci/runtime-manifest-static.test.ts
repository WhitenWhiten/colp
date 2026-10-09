import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'vitest';
import {
  RUNTIME_FORBIDDEN_PACKAGES,
  runtimeManifestFrom,
} from '../../../scripts/build-runtime-manifest.mjs';

/**
 * The production image installs from `runtime/`, a manifest without
 * devDependencies plus a lockfile pruned from the dev lockfile. The dev
 * lockfile marks vitest/tinypool/tsx as optional peers of better-auth, so a
 * plain `npm prune --omit=dev` would keep shipping test tooling. This suite
 * checks the committed derivation without touching the network; the full
 * regeneration drift check runs in CI (`npm run runtime:manifest:check`).
 */
const ROOT = new URL('../../../', import.meta.url);

interface LockEntry {
  readonly version?: string;
  readonly dev?: boolean;
  readonly peer?: boolean;
  readonly optional?: boolean;
}
interface Lockfile {
  readonly lockfileVersion: number;
  readonly packages: Record<string, LockEntry>;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(new URL(path, ROOT), 'utf8')) as T;
}

describe('runtime manifest and lockfile', () => {
  test('runtime/package.json is exactly the runtime projection of package.json', async () => {
    const dev = await readJson<Record<string, unknown>>('package.json');
    const runtime = await readJson<Record<string, unknown>>('runtime/package.json');
    assert.deepEqual(runtime, runtimeManifestFrom(dev));
    assert.equal('devDependencies' in runtime, false);
    assert.equal('scripts' in runtime, false);
    assert.deepEqual(runtime.dependencies, dev.dependencies);
    assert.deepEqual(runtime.overrides, dev.overrides);
    assert.deepEqual(runtime.bin, dev.bin);
  });

  test('runtime lockfile is a pruned subset of the dev lockfile with identical versions', async () => {
    const dev = await readJson<Lockfile>('package-lock.json');
    const runtime = await readJson<Lockfile>('runtime/package-lock.json');
    assert.equal(runtime.lockfileVersion, dev.lockfileVersion);
    assert.ok(Object.keys(runtime.packages).length < Object.keys(dev.packages).length);
    for (const [path, entry] of Object.entries(runtime.packages)) {
      if (path === '') continue;
      assert.notEqual(entry.dev, true, `${path} must not be a dev entry`);
      const devEntry = dev.packages[path];
      assert.ok(devEntry, `${path} must come from the dev lockfile`);
      assert.equal(entry.version, devEntry.version, `${path} must keep the dev lockfile version`);
    }
    for (const dependency of Object.keys((await readJson<{ dependencies: Record<string, string> }>('runtime/package.json')).dependencies)) {
      assert.ok(runtime.packages[`node_modules/${dependency}`], `${dependency} must be present in the runtime lock`);
    }
  });

  test('test tooling can only appear as optional peers that --omit=peer drops', async () => {
    const runtime = await readJson<Lockfile>('runtime/package-lock.json');
    for (const name of RUNTIME_FORBIDDEN_PACKAGES) {
      const entry = runtime.packages[`node_modules/${name}`];
      if (entry !== undefined) assert.equal(entry.peer, true, `${name} must be peer-only in the runtime lock`);
    }
  });

  test('the image and CI install the runtime lock with --omit=dev --omit=peer and audit it', async () => {
    const dockerfile = await readFile(new URL('Dockerfile', ROOT), 'utf8');
    assert.match(dockerfile, /AS runtime-deps/u);
    assert.match(dockerfile, /COPY packages\/server\/runtime\/package\.json packages\/server\/runtime\/package-lock\.json/u);
    assert.match(dockerfile, /npm ci --omit=dev --omit=peer --ignore-scripts/u);
    assert.match(dockerfile, /COPY --from=runtime-deps \/app\/node_modules \.\/node_modules/u);
    assert.doesNotMatch(dockerfile, /^RUN[^\n]*npm prune/mu, 'prune cannot detach optional peers');
    for (const name of RUNTIME_FORBIDDEN_PACKAGES) assert.ok(dockerfile.includes(name), `image must refuse ${name}`);

    const workflow = await readFile(new URL('../../.github/workflows/colp-ci.yml', ROOT), 'utf8');
    assert.match(workflow, /npm run runtime:manifest:check/u);
    assert.match(workflow, /npm ci --omit=dev --omit=peer --ignore-scripts [^\n]*--prefix runtime/u);
    assert.match(workflow, /npm run scan:dependencies:runtime/u);
    assert.match(workflow, /npm run test:static/u);

    const scripts = (await readJson<{ scripts: Record<string, string> }>('package.json')).scripts;
    assert.equal(scripts['scan:dependencies:runtime'], 'npm audit --omit=dev --omit=peer --audit-level=high --prefix runtime');
    assert.equal(scripts['runtime:manifest:check'], 'node scripts/build-runtime-manifest.mjs --check');
  });
});

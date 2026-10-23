/**
 * Owner: KNS-08 (QA). Fixture: see e2e/kns-08-ids.ts.
 * Run: see e2e/kns-08-ids.ts.
 * Evidence: test-results/known-extension-first-run-sync/<commit>/
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

async function readFromPackage(relativePath: string): Promise<string> {
  return readFile(join(root, relativePath), 'utf8');
}

describe('KNS-00 spelling freeze', () => {
  test('locks first-run and scope message kinds in types.ts', async () => {
    const types = await readFromPackage('src/types.ts');
    for (const kind of [
      'known.firstRun.preview', 'known.firstRun.confirm', 'known.firstRun.status', 'known.firstRun.later',
      'known.firstRun.attention.get', 'known.firstRun.attention.decide',
      'known.scope.detach', 'known.scope.rejoin', 'known.scope.remoteDelete',
      'known.roots.preview', 'known.roots.confirm',
    ]) {
      assert.match(types, new RegExp(`kind: '${kind}'`));
    }
    assert.match(types, /preview_stale/);
    assert.match(types, /draft' \| 'confirmed' \| 'scanning' \| 'matching' \| 'syncing' \| 'completed' \| 'needs_attention/);
  });

  test('documents v10 store names with the current DATABASE_VERSION', async () => {
    const authority = await readFromPackage('docs/indexeddb-sync-state-authority.md');
    const schema = await readFromPackage('src/sync-state/schema.ts');
    for (const store of ['mount_bindings', 'scope_previews', 'bootstrap_runs', 'deletion_journal']) {
      assert.match(authority, new RegExp(`\`${store}\``));
    }
    assert.match(authority, /firstRun: 'none' \| 'deferred' \| 'running' \| 'completed'/);
    assert.match(schema, /DATABASE_VERSION = 23/);
    assert.doesNotMatch(schema, /DATABASE_VERSION = 9/);
  });

  test('keeps nativeId out of the public Node identity freeze', async () => {
    const sidecar = await readFromPackage('fixtures/kns-00-native-mapping-sidecar.json');
    const types = await readFromPackage('src/types.ts');
    const publicSlice = types.slice(types.indexOf('export interface PublicRootNode'),
      types.indexOf('export type ExtensionRequest'));
    assert.match(sidecar, /"nativeId"/);
    assert.doesNotMatch(publicSlice, /nativeId/);
  });

  test('applies node_restored with original identity instead of treating it as delete', async () => {
    const codec = await readFromPackage('src/pull-codec.ts');
    const runtime = await readFromPackage('src/pull-apply-runtime.ts');
    const validators = await readFromPackage('src/generated/pull-effect-validators.js');
    assert.match(validators, /node_restored/);
    assert.match(codec, /kind === 'node_restored'/);
    assert.match(codec, /operation.type !== 'restore_node'/);
    assert.doesNotMatch(codec, /kind === 'node_deleted'[\s\S]{0,80}node_restored|kind === 'node_restored'[\s\S]{0,80}node_deleted/);
    assert.match(runtime, /async function applyRestored/);
  });
});

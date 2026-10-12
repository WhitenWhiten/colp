import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'vitest';
import { readServiceWorkerGraph } from './service-worker-graph.js';

describe('P3-35 bookmark import contract boundaries', () => {
  test('uses the generated COLP validators and keeps the planner inert', async () => {
    const [plan, worker, manifest, options] = await Promise.all([
      readFile(new URL('../src/bookmark-import-plan.ts', import.meta.url), 'utf8'),
      readServiceWorkerGraph(),
      readFile(new URL('../manifest.base.json', import.meta.url), 'utf8'),
      readFile(new URL('../src/options.ts', import.meta.url), 'utf8'),
    ]);
    // Codegen boundary: the import plan must validate against the generated public COLP
    // validators. Plan/queue/commit behaviour (enqueueImportNode, digest binding,
    // preview invalidation, `importPreviews.clear`) is behavioural in
    // tests/bookmark-import-plan.test.ts, tests/import-commit-path.test.ts and
    // tests/options-import-ui.test.ts.
    assert.match(plan, /generated\/bookmark-operation-validators\.js/);
    // static-only: absence claims — a DOM-free pure planner (no timers, no network), no
    // web credential bridge (no postMessage/analytics/console) and no
    // externally_connectable manifest entry. None of these leave a trace in the durable
    // plan state.
    assert.doesNotMatch(plan, /setTimeout|setInterval|fetch\(/);
    assert.doesNotMatch(worker + options, /postMessage\(|analytics|console\.(?:log|info|debug)/);
    assert.doesNotMatch(manifest, /externally_connectable/);
  });

  test('build and evidence include the import workflow, production artifact and privacy scans', async () => {
    const [build, pkg, evidence] = await Promise.all([
      readFile(new URL('../scripts/build.mjs', import.meta.url), 'utf8'),
      readFile(new URL('../package.json', import.meta.url), 'utf8'),
      readFile(new URL('../scripts/verify-bookmark-import-artifacts.mjs', import.meta.url), 'utf8'),
    ]);
    assert.match(build, /bookmark-import-plan/); assert.match(pkg, /evidence:phase3-bookmark-import/);
    for (const marker of ['Chromium', 'DATABASE_URL', 'bookmarks', 'indexedDB', 'source file', 'authorization']) {
      assert.match(evidence, new RegExp(marker, 'i'));
    }
  });
});

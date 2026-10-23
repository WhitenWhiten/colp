import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

/**
 * CI gate contract (allowlisted in tests/static-anchor-allowlist.ts): the workflow YAML
 * and npm scripts are the artifacts under test; verifying them by execution would mean
 * running the e2e/evidence commands, which is out of the host unit lane.
 */
const packageRoot = resolve(import.meta.dirname, '..');
const repositoryRoot = resolve(packageRoot, '../..');
const packageJson = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as {
  readonly scripts?: Readonly<Record<string, string>>;
};
const workflow = readFileSync(
  resolve(repositoryRoot, '.github', 'workflows', 'colp-ci.yml'),
  'utf8',
);

describe('Extension named Sync CI owners [SYNC-Q-021]', () => {
  it('pins the real-stack owner to effect-page, recovery, and MV3 pull-applier evidence', () => {
    expect(packageJson.scripts?.['test:sync-real-stack']).toContain('tests/effect-page-download.test.ts');
    expect(packageJson.scripts?.['test:sync-real-stack']).toContain('tests/recovery-store.test.ts');
    expect(packageJson.scripts?.['test:sync-real-stack']).toContain('tests/authority-fence.test.ts');
    expect(packageJson.scripts?.['test:sync-budget-contract']).toBe(
      'vitest run tests/transport-budget.test.ts',
    );
    expect(packageJson.scripts?.['evidence:phase3-pull-applier']).toContain('with-postgres.mjs');
    expect(packageJson.scripts?.['evidence:phase3-pull-applier:inner']).toContain('mv3-pull-applier.spec.ts');
    expect(packageJson.scripts?.['evidence:critical-mv3']).toContain('with-postgres.mjs');
    for (const owner of ['mv3-auth-shell.spec.ts', 'mv3-popup-save.spec.ts',
      'mv3-bookmark-manager.spec.ts', 'mv3-pull-applier.spec.ts',
      'mv3-outbound-push.spec.ts', 'mv3-durable-sync-engine.spec.ts',
      'mv3-bookmark-event-queue.spec.ts', 'mv3-remote-delete-policy.spec.ts']) {
      expect(packageJson.scripts?.['evidence:critical-mv3:inner']).toContain(owner);
    }
    expect(workflow).toContain('extension-sync-real-stack:');
    expect(workflow).toContain('run: npm run test:sync-real-stack');
    expect(workflow).toContain('npm run evidence:critical-mv3');
    expect(workflow).toContain('- extension-sync-real-stack');
    const realStack = workflow.split('extension-sync-real-stack:')[1]?.split(/\n  [a-z]/u)[0] ?? '';
    expect(realStack).toContain('Frozen server harness install');
    expect(realStack).toContain('Install X11 extension permission driver');
    expect(realStack).toContain('apt-get install --yes --no-install-recommends xdotool');
    expect(realStack).toContain('working-directory: packages/server');
    expect(realStack).toContain('packages/server/package-lock.json');
  });

  it.each(['mv3-outbound-push.spec.ts', 'mv3-durable-sync-engine.spec.ts',
    'mv3-bookmark-event-queue.spec.ts', 'mv3-remote-delete-policy.spec.ts'])(
    'routes the %s MV3 e2e owner through the ci-gate dependency chain', (owner) => {
      expect(packageJson.scripts?.['evidence:critical-mv3:inner']).toContain(owner);
      expect(packageJson.scripts?.['evidence:critical-mv3']).toContain('evidence:critical-mv3:inner');
      expect(workflow).toContain('npm run evidence:critical-mv3');
      expect(workflow).toContain('- extension-sync-real-stack');
    });

  it('runs the complete browser inventory and model vectors in required CI jobs', () => {
    const job = workflow.split('  extension-browser:')[1]?.split(/\n  [a-z]/u)[0] ?? '';
    expect(job).toContain('shard: [1, 2, 3, 4, 5, 6]');
    expect(job).toContain('npm run test:e2e:inner -- --shard=${{ matrix.shard }}/6');
    expect(packageJson.scripts?.['test:e2e:inner']).toContain('node scripts/with-xvfb.mjs');
    expect(packageJson.scripts?.['test:e2e:inner']).toContain('--project=core');
    expect(packageJson.scripts?.['test:e2e:self-hosted']).toContain('with-self-hosted-browser.mjs');
    expect(packageJson.scripts?.['test:e2e:self-hosted']).toContain('--project=self-hosted');
    expect(workflow).toContain('run: npm run test:e2e:self-hosted');
    expect(job).toContain('BS_CAPACITY_NODES: 20000');
    expect(workflow).toContain('run: npm run test:sync-model');
    const gate = workflow.slice(workflow.indexOf('  ci-gate:'));
    expect(gate).toContain('- extension-browser');
    expect(gate).toContain('${{ needs.extension-browser.result }}');
    expect(gate).toContain('"$EXTENSION_BROWSER_RESULT"');
    expect(gate).toContain('- self-hosted-browser');
    expect(gate).toContain('${{ needs.self-hosted-browser.result }}');
    expect(gate).toContain('"$SELF_HOSTED_BROWSER_RESULT"');
  });

  it('Playwright independently collects every on-disk browser spec, including multi-device recovery', () => {
    const root = resolve(packageRoot, 'e2e');
    const files = readdirSync(root, { recursive: true }).map(String).filter(file => file.endsWith('.spec.ts')).sort();
    const report = JSON.parse(execFileSync(process.execPath, [resolve(packageRoot, 'scripts/with-xvfb.mjs'),
      process.execPath, resolve(packageRoot, 'node_modules/@playwright/test/cli.js'),
      'test', '--list', '--reporter=json'], { cwd: packageRoot, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })) as {
        errors: unknown[]; config: { rootDir: string }; suites: Array<{ file: string }>;
      };
    expect(report.errors).toEqual([]);
    const collected = [...new Set(report.suites.map(suite => relative(root, resolve(report.config.rootDir, suite.file))))].sort();
    expect(collected).toEqual(files);
    expect(collected).toContain('mv3-multi-device-recovery.spec.ts');
    expect(collected).toContain('mv3-sync-resilience.spec.ts');
  }, 30_000);
});

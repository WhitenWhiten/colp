import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { expect, test } from 'vitest';

const workflow = parse(readFileSync(resolve(import.meta.dirname,
  '../../../../../.github/workflows/colp-extension-release.yml'), 'utf8')) as {
  on: { push: { tags: string[] } };
  jobs: { release: { steps: Array<{ name?: string; run?: string }> } };
};

test('only extension tag pushes publish extension releases', () => {
  expect(workflow.on).toEqual({ push: { tags: ['extension-v*'] } });
});

test.each([false, true])('publishes the ZIP with prerelease=%s', prerelease => {
  const root = mkdtempSync(join(tmpdir(), 'colp-extension-workflow-'));
  try {
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'bin/gh'), '#!/bin/bash\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    const version = prerelease ? '0.1.0-rc.1' : '0.1.0';
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c',
      workflow.jobs.release.steps.find(step => step.name === 'Create the GitHub release')!.run!], {
      cwd: root, encoding: 'utf8', env: {
        ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`,
        RUNNER_TEMP: root, RELEASE_TAG: `extension-v${version}`,
        EXTENSION_VERSION: version, EXTENSION_PRERELEASE: String(prerelease),
      },
    });
    expect(result.status, result.stderr).toBe(0);
    const args = result.stdout.trim().split('\n');
    expect(args).toContain(`extension-v${version}`);
    expect(args).toContain(`packages/extension/dist/known-extension-${version}.zip`);
    expect(args).toContain('--verify-tag');
    expect(args.includes('--prerelease')).toBe(prerelease);
    expect(args.includes('--latest=false')).toBe(prerelease);
    expect(args).toContain(join(root, 'changelog-section.md'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

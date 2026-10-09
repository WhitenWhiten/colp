import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const workflow = parse(readFileSync(resolve(import.meta.dirname, '../../../../../.github/workflows/colp-server-image.yml'), 'utf8')) as {
  on: { push: { tags: string[] } };
  jobs: { image: { steps: Array<{ name?: string; run?: string }> } };
};
const steps = workflow.jobs.image.steps;
const digest = `sha256:${'a'.repeat(64)}`;
const amd64 = `sha256:${'c'.repeat(64)}`;
const arm64 = `sha256:${'d'.repeat(64)}`;
const manifest = { schemaVersion: 2, manifests: [
  { digest: amd64, platform: { os: 'linux', architecture: 'amd64' } },
  { digest: arm64, platform: { os: 'linux', architecture: 'arm64' } },
  { digest: `sha256:${'e'.repeat(64)}`, platform: { os: 'unknown', architecture: 'unknown' } },
] };

function runStep(name: string, overrides: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'colp-image-workflow-'));
  try {
    mkdirSync(join(directory, 'bin'));
    mkdirSync(join(directory, 'deploy'));
    const calls = join(directory, 'calls');
    writeFileSync(calls, '');
    const stub = (file: string, source: string) => writeFileSync(join(directory, file), `#!/bin/bash\nset -eu\n${source}\n`, { mode: 0o755 });
    stub('bin/docker', 'printf "docker %s\\n" "$*" >> "$COLP_TEST_CALLS"\nif [[ "$*" == *"imagetools inspect"* ]]; then\n  if [[ "$*" == *"--raw"* ]]; then printf "%s\\n" "$COLP_TEST_INDEX"; else printf "%s\\n" "$COLP_TEST_PUBLISHED_DIGEST"; fi\nfi');
    stub('bin/git', 'printf "%s\\n" "$COLP_TEST_RELEASE_TAGS"');
    stub('deploy/smoke.sh', 'printf "smoke %s\\n" "$*" >> "$COLP_TEST_CALLS"');
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', steps.find(step => step.name === name)!.run!], {
      cwd: directory, encoding: 'utf8', env: {
        ...process.env, PATH: `${join(directory, 'bin')}:${process.env.PATH}`,
        RUNNER_TEMP: directory, COLP_IMAGE: 'ghcr.io/whitenwhiten/colp-server',
        COLP_VERSION: '0.1.0', COLP_MINOR: '0.1', COLP_PRERELEASE: 'false',
        COLP_CANDIDATE_DIGEST: digest, COLP_TEST_PUBLISHED_DIGEST: digest,
        COLP_TEST_INDEX: JSON.stringify(manifest),
        COLP_TEST_CALLS: calls, COLP_TEST_RELEASE_TAGS: 'abc refs/tags/colp-server-v0.1.0', ...overrides,
      },
    });
    const override = join(directory, 'colp-image-override.yaml');
    return { status: result.status, calls: readFileSync(calls, 'utf8'), stderr: result.stderr,
      override: existsSync(override) ? readFileSync(override, 'utf8') : '' };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

describe('server image release workflow', () => {
  it('validates the changelog before building and promotes after both platform smokes', () => {
    expect(workflow.on).toEqual({ push: { tags: ['colp-server-v*'] } });
    const names = steps.map(step => step.name);
    expect(names.indexOf('Require a CHANGELOG section for this tag')).toBeLessThan(names.indexOf('Build one candidate manifest for both platforms'));
    expect(names.indexOf('Smoke the exact candidate digest on both platforms')).toBeLessThan(names.indexOf('Promote the tested manifest without rebuilding'));
  });

  it('promotes a prerelease without moving the minor or latest tag', () => {
    const result = runStep('Promote the tested manifest without rebuilding', { COLP_VERSION: '0.1.0-rc.1', COLP_PRERELEASE: 'true' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toContain(`--tag ghcr.io/whitenwhiten/colp-server:0.1.0-rc.1 ghcr.io/whitenwhiten/colp-server@${digest}`);
    expect(result.calls).not.toContain('--tag ghcr.io/whitenwhiten/colp-server:0.1 ');
    expect(result.calls).not.toContain(':latest');
  });

  it('moves latest for the highest stable version and preserves the tested digest', () => {
    const result = runStep('Promote the tested manifest without rebuilding');
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toContain('--tag ghcr.io/whitenwhiten/colp-server:0.1 ');
    expect(result.calls).toContain(`--tag ghcr.io/whitenwhiten/colp-server:latest ghcr.io/whitenwhiten/colp-server@${digest}`);
    expect(result.calls).not.toContain('buildx build');
  });

  it('does not move latest when a newer stable release exists', () => {
    const result = runStep('Promote the tested manifest without rebuilding', {
      COLP_TEST_RELEASE_TAGS: 'abc refs/tags/colp-server-v0.1.0\ndef refs/tags/colp-server-v0.2.0',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).not.toContain(':latest');
  });

  it('refuses a promoted digest that differs from the smoked candidate', () => {
    expect(runStep('Promote the tested manifest without rebuilding', { COLP_TEST_PUBLISHED_DIGEST: `sha256:${'b'.repeat(64)}` }).status).not.toBe(0);
  });

  it('smokes the two immutable platform manifests selected from the candidate index', () => {
    const result = runStep('Smoke the exact candidate digest on both platforms');
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.match(/^smoke http:\/\/127\.0\.0\.1:8080$/gm)).toHaveLength(2);
    expect(result.calls.match(/down -v --remove-orphans/g)).toHaveLength(2);
    expect(result.calls).toContain(`imagetools inspect ghcr.io/whitenwhiten/colp-server@${digest} --raw`);
    expect(result.override).toContain(`image: ghcr.io/whitenwhiten/colp-server@${arm64}`);
    expect(result.override).toContain('platform: linux/arm64');
    expect(result.override).not.toContain(`@${digest}`);
    const source = steps.find(step => step.name === 'Smoke the exact candidate digest on both platforms')!.run!;
    expect(source).toContain('for platform in linux/amd64 linux/arm64');
    expect(source).toContain('"$COLP_IMAGE@$COLP_CANDIDATE_DIGEST" --raw');
  });

  it.each([
    { manifests: [manifest.manifests[0]] },
    { manifests: [manifest.manifests[0], manifest.manifests[0], manifest.manifests[1]] },
    { manifests: [manifest.manifests[0], { digest: 'sha256:invalid', platform: { os: 'linux', architecture: 'arm64' } }] },
  ])('refuses missing, ambiguous or invalid platform manifests', index => {
    const result = runStep('Smoke the exact candidate digest on both platforms', { COLP_TEST_INDEX: JSON.stringify(index) });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('candidate must contain one valid manifest');
  });
});

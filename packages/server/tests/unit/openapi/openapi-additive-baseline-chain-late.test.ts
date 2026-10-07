import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'vitest';

const backendRoot = resolve(import.meta.dirname, '../../..');

function runNodeScript(script: string, args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(backendRoot, script), ...args], { cwd: backendRoot });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.once('error', reject);
    child.once('close', (status) => {
      clearTimeout(timeout);
      resolve({ status, stdout, stderr });
    });
  });
}

test('later Product minor baselines stay additive through the current bundle', async () => {
  const product183Baseline = join(backendRoot, 'openapi/baselines/product-v1.1.83.0.yaml');
  const product184Baseline = join(backendRoot, 'openapi/baselines/product-v1.1.84.0.yaml');
  const product185Baseline = join(backendRoot, 'openapi/baselines/product-v1.1.85.0.yaml');
  const product186Baseline = join(backendRoot, 'openapi/baselines/product-v1.1.86.0.yaml');
  const product187Baseline = join(backendRoot, 'openapi/baselines/product-v1.1.87.0.yaml');
  const product188Baseline = join(backendRoot, 'openapi/baselines/product-v1.1.88.0.yaml');

  // 1.84.0 freezes the bookmark-subscriptions contract; 1.85.0 adds the
  // optional TargetView commentDeniedReason (R14-36); 1.86.0 adds the public
  // link preview object route and optional previewImage (LP-04). All additive.
  for (const [baseline, candidate] of [
    [product183Baseline, product184Baseline],
    [product184Baseline, product185Baseline],
    [product185Baseline, product186Baseline],
  ]) {
    const result = await runNodeScript('scripts/check-openapi-breaking.mjs', [
      '--baseline', baseline,
      '--candidate', candidate,
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }

  // 1.88.0 shortens link-preview success caching so hide_public can revoke a
  // previously public image. That cache const change is an intentional break
  // against 1.87.0; the frozen 1.88.0 baseline matches the current bundle.
  const previewCacheBreak = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', product187Baseline,
    '--candidate', product188Baseline,
  ]);
  assert.equal(previewCacheBreak.status, 1, 'link preview cache revocation must be flagged as breaking against 1.87.0');
  const currentAgainstFrozen = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', product188Baseline,
    '--candidate', join(backendRoot, 'generated/openapi/product-v1.bundle.yaml'),
  ]);
  assert.equal(currentAgainstFrozen.status, 0, currentAgainstFrozen.stderr || currentAgainstFrozen.stdout);
}, 120_000);

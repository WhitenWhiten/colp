/**
 * P4A-R07 diagnostics contract suite: the I16 acceptance CLI report boundary.
 *
 * The runner's fail-closed exit MUST keep the machine contract line
 * `phase4a_i16_acceptance_failed:<code>` byte-identical (the local R2 runner
 * failure judgment and the CI contract classify a run from it), while the
 * FULL diagnostic must reach the operator. `stableI16FailureCode` truncates
 * the message at the first `:` on purpose, so the provider-failure tails the
 * R04 controls attach (`r04_races_seed_failed:delete:<class>[:<code>]
 * [:<status>]`, `:claim` / `:outbox_complete` / `:stored_private`) never
 * reached the CLI output — a sealed run failed with a bare
 * `phase4a_i16_acceptance_failed:r04_races_seed_failed` and no provider
 * detail, losing the diagnostic at the report boundary.
 *
 * This suite proves the fix at BOTH levels:
 *   (a) the formatter (`i16FailureDetail`) returns the COMPLETE message
 *       whenever it carries a tail beyond the stable code and `undefined`
 *       otherwise (no duplicate line), while the stable classification stays
 *       recognizable through `stableI16FailureCode`;
 *   (b) the REAL runner CLI, spawned as a `node --import tsx` subprocess
 *       (same pattern as `phase4a-r05-source-control-plane.test.ts`) with a
 *       scrubbed/dummy environment, fails closed with exit 1 and prints on
 *       stderr BOTH the stable line and the complete detail line
 *       (`configuration_missing:P4A_PROBE_TARGET`), and — on a bare-code
 *       source-binding failure (no colon tail: `source_revision_unpinned`,
 *       `source_worktree_not_clean` or `source_revision_unavailable`,
 *       whichever the local worktree/git state picks) — prints ONLY the
 *       stable line. Both paths fail before any network/R2/PostgreSQL
 *       contact, so the smoke is deterministic and side-effect-free.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, test } from 'vitest';
import {
  i16FailureDetail,
  stableI16FailureCode,
} from '../../../scripts/evidence/phase4a-i16-acceptance.js';

const RUNNER_SCRIPT = resolve(process.cwd(), 'scripts/phase4a-i16-acceptance-runner.ts');
const STABLE_PREFIX = 'phase4a_i16_acceptance_failed:';
const DETAIL_PREFIX = 'phase4a_i16_failure_detail:';

function runCli(env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['--import', 'tsx', RUNNER_SCRIPT], {
    cwd: process.cwd(),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
    env,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Removes every acceptance environment variable so the CLI fails fast at the
 * config gate (`configuration_missing`) before any network/R2/PostgreSQL
 * contact — deterministic regardless of what the outer environment holds.
 */
function envWithoutI16Secrets(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('P4A_') || key === 'DATABASE_URL' || key === 'KNOWN_TEST_DATABASE_URL') {
      delete env[key];
    }
  }
  return env;
}

/** A syntactically VALID dummy configuration: passes the config gate, so the
 * run proceeds to the LOCAL git source binding and fails there with a BARE
 * code — `source_worktree_not_clean` while the working tree is dirty,
 * `source_revision_unpinned` when clean (a git failure maps to
 * `source_revision_unavailable`) — still before any network contact. */
function envWithDummyConfig(): NodeJS.ProcessEnv {
  const accountId = '0123456789abcdef0123456789abcdef';
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    P4A_PROBE_TARGET: 'cloudflare-r2-direct-object-api',
    P4A_R2_ENDPOINT: `https://${accountId}.r2.cloudflarestorage.com/`,
    P4A_R2_ACCOUNT_ID: accountId,
    P4A_R2_BUCKET: 'diagnostics-contract-bucket',
    P4A_R2_PROBE_PREFIX: 'capability-probes/diagnostics-contract/',
    P4A_R2_ACCESS_KEY_ID: 'rw-access-key-16chars',
    P4A_R2_SECRET_ACCESS_KEY: 'rw-secret-access-key-24chars-min',
    P4A_R2_READ_ACCESS_KEY_ID: 'ro-access-key-16chars',
    P4A_R2_READ_SECRET_ACCESS_KEY: 'ro-secret-access-key-24chars-min',
    P4A_I16_DATABASE_URL: 'postgresql://user:pass@127.0.0.1:5432/dummy',
    P4A_I16_OUTPUT: 'docs/evidence/phase4a-i16-acceptance.json',
  };
  // Unpinned revision: resolveSourceBinding fails LOCALLY with the bare code
  // `source_revision_unpinned` (no colon tail).
  delete env.P4A_I16_REVIEW_REVISION;
  return env;
}

function lineWithPrefix(output: string, prefix: string): string | undefined {
  return output.split(/\r?\n/u).find((entry) => entry.startsWith(prefix));
}

describe('P4A-R07 failure-detail formatter', () => {
  test('returns the COMPLETE message with the provider tail (the R04 diagnostic the stable line drops)', () => {
    const error = new Error('r04_races_seed_failed:delete:retryable:rate_limited:429');
    assert.equal(
      stableI16FailureCode(error),
      'r04_races_seed_failed',
      'the stable classification must stay recognizable',
    );
    assert.equal(
      i16FailureDetail(error),
      'r04_races_seed_failed:delete:retryable:rate_limited:429',
      'the full detail must reach the report boundary',
    );
    assert.equal(
      `${DETAIL_PREFIX}${i16FailureDetail(error)}`,
      'phase4a_i16_failure_detail:r04_races_seed_failed:delete:retryable:rate_limited:429',
      'the CLI detail line must carry the whole colon tail',
    );
  });

  test('keeps every R04 tail variant intact', () => {
    const variants = [
      'r04_races_seed_failed:delete:retryable',
      'r04_races_seed_failed:delete:denied',
      'r04_races_seed_failed:claim',
      'r04_races_seed_failed:outbox_complete',
      'r04_races_seed_failed:stored_private',
    ] as const;
    for (const message of variants) {
      assert.equal(
        stableI16FailureCode(new Error(message)),
        'r04_races_seed_failed',
        `stable code of ${message}`,
      );
      assert.equal(i16FailureDetail(new Error(message)), message, `detail of ${message}`);
    }
  });

  test('returns undefined when the message has no tail beyond the stable code (no duplicate line)', () => {
    for (const message of [
      'configuration_missing',
      'r04_races_cleanup_lease_not_fenced',
      'source_revision_unpinned',
      'process_cleanup_failed',
    ]) {
      assert.equal(
        stableI16FailureCode(new Error(message)),
        message,
        `bare ${message} stays the stable code`,
      );
      assert.equal(
        i16FailureDetail(new Error(message)),
        undefined,
        `bare ${message} must not print a duplicate detail line`,
      );
    }
  });

  test('a SHORT tail is still a tail: it is returned, never truncated', () => {
    const error = new Error('process_cleanup_failed:r2-rw-store');
    assert.equal(stableI16FailureCode(error), 'process_cleanup_failed');
    assert.equal(i16FailureDetail(error), 'process_cleanup_failed:r2-rw-store');
  });

  test('non-Error throws produce no detail line while the stable line classifies probe_failed', () => {
    for (const value of ['boom', null, undefined, 42, { message: 'r04_races_seed_failed:delete:retryable' }]) {
      assert.equal(stableI16FailureCode(value), 'probe_failed', `stable code of ${String(value)}`);
      assert.equal(i16FailureDetail(value), undefined, `no detail for non-Error ${String(value)}`);
    }
  });

  test('multi-line messages are collapsed onto a single line to keep the CLI output line-oriented', () => {
    const error = new Error('r04_races_seed_failed:delete:retryable\nprovider body detail');
    assert.equal(
      i16FailureDetail(error),
      'r04_races_seed_failed:delete:retryable provider body detail',
      'newlines must never split the report line',
    );
  });

  test('an unknown bare code keeps the probe_failed classification while the detail still surfaces', () => {
    const error = new Error('unexpected_sdk_error:RetryableError:429');
    assert.equal(stableI16FailureCode(error), 'probe_failed', 'unknown codes keep the stable fallback');
    assert.equal(i16FailureDetail(error), 'unexpected_sdk_error:RetryableError:429');
  });
});

describe('P4A-R07 CLI report boundary (real runner subprocess)', () => {
  test('missing environment fails closed with the STABLE line AND the full detail line on stderr', () => {
    const run = runCli(envWithoutI16Secrets());
    assert.equal(run.status, 1, run.stderr);
    assert.doesNotMatch(run.stdout, /phase4a_i16_acceptance:pass/u, 'a failed run must never claim success');

    const stableLine = lineWithPrefix(run.stderr, STABLE_PREFIX);
    assert.equal(
      stableLine,
      'phase4a_i16_acceptance_failed:configuration_missing',
      'the machine-contract line must stay byte-identical (code only, no colon tail)',
    );

    const detailLine = lineWithPrefix(run.stderr, DETAIL_PREFIX);
    assert.equal(
      detailLine,
      'phase4a_i16_failure_detail:configuration_missing:P4A_PROBE_TARGET',
      'the report boundary must print the complete diagnostic on its own line',
    );
  }, 60_000);

  test('a bare-code source-binding failure prints ONLY the stable line (no duplicate detail line)', () => {
    const run = runCli(envWithDummyConfig());
    assert.equal(run.status, 1, run.stderr);

    // WHICH bare source-binding code fires is decided by the local git/worktree
    // state (dirty -> `source_worktree_not_clean`, clean -> `source_revision_
    // unpinned`, git unavailable -> `source_revision_unavailable`), so the
    // smoke must not pin one of them: the byte-identical contract is asserted
    // against the whole bare-code family — every member has no `:` tail and
    // therefore must not print a detail line.
    const stableLine = lineWithPrefix(run.stderr, STABLE_PREFIX);
    const code = stableLine?.slice(STABLE_PREFIX.length);
    assert.match(
      code ?? '',
      /^(source_revision_unpinned|source_worktree_not_clean|source_revision_unavailable)$/u,
      'the stable line must be exactly one bare source-binding code',
    );
    assert.equal(
      stableI16FailureCode(new Error(code!)),
      code,
      'the printed bare code must round-trip through stableI16FailureCode',
    );
    assert.equal(
      lineWithPrefix(run.stderr, DETAIL_PREFIX),
      undefined,
      'no phase4a_i16_failure_detail line when the message carries no tail',
    );
  }, 60_000);

  test('stderr carries exactly one stable line and exactly one detail line', () => {
    const run = runCli(envWithoutI16Secrets());
    assert.equal(run.status, 1, run.stderr);
    assert.equal(
      run.stderr.split(/\r?\n/u).filter((entry) => entry.startsWith(STABLE_PREFIX)).length,
      1,
      'the stable code must be printed exactly once',
    );
    assert.equal(
      run.stderr.split(/\r?\n/u).filter((entry) => entry.startsWith(DETAIL_PREFIX)).length,
      1,
      'the detail line must be printed exactly once',
    );
    assert.match(
      stableI16FailureCode(new Error(lineWithPrefix(run.stderr, STABLE_PREFIX)!.slice(STABLE_PREFIX.length))),
      /^configuration_missing$/u,
      'the stable line content must round-trip through stableI16FailureCode',
    );
  }, 60_000);
});

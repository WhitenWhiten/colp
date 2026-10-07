/**
 * P4A-P08 diagnostics contract suite: the evidence CLI report boundary.
 *
 * The runner's fail-closed exit MUST keep the machine contract line
 * `phase4a_p08_probe_failed:<code>` byte-identical (the local R2 runner
 * failure judgment and the CI contract classify a run from it), while the
 * FULL diagnostic must reach the operator. `stableProbeFailureCode` truncates
 * the message at the first `:` on purpose, so the sub-details
 * `verifyToStored` attaches (`:claim_missing` / `:wrong_event` /
 * `:outbox_complete` / `:stored_private` / `:verified_facts`) and the other
 * provider tails (`delivery_owner_failed:headers`, `r2_read_mismatch:
 * replacement`, ...) never reached the CLI output — a real R2 run failed
 * with a bare `phase4a_p08_probe_failed:verification_not_converged` and no
 * sub-detail, losing the diagnostic at the report boundary.
 *
 * This suite proves the fix at BOTH levels:
 *   (a) the formatter (`p08FailureDetail`) returns the COMPLETE message
 *       whenever it carries a tail beyond the stable code and `undefined`
 *       otherwise (no duplicate line), while the stable classification stays
 *       recognizable through `stableProbeFailureCode`;
 *   (b) the REAL evidence CLI, spawned as a `node --import tsx` subprocess
 *       (same pattern as `phase4a-r07-failure-detail.test.ts`) with a
 *       scrubbed/dummy environment, fails closed with exit 1 and prints on
 *       stderr BOTH the stable line and the complete detail line
 *       (`configuration_missing:P4A_PROBE_TARGET`, `configuration_missing:
 *       DATABASE_URL`), and — on a bare-code source-binding failure
 *       (`source_worktree_not_clean` from a TEMPORARY DIRTY GIT REPOSITORY,
 *       no colon tail) — prints ONLY the stable line. All paths fail before
 *       any network/R2/PostgreSQL contact, so the smoke is deterministic
 *       and side-effect-free.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test } from 'vitest';
import {
  p08FailureDetail,
  stableProbeFailureCode,
} from '../../../scripts/phase4a-p08-evidence.js';

const EVIDENCE_SCRIPT = resolve(process.cwd(), 'scripts/phase4a-p08-evidence.ts');
const STABLE_PREFIX = 'phase4a_p08_probe_failed:';
const DETAIL_PREFIX = 'phase4a_p08_failure_detail:';

function runCli(env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['--import', 'tsx', EVIDENCE_SCRIPT], {
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
 * Removes every probe/evidence environment variable so the CLI fails fast at
 * the config gate (`configuration_missing`) before any git/network/R2/
 * PostgreSQL contact — deterministic regardless of what the outer environment
 * holds.
 */
function envWithoutP08Secrets(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('P4A_') || key === 'DATABASE_URL' || key === 'KNOWN_TEST_DATABASE_URL') {
      delete env[key];
    }
  }
  return env;
}

/**
 * A syntactically VALID dummy probe configuration (the exact fixture the
 * config-contract suite parses) plus a dummy DATABASE_URL: passes the config
 * gate, so the run proceeds to the LOCAL source binding / database gates.
 */
function envWithValidProbeConfig(): NodeJS.ProcessEnv {
  const accountId = 'f'.repeat(32);
  return {
    ...envWithoutP08Secrets(),
    P4A_PROBE_TARGET: 'cloudflare-r2-direct-object-api',
    P4A_R2_ENDPOINT: `https://${accountId}.r2.cloudflarestorage.com`,
    P4A_R2_ACCOUNT_ID: accountId,
    P4A_R2_BUCKET: 'known-test',
    P4A_R2_PROBE_PREFIX: 'capability-probes/local-20260808123456-p08-0123456789abcdef/',
    P4A_R2_ACCESS_KEY_ID: 'c'.repeat(32),
    P4A_R2_SECRET_ACCESS_KEY: 'd'.repeat(64),
    P4A_R2_READ_ACCESS_KEY_ID: 'a'.repeat(32),
    P4A_R2_READ_SECRET_ACCESS_KEY: 'b'.repeat(64),
    DATABASE_URL: 'postgresql://user:pass@127.0.0.1:5432/dummy',
  };
}

/** Same valid config but no database URL at all: fails at the database gate
 * (`configuration_missing:DATABASE_URL`) before any git/network contact. */
function envWithValidProbeConfigWithoutDatabase(): NodeJS.ProcessEnv {
  const env = envWithValidProbeConfig();
  delete env.DATABASE_URL;
  delete env.KNOWN_TEST_DATABASE_URL;
  return env;
}

function lineWithPrefix(output: string, prefix: string): string | undefined {
  return output.split(/\r?\n/u).find((entry) => entry.startsWith(prefix));
}

describe('P4A-P08 failure-detail formatter', () => {
  test('returns the COMPLETE message with the verification sub-detail (the diagnostic the stable line drops)', () => {
    const error = new Error('verification_not_converged:stored_private');
    assert.equal(
      stableProbeFailureCode(error),
      'verification_not_converged',
      'the stable classification must stay recognizable',
    );
    assert.equal(
      p08FailureDetail(error),
      'verification_not_converged:stored_private',
      'the full detail must reach the report boundary',
    );
    assert.equal(
      `${DETAIL_PREFIX}${p08FailureDetail(error)}`,
      'phase4a_p08_failure_detail:verification_not_converged:stored_private',
      'the CLI detail line must carry the whole colon tail',
    );
  });

  test('keeps every verifyToStored sub-detail intact', () => {
    const variants = [
      'verification_not_converged:claim_missing',
      'verification_not_converged:wrong_event',
      'verification_not_converged:outbox_complete',
      'verification_not_converged:stored_private',
      'verification_not_converged:verified_facts',
    ] as const;
    for (const message of variants) {
      assert.equal(
        stableProbeFailureCode(new Error(message)),
        'verification_not_converged',
        `stable code of ${message}`,
      );
      assert.equal(p08FailureDetail(new Error(message)), message, `detail of ${message}`);
    }
  });

  test('keeps every provider tail variant intact', () => {
    const variants = [
      { message: 'delivery_owner_failed:headers', stable: 'delivery_owner_failed' },
      { message: 'delivery_owner_failed:range', stable: 'delivery_owner_failed' },
      { message: 'delivery_owner_failed:416', stable: 'delivery_owner_failed' },
      { message: 'delivery_owner_failed:head', stable: 'delivery_owner_failed' },
      { message: 'delivery_owner_failed:304', stable: 'delivery_owner_failed' },
      { message: 'delivery_owner_failed:replay', stable: 'delivery_owner_failed' },
      { message: 'delivery_owner_failed:isolation', stable: 'delivery_owner_failed' },
      { message: 'probe_download_failed:admission', stable: 'probe_download_failed' },
      { message: 'probe_download_failed:readmission', stable: 'probe_download_failed' },
      { message: 'probe_download_failed:retire_admission', stable: 'probe_download_failed' },
      { message: 'probe_download_failed:browser', stable: 'probe_download_failed' },
      { message: 'admission_dto_invalid:audience', stable: 'admission_dto_invalid' },
      { message: 'admission_dto_invalid:generation', stable: 'admission_dto_invalid' },
      { message: 'r2_read_mismatch:replacement', stable: 'r2_read_mismatch' },
      { message: 'revoked_capability_served:admission', stable: 'revoked_capability_served' },
    ] as const;
    for (const { message, stable } of variants) {
      assert.equal(stableProbeFailureCode(new Error(message)), stable, `stable code of ${message}`);
      assert.equal(p08FailureDetail(new Error(message)), message, `detail of ${message}`);
    }
  });

  test('returns undefined when the message has no tail beyond the stable code (no duplicate line)', () => {
    for (const message of [
      'verification_not_converged',
      'configuration_missing',
      'probe_issue_failed',
      'source_worktree_not_clean',
      'cleanup_unconfirmed_reconcile_required',
      'zero_secret_leakage_failed',
    ]) {
      assert.equal(
        stableProbeFailureCode(new Error(message)),
        message,
        `bare ${message} stays the stable code`,
      );
      assert.equal(
        p08FailureDetail(new Error(message)),
        undefined,
        `bare ${message} must not print a duplicate detail line`,
      );
    }
  });

  test('a SHORT tail is still a tail: it is returned, never truncated', () => {
    const error = new Error('delivery_owner_failed:headers');
    assert.equal(stableProbeFailureCode(error), 'delivery_owner_failed');
    assert.equal(p08FailureDetail(error), 'delivery_owner_failed:headers');
  });

  test('non-Error throws produce no detail line while the stable line classifies probe_failed', () => {
    for (const value of ['boom', null, undefined, 42, { message: 'verification_not_converged:stored_private' }]) {
      assert.equal(stableProbeFailureCode(value), 'probe_failed', `stable code of ${String(value)}`);
      assert.equal(p08FailureDetail(value), undefined, `no detail for non-Error ${String(value)}`);
    }
  });

  test('multi-line messages are collapsed onto a single line to keep the CLI output line-oriented', () => {
    const error = new Error('verification_not_converged:stored_private\nprovider body detail');
    assert.equal(
      p08FailureDetail(error),
      'verification_not_converged:stored_private provider body detail',
      'newlines must never split the report line',
    );
  });

  test('an unknown bare code keeps the probe_failed classification while the detail still surfaces', () => {
    const error = new Error('unexpected_sdk_error:RetryableError:429');
    assert.equal(stableProbeFailureCode(error), 'probe_failed', 'unknown codes keep the stable fallback');
    assert.equal(p08FailureDetail(error), 'unexpected_sdk_error:RetryableError:429');
  });
});

describe('P4A-P08 CLI report boundary (real evidence script subprocess)', () => {
  test('missing environment fails closed with the STABLE line AND the full detail line on stderr', () => {
    const run = runCli(envWithoutP08Secrets());
    assert.equal(run.status, 1, run.stderr);
    assert.doesNotMatch(
      run.stdout,
      /"task"\s*:\s*"phase4a-p08"/u,
      'a failed run must never emit evidence JSON',
    );

    const stableLine = lineWithPrefix(run.stderr, STABLE_PREFIX);
    assert.equal(
      stableLine,
      'phase4a_p08_probe_failed:configuration_missing',
      'the machine-contract line must stay byte-identical (code only, no colon tail)',
    );

    const detailLine = lineWithPrefix(run.stderr, DETAIL_PREFIX);
    assert.equal(
      detailLine,
      'phase4a_p08_failure_detail:configuration_missing:P4A_PROBE_TARGET',
      'the report boundary must print the complete diagnostic on its own line',
    );
  }, 60_000);

  test('a missing DATABASE_URL with a valid probe configuration prints the full configuration tail', () => {
    const run = runCli(envWithValidProbeConfigWithoutDatabase());
    assert.equal(run.status, 1, run.stderr);
    assert.equal(
      lineWithPrefix(run.stderr, STABLE_PREFIX),
      'phase4a_p08_probe_failed:configuration_missing',
      'the database gate must fail closed with the stable code only',
    );
    assert.equal(
      lineWithPrefix(run.stderr, DETAIL_PREFIX),
      'phase4a_p08_failure_detail:configuration_missing:DATABASE_URL',
      'the missing-variable name must reach the report boundary',
    );
  }, 60_000);

  test('a bare-code source-binding failure prints ONLY the stable line (no duplicate detail line)', () => {
    // A TEMPORARY DIRTY GIT REPOSITORY drives the p08 CLI source binding:
    // `git rev-parse HEAD` resolves locally while `git status --porcelain` is
    // non-empty, so the run fails deterministically with the BARE code
    // `source_worktree_not_clean` (no colon tail) before any network contact,
    // regardless of the real worktree state.
    const tempDir = mkdtempSync(join(tmpdir(), 'p08-bare-code-'));
    let run: { status: number | null; stdout: string; stderr: string } | undefined;
    try {
      const git = (args: readonly string[]) =>
        spawnSync('git', [...args], { encoding: 'utf8', windowsHide: true });
      const init = git(['init', '-q', tempDir]);
      if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`);
      const identity = git(['-C', tempDir, 'config', 'user.email', 'p08-test@example.test']);
      if (identity.status !== 0) throw new Error(`git config failed: ${identity.stderr}`);
      const name = git(['-C', tempDir, 'config', 'user.name', 'p08 test']);
      if (name.status !== 0) throw new Error(`git config failed: ${name.stderr}`);
      const seed = git(['-C', tempDir, 'commit', '--allow-empty', '-q', '-m', 'seed']);
      if (seed.status !== 0) throw new Error(`git commit failed: ${seed.stderr}`);
      writeFileSync(join(tempDir, 'dirty.txt'), 'dirty');
      run = runCli({
        ...envWithValidProbeConfig(),
        GIT_DIR: join(tempDir, '.git').replaceAll('\\', '/'),
        GIT_WORK_TREE: tempDir.replaceAll('\\', '/'),
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
    assert.ok(run, 'the CLI subprocess must have run');
    assert.equal(run.status, 1, run.stderr);
    assert.equal(
      lineWithPrefix(run.stderr, STABLE_PREFIX),
      'phase4a_p08_probe_failed:source_worktree_not_clean',
      'the machine-contract line must be exactly the bare source-binding code',
    );
    assert.equal(
      lineWithPrefix(run.stderr, DETAIL_PREFIX),
      undefined,
      'no phase4a_p08_failure_detail line when the message carries no tail',
    );
  }, 120_000);

  test('stderr carries exactly one stable line and exactly one detail line', () => {
    const run = runCli(envWithoutP08Secrets());
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
      stableProbeFailureCode(new Error(lineWithPrefix(run.stderr, STABLE_PREFIX)!.slice(STABLE_PREFIX.length))),
      /^configuration_missing$/u,
      'the stable line content must round-trip through stableProbeFailureCode',
    );
  }, 60_000);
});

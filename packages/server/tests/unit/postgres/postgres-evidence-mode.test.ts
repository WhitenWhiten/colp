import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, test } from 'vitest';
import {
  configuredTestDatabaseUrl,
  isFailClosedPostgresMode,
  requireTestDatabaseUrl,
  resolvePostgresEvidenceMode,
  resolvePostgresSuiteGate,
} from '../../../scripts/postgres-evidence-mode.mjs';

const backendRoot = resolve(import.meta.dirname, '../../..');
const SAMPLE_URL = 'postgres://known:known@127.0.0.1:5432/known_test';
const CHILD_PROCESS_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = 30_000;

interface ChildResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runWithPostgres(env: NodeJS.ProcessEnv): Promise<ChildResult> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      process.execPath,
      [resolve(backendRoot, 'scripts/with-postgres.mjs'), '--', process.execPath, '-e', 'process.exit(0)'],
      {
        cwd: backendRoot,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, CHILD_PROCESS_TIMEOUT_MS);

    child.once('error', (error) => {
      clearTimeout(timeout);
      rejectRun(error);
    });
    child.once('close', (status, signal) => {
      clearTimeout(timeout);
      if (timedOut) {
        rejectRun(new Error(
          `with-postgres child exceeded ${CHILD_PROCESS_TIMEOUT_MS}ms` +
          `\nstdout=${stdout}\nstderr=${stderr}`,
        ));
        return;
      }
      resolveRun({ status, signal, stdout, stderr });
    });
  });
}

describe('PostgreSQL evidence mode selection', () => {
  test('CI=true selects acceptance even without explicit mode', () => {
    assert.equal(resolvePostgresEvidenceMode({ CI: 'true' }), 'acceptance');
    assert.equal(resolvePostgresEvidenceMode({ CI: '1' }), 'acceptance');
  });

  test('KNOWN_PG_EVIDENCE_MODE=acceptance|ci|fail-closed selects acceptance', () => {
    assert.equal(resolvePostgresEvidenceMode({ KNOWN_PG_EVIDENCE_MODE: 'acceptance' }), 'acceptance');
    assert.equal(resolvePostgresEvidenceMode({ KNOWN_PG_EVIDENCE_MODE: 'CI' }), 'acceptance');
    assert.equal(resolvePostgresEvidenceMode({ KNOWN_PG_EVIDENCE_MODE: 'fail-closed' }), 'acceptance');
  });

  test('local-opt-out aliases are explicit and not fail-closed outside CI', () => {
    for (const value of ['local-opt-out', 'skip', 'opt-out', 'LOCAL-OPT-OUT']) {
      const mode = resolvePostgresEvidenceMode({ KNOWN_PG_EVIDENCE_MODE: value });
      assert.equal(mode, 'local-opt-out', value);
      assert.equal(isFailClosedPostgresMode(mode), false);
    }
  });

  test('CI=true forces acceptance even if local-opt-out is present (no CI soft-pass)', () => {
    assert.equal(
      resolvePostgresEvidenceMode({ CI: 'true', KNOWN_PG_EVIDENCE_MODE: 'local-opt-out' }),
      'acceptance',
    );
    const gate = resolvePostgresSuiteGate({
      CI: 'true',
      KNOWN_PG_EVIDENCE_MODE: 'local-opt-out',
    });
    assert.equal(gate.action, 'fail');
  });

  test('default local mode without flags is fail-closed (not silent skip)', () => {
    const mode = resolvePostgresEvidenceMode({});
    assert.equal(mode, 'default');
    assert.equal(isFailClosedPostgresMode(mode), true);
  });

  test('unknown KNOWN_PG_EVIDENCE_MODE values are fail-closed acceptance', () => {
    assert.equal(resolvePostgresEvidenceMode({ KNOWN_PG_EVIDENCE_MODE: 'maybe' }), 'acceptance');
  });

  test('configuredTestDatabaseUrl prefers KNOWN_TEST_DATABASE_URL over DATABASE_URL', () => {
    assert.equal(
      configuredTestDatabaseUrl({
        KNOWN_TEST_DATABASE_URL: 'postgres://known/a',
        DATABASE_URL: 'postgres://known/b',
      }),
      'postgres://known/a',
    );
    assert.equal(configuredTestDatabaseUrl({ DATABASE_URL: 'postgres://known/b' }), 'postgres://known/b');
    assert.equal(configuredTestDatabaseUrl({ DATABASE_URL: '  ' }), undefined);
    assert.equal(configuredTestDatabaseUrl({}), undefined);
  });
});

describe('PostgreSQL suite gate and requireTestDatabaseUrl', () => {
  test('URL present always runs regardless of mode', () => {
    for (const mode of ['acceptance', 'local-opt-out', 'default', undefined]) {
      const env = {
        DATABASE_URL: SAMPLE_URL,
        ...(mode ? { KNOWN_PG_EVIDENCE_MODE: mode } : {}),
      };
      const gate = resolvePostgresSuiteGate(env);
      assert.equal(gate.action, 'run', mode);
      assert.equal(gate.databaseUrl, SAMPLE_URL);
      assert.match(gate.message, /run, not skip/i);
      assert.equal(requireTestDatabaseUrl(env), SAMPLE_URL);
    }
  });

  test('acceptance and default without URL fail closed (not skip)', () => {
    for (const env of [
      { CI: 'true' },
      { KNOWN_PG_EVIDENCE_MODE: 'acceptance' },
      {},
    ]) {
      const gate = resolvePostgresSuiteGate(env);
      assert.equal(gate.action, 'fail', JSON.stringify(env));
      assert.notEqual(gate.action, 'skip');
      assert.match(gate.message, /PostgreSQL evidence required/i);
      assert.throws(() => requireTestDatabaseUrl(env), /PostgreSQL evidence required|unset/i);
    }
  });

  test('local-opt-out without URL skips with explicit message', () => {
    const gate = resolvePostgresSuiteGate({ KNOWN_PG_EVIDENCE_MODE: 'local-opt-out' });
    assert.equal(gate.action, 'skip');
    assert.match(gate.message, /local-opt-out|explicit local opt-out/i);
    assert.throws(() => requireTestDatabaseUrl({ KNOWN_PG_EVIDENCE_MODE: 'local-opt-out' }), /opt-out/i);
  });
});

describe('with-postgres.mjs fail-closed propagation', () => {
  test('deliberately invalid external URL exits non-zero in acceptance mode', async () => {
    const result = await runWithPostgres({
      ...process.env,
      CI: 'true',
      KNOWN_PG_EVIDENCE_MODE: 'acceptance',
      // Unreachable port: connection probe must fail closed without soft-pass.
      DATABASE_URL: 'postgres://invalid:invalid@127.0.0.1:1/known_evidence_invalid',
      KNOWN_TEST_DATABASE_URL: 'postgres://invalid:invalid@127.0.0.1:1/known_evidence_invalid',
      // Prevent accidental inheritance of a working local URL from the parent shell.
    });

    assert.equal(result.signal, null, `unexpected signal ${result.signal}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.notEqual(result.status, 0, `expected non-zero exit, got ${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
    const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    assert.match(combined, /FAIL-CLOSED|not usable|with-postgres/i);
    assert.doesNotMatch(combined, /using external database URL \(Docker/i);
  }, TEST_TIMEOUT_MS);

  test('missing database and no container path exits non-zero under acceptance (no soft pass)', async () => {
    const env = { ...process.env } as NodeJS.ProcessEnv;
    delete env.DATABASE_URL;
    delete env.KNOWN_TEST_DATABASE_URL;
    env.CI = 'true';
    env.KNOWN_PG_EVIDENCE_MODE = 'acceptance';
    // Force a fast Testcontainers failure path when Docker is absent.
    env.DOCKER_HOST = 'tcp://127.0.0.1:1';

    const result = await runWithPostgres(env);

    assert.equal(result.signal, null, `unexpected signal ${result.signal}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.notEqual(result.status, 0, `expected non-zero exit, got ${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
    const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    assert.match(combined, /FAIL-CLOSED|failed to obtain PostgreSQL|Testcontainers/i);
  }, TEST_TIMEOUT_MS);
});

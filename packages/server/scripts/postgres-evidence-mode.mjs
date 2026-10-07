/**
 * Shared PostgreSQL evidence mode selection for CI/acceptance vs local opt-out.
 *
 * Modes:
 * - acceptance: fail closed when no database is available (CI=true or
 *   KNOWN_PG_EVIDENCE_MODE=acceptance|ci|fail-closed).
 * - local-opt-out: explicit local skip for vitest suite gating only
 *   (KNOWN_PG_EVIDENCE_MODE=local-opt-out|skip|opt-out). Never set in CI.
 * - default: local interactive without an explicit mode — still fail closed
 *   for missing PostgreSQL so silent skips cannot pass as evidence.
 *
 * scripts/with-postgres.mjs always fails closed when it cannot obtain a DB
 * (external URL or Testcontainers); local-opt-out does not soft-pass evidence runners.
 */

/**
 * @typedef {'acceptance' | 'local-opt-out' | 'default'} PostgresEvidenceMode
 * @typedef {'run' | 'skip' | 'fail'} PostgresSuiteAction
 * @typedef {{
 *   action: PostgresSuiteAction,
 *   mode: PostgresEvidenceMode,
 *   databaseUrl?: string,
 *   message: string,
 * }} PostgresSuiteGate
 */

const LOCAL_OPT_OUT_VALUES = new Set(['local-opt-out', 'skip', 'opt-out']);
const ACCEPTANCE_VALUES = new Set(['acceptance', 'ci', 'fail-closed']);

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @returns {PostgresEvidenceMode}
 */
export function resolvePostgresEvidenceMode(env = process.env) {
  const ci = env.CI === 'true' || env.CI === '1';
  // CI is always fail-closed. local-opt-out must not soft-pass required evidence in CI
  // even if accidentally present in the environment.
  if (ci) return 'acceptance';

  const raw = (env.KNOWN_PG_EVIDENCE_MODE ?? '').trim().toLowerCase();
  if (raw) {
    if (LOCAL_OPT_OUT_VALUES.has(raw)) return 'local-opt-out';
    if (ACCEPTANCE_VALUES.has(raw)) return 'acceptance';
    // Unknown explicit values are fail-closed so misconfiguration cannot soft-pass.
    return 'acceptance';
  }
  return 'default';
}

/**
 * @param {PostgresEvidenceMode} mode
 * @returns {boolean}
 */
export function isFailClosedPostgresMode(mode) {
  return mode === 'acceptance' || mode === 'default';
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @returns {string | undefined}
 */
export function configuredTestDatabaseUrl(env = process.env) {
  const known = env.KNOWN_TEST_DATABASE_URL?.trim();
  if (known) return known;
  const databaseUrl = env.DATABASE_URL?.trim();
  if (databaseUrl) return databaseUrl;
  return undefined;
}

/**
 * Decide whether a PostgreSQL vitest suite should run, skip (explicit opt-out),
 * or fail closed.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @returns {PostgresSuiteGate}
 */
export function resolvePostgresSuiteGate(env = process.env) {
  const mode = resolvePostgresEvidenceMode(env);
  const databaseUrl = configuredTestDatabaseUrl(env);

  if (databaseUrl) {
    return {
      action: 'run',
      mode,
      databaseUrl,
      message: `PostgreSQL evidence mode=${mode}; using configured database URL (run, not skip).`,
    };
  }

  if (mode === 'local-opt-out') {
    return {
      action: 'skip',
      mode,
      message:
        'KNOWN_PG_EVIDENCE_MODE=local-opt-out: PostgreSQL integration suite skipped (explicit local opt-out; not valid CI/acceptance evidence).',
    };
  }

  const modeHint =
    mode === 'acceptance'
      ? 'acceptance/CI mode'
      : 'default mode (fail-closed; set KNOWN_PG_EVIDENCE_MODE=local-opt-out only for intentional local skip)';

  return {
    action: 'fail',
    mode,
    message:
      `PostgreSQL evidence required (${modeHint}) but KNOWN_TEST_DATABASE_URL/DATABASE_URL is unset. ` +
      'Set a usable URL, run via scripts/with-postgres.mjs (external URL or Testcontainers), ' +
      'or set KNOWN_PG_EVIDENCE_MODE=local-opt-out for explicit local skip only.',
  };
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function requireTestDatabaseUrl(env = process.env) {
  const gate = resolvePostgresSuiteGate(env);
  if (gate.action === 'run' && gate.databaseUrl) return gate.databaseUrl;
  if (gate.action === 'skip') {
    throw new Error(
      `${gate.message} requireTestDatabaseUrl() cannot proceed without a database URL.`,
    );
  }
  throw new Error(gate.message);
}

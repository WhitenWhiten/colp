/**
 * Evidence runner wrapper: obtain a real PostgreSQL URL, then run a child command.
 *
 * Resolution order:
 * 1. Usable external KNOWN_TEST_DATABASE_URL or DATABASE_URL (no Docker required)
 * 2. Testcontainers PostgreSQL
 *
 * Always fail-closed when no database can be obtained or the external URL is
 * unreachable. local-opt-out never soft-passes this script (CI/evidence runners).
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import process from 'node:process';
import pg from 'pg';
import {
  configuredTestDatabaseUrl,
  resolvePostgresEvidenceMode,
} from './postgres-evidence-mode.mjs';

const separator = process.argv.indexOf('--');
const command = separator >= 0 ? process.argv[separator + 1] : undefined;
const arguments_ = separator >= 0 ? process.argv.slice(separator + 2) : [];
if (!command) throw new Error('Usage: node scripts/with-postgres.mjs -- <command> [args...]');
const wrapperArguments = separator >= 0 ? process.argv.slice(2, separator) : [];
if (wrapperArguments.some((value) => !['--isolated-owner', '--tls'].includes(value))) {
  throw new Error('Usage: node scripts/with-postgres.mjs [--tls] [--isolated-owner] -- <command> [args...]');
}
const tlsRequested = wrapperArguments.includes('--tls');
const isolatedOwner = wrapperArguments.includes('--isolated-owner');

const CONNECT_TIMEOUT_MS = 5_000;
const mode = resolvePostgresEvidenceMode();

/**
 * @param {string} connectionString
 * @returns {Promise<void>}
 */
async function verifyDatabaseUrl(connectionString) {
  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  try {
    await client.connect();
    await client.query('select 1 as ok');
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * @returns {Promise<{ uri: string, source: 'external' | 'testcontainers', stop?: () => Promise<void> }>}
 */
async function obtainPostgres() {
  if (!isolatedOwner) {
    const external = configuredTestDatabaseUrl();
    if (external) {
      try {
        await verifyDatabaseUrl(external);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `with-postgres (mode=${mode}): external DATABASE_URL/KNOWN_TEST_DATABASE_URL is set but not usable: ${detail}`,
        );
      }
      console.error(
        `[with-postgres] mode=${mode}; using external database URL (Docker/Testcontainers not required).`,
      );
      return { uri: external, source: 'external' };
    }
  }

  const image = process.env.KNOWN_POSTGRES_IMAGE ?? 'postgres:16.4-alpine';
  console.error(
    `[with-postgres] mode=${mode}; ${isolatedOwner ? 'isolated owner requested' : 'no external database URL'}; starting Testcontainers image ${image}.`,
  );

  try {
    if (isolatedOwner) process.env.TESTCONTAINERS_RYUK_DISABLED = 'true';
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const configured = new PostgreSqlContainer(image)
      .withDatabase('known_test')
      .withUsername('known')
      .withPassword('known_test_only');
    let tlsRoot;
    if (tlsRequested) {
      tlsRoot = await mkdtemp(resolve(tmpdir(), 'known-postgres-tls-'));
      const { selfSignedCertificate } = await import('./phase3-multi-device-recovery-runtime.mjs');
      const certificate = selfSignedCertificate('localhost');
      const certPath = resolve(tlsRoot, 'server.crt'); const keyPath = resolve(tlsRoot, 'server.key');
      await writeFile(certPath, certificate.cert, { mode: 0o600 }); await writeFile(keyPath, certificate.key, { mode: 0o600 });
      configured.withSSL(certPath, keyPath, certPath);
    }
    let container;
    try { container = await configured.start(); }
    catch (error) { if (tlsRoot) await rm(tlsRoot, { recursive: true, force: true }).catch(() => undefined); throw error; }
    const connection = new URL(container.getConnectionUri());
    if (tlsRequested) { connection.searchParams.set('sslmode', 'verify-full');
      connection.searchParams.set('sslrootcert', resolve(tlsRoot, 'server.crt')); }
    const uri = connection.toString();
    try {
      await verifyDatabaseUrl(uri);
    } catch (error) {
      try {
        await container.stop().catch(() => undefined);
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `with-postgres (mode=${mode}): Testcontainers started but connection probe failed: ${detail}`,
        );
      } finally {
        if (tlsRoot) await rm(tlsRoot, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    return {
      uri,
      source: 'testcontainers',
      stop: async () => {
        try { await container.stop(); } finally { if (tlsRoot) await rm(tlsRoot, { recursive: true, force: true }); }
      },
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `with-postgres (mode=${mode}): failed to obtain PostgreSQL via Testcontainers ` +
        `(Docker unavailable or misconfigured, and no external DATABASE_URL/KNOWN_TEST_DATABASE_URL). ${detail} ` +
        'CI/acceptance must fail closed; set a usable external URL or provide Docker for Testcontainers. ' +
        'Local workstations without Docker may supply DATABASE_URL or run unit tests only; ' +
        'do not treat missing Docker as a soft pass for evidence runners.',
    );
  }
}

let obtained;
try {
  obtained = await obtainPostgres();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[with-postgres] FAIL-CLOSED: ${message}`);
  process.exitCode = 1;
  process.exit(1);
}

try {
  const exitCode = await new Promise((resolveExit, reject) => {
    const child = spawn(command, arguments_, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: obtained.uri,
        KNOWN_TEST_DATABASE_URL: obtained.uri,
        // Evidence child processes always run under acceptance so vitest suites
        // cannot skip when a database was intentionally provisioned.
        KNOWN_PG_EVIDENCE_MODE: process.env.KNOWN_PG_EVIDENCE_MODE?.trim()
          ? process.env.KNOWN_PG_EVIDENCE_MODE
          : 'acceptance',
        NODE_ENV: 'test',
      },
      shell: process.platform === 'win32',
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`child process terminated by ${signal}`));
      else resolveExit(code ?? 1);
    });
  });
  if (exitCode !== 0) process.exitCode = exitCode;
} finally {
  if (obtained.stop) await obtained.stop();
}

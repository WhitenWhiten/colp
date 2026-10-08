import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { waitForCondition, withRealTimeout } from './async-test-helpers.js';

const backendRoot = resolve(import.meta.dirname, '../..');

export async function reserveTcpPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

export function startApiProcess(databaseUrl: string, port: number): ChildProcess {
  // Q1 integration glue (plan §6 G1): the spawned production composition must
  // start with a COHERENT auth mode. The legacy OIDC env is NOT required in
  // Better Auth mode, so default the BA direction when the ambient env carries
  // neither (an explicitly provided OIDC env or BETTER_AUTH_ENABLED=false
  // keeps the legacy requirements exactly as before).
  const env = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    HOST: '127.0.0.1',
    PORT: String(port),
    LOG_LEVEL: 'silent',
  };
  env.BETTER_AUTH_ENABLED ??= 'true';
  env.BETTER_AUTH_SECRET ??= 'dev-better-auth-secret-0123456789abcdef';
  // This harness spawns the production entrypoint without private EXPORT_R2_*;
  // keep library exports off like tests/support/test-config.ts.
  env.KNOWN_FEATURE_EXPORT_JOBS ??= 'false';
  return spawn(process.execPath, ['--import', 'tsx', 'src/bootstrap/api.ts'], {
    cwd: backendRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export async function waitForChildReady(
  baseUrl: string,
  child: ChildProcess,
  stderr: () => string,
  timeoutMs = 30_000,
): Promise<void> {
  let lastError: unknown;
  try {
    await waitForCondition(async () => {
      if (child.exitCode !== null) {
        throw new Error(`API child exited before readiness (exit ${child.exitCode}): ${stderr()}`);
      }
      try {
        const response = await fetch(`${baseUrl}/ready`, { signal: AbortSignal.timeout(1_000) });
        if (response.status === 200) return true;
        lastError = `ready answered ${response.status}`;
      } catch (error) {
        lastError = error;
      }
      return false;
    }, {
      timeoutMs,
      pollIntervalMs: 150,
      description: `API child readiness at ${baseUrl}`,
    });
  } catch (error) {
    throw new Error(
      `API child did not pass /ready within ${timeoutMs}ms: ${String(lastError)} ${stderr()}`,
      { cause: error },
    );
  }
}

export async function waitForHttpOk(url: string, timeoutMs = 15_000): Promise<Response> {
  let lastError: unknown;
  let successfulResponse: Response | undefined;
  try {
    await waitForCondition(async () => {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
        if (response.ok) {
          successfulResponse = response;
          return true;
        }
        lastError = new Error(`${url} returned ${response.status}`);
      } catch (error: unknown) {
        lastError = error;
      }
      return false;
    }, {
      timeoutMs,
      pollIntervalMs: 50,
      description: `an OK response from ${url}`,
    });
  } catch (error) {
    throw new Error(`runtime did not become available at ${url}`, { cause: lastError ?? error });
  }
  if (successfulResponse === undefined) {
    throw new Error(`runtime readiness at ${url} completed without a response`);
  }
  return successfulResponse;
}

export async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exitPromise = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
  try {
    await withRealTimeout(exitPromise, 5_000, 'API child did not exit after SIGTERM');
  } catch {
    child.kill('SIGKILL');
    await exitPromise;
  }
}

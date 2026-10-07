/**
 * P4A-V4A-04 focused-gate support: spawns the REAL isolated delivery process
 * (`src/bootstrap/delivery-main.ts`, or the `dist` build when present) as an
 * independent OS process and drives it exclusively through its
 * discovery/readiness protocol.
 *
 * - No fixed ports: the process binds `ATTACHMENTS_DELIVERY_PORT=0` and
 *   prints `delivery_listening <bound-origin>` to stdout; tests wait for that
 *   line, then poll the readiness route with a deadline (no wall-clock
 *   sleeps).
 * - Secrets travel ONLY through the child environment — never argv, files or
 *   artifacts — and the caller asserts the captured stdout/stderr never
 *   contains secret values.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { waitForCondition, withRealTimeout } from './async-test-helpers.js';

const backendRoot = resolve(import.meta.dirname, '../..');

export const DELIVERY_PROCESS_READINESS_PATH = '/-/ready';
export const DELIVERY_LISTENING_PREFIX = 'delivery_listening ';

export interface DeliveryProcessHandle {
  readonly child: ChildProcess;
  /** Everything the child wrote to stdout so far. */
  readonly stdout: string;
  /** Everything the child wrote to stderr so far. */
  readonly stderr: string;
  /** True once the child has exited. */
  readonly exited: boolean;
  /** True once the child and all stdio streams have closed. */
  readonly closed: boolean;
}

/**
 * Spawns the delivery process. Prefers the built `dist` artifact when present
 * (exercising exactly what `npm run start:delivery` runs); otherwise runs the
 * TypeScript source through tsx. The child environment is the parent env plus
 * the caller-provided delivery env (secrets arrive only via env).
 */
export function startDeliveryProcess(env: NodeJS.ProcessEnv): DeliveryProcessHandle {
  const built = resolve(backendRoot, 'dist/src/bootstrap/delivery-main.js');
  const args = existsSync(built)
    ? [built]
    : ['--import', 'tsx', 'src/bootstrap/delivery-main.ts'];
  const child = spawn(process.execPath, args, {
    cwd: backendRoot,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let closed = false;
  child.once('close', () => {
    closed = true;
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  return {
    child,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    get exited() {
      return child.exitCode !== null || child.signalCode !== null;
    },
    get closed() {
      return closed;
    },
  };
}

/**
 * Waits for the child's `delivery_listening <origin>` discovery line (deadline
 * poll). Throws with the captured stderr if the child exits first or the
 * deadline passes.
 */
export async function waitForDeliveryListening(
  handle: DeliveryProcessHandle,
  timeoutMs = 30_000,
): Promise<string> {
  let origin: string | undefined;
  await waitForCondition(() => {
    if (handle.exited) {
      throw new Error(
        `delivery process exited before listening (code=${handle.child.exitCode}): ${handle.stderr}`,
      );
    }
    origin = /^delivery_listening (\S+)$/mu.exec(handle.stdout)?.[1];
    return origin !== undefined;
  }, {
    timeoutMs,
    pollIntervalMs: 50,
    description: 'the delivery process listening discovery line',
  });
  if (origin === undefined) {
    throw new Error(`delivery process did not report listening within ${timeoutMs}ms; stderr: ${handle.stderr}`);
  }
  return origin;
}

/**
 * Polls the readiness route until it returns 200 (deadline poll; never a
 * fixed sleep). The readiness route never exposes capability material.
 */
export async function waitForDeliveryReadiness(url: string, timeoutMs = 15_000): Promise<void> {
  let lastError: unknown;
  try {
    await waitForCondition(async () => {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
        if (response.status === 200) return true;
        lastError = new Error(`readiness returned ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      return false;
    }, {
      timeoutMs,
      pollIntervalMs: 50,
      description: `delivery readiness at ${url}`,
    });
  } catch (error) {
    throw new Error(`delivery readiness did not become ready at ${url}`, { cause: lastError ?? error });
  }
}

/**
 * Waits for the child to exit (deadline; SIGKILL on timeout and fail the
 * caller). Returns the exit code, or null when the child was killed by a
 * signal.
 */
export async function waitForDeliveryExit(handle: DeliveryProcessHandle, timeoutMs = 20_000): Promise<number | null> {
  if (handle.closed) return handle.child.exitCode;
  const exitPromise = new Promise<number | null>((resolveExit) => {
    handle.child.once('close', (code) => resolveExit(code));
  });
  try {
    return await withRealTimeout(
      exitPromise,
      timeoutMs,
      `delivery process did not exit within ${timeoutMs}ms; stderr: ${handle.stderr}`,
    );
  } catch (error) {
    handle.child.kill('SIGKILL');
    await exitPromise.catch(() => undefined);
    throw error;
  }
}

/**
 * Sends SIGTERM (default) and waits for the child to exit. Returns the exit
 * code so the caller can assert the graceful-drain contract (0).
 */
export async function stopDeliveryProcess(
  handle: DeliveryProcessHandle,
  options: { readonly signal?: NodeJS.Signals; readonly timeoutMs?: number } = {},
): Promise<number | null> {
  if (!handle.exited) handle.child.kill(options.signal ?? 'SIGTERM');
  return waitForDeliveryExit(handle, options.timeoutMs ?? 20_000);
}

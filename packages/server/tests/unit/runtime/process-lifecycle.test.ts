import assert from 'node:assert/strict';
import { afterEach, describe, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  registerGracefulShutdown,
  registerFatalProcessHandlers,
  DEFAULT_GRACEFUL_SHUTDOWN_DEADLINE_MS,
  type SignalSource,
  type FatalEventSource,
} from '../../../src/bootstrap/process-lifecycle.js';

class FakeProcess extends EventEmitter implements SignalSource {
  exitCode: number | undefined;
}

class FakeFatalSource implements FatalEventSource {
  rejection: ((reason: unknown) => void) | undefined;
  exception: ((error: Error) => void) | undefined;
  onUnhandledRejection(listener: (reason: unknown) => void): void { this.rejection = listener; }
  offUnhandledRejection(listener: (reason: unknown) => void): void {
    if (this.rejection === listener) this.rejection = undefined;
  }
  onUncaughtException(listener: (error: Error) => void): void { this.exception = listener; }
  offUncaughtException(listener: (error: Error) => void): void {
    if (this.exception === listener) this.exception = undefined;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

test('SIGTERM and SIGINT drain a runtime exactly once and remove signal listeners', async () => {
  const source = new FakeProcess();
  let stops = 0;
  let stopped: (() => void) | undefined;
  const stoppedPromise = new Promise<void>((resolve) => { stopped = resolve; });
  registerGracefulShutdown({
    async stop() { stops += 1; stopped?.(); },
  }, { source });

  source.emit('SIGTERM');
  source.emit('SIGINT');
  await stoppedPromise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stops, 1);
  assert.equal(source.listenerCount('SIGTERM'), 0);
  assert.equal(source.listenerCount('SIGINT'), 0);
});

test('shutdown failures set a non-zero exit code and redact the reported error', async () => {
  const source = new FakeProcess();
  let reported = '';
  registerGracefulShutdown({
    async stop() { throw new Error('Authorization: Bearer shutdown-secret'); },
  }, { source, onError: (error) => { reported = error; } });

  source.emit('SIGTERM');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(source.exitCode, 1);
  assert.doesNotMatch(reported, /shutdown-secret/);
  assert.match(reported, /\[REDACTED\]/);
});

test('refuses a non-positive shutdown deadline at registration', () => {
  assert.throws(
    () => registerGracefulShutdown({ async stop() {} }, { deadlineMs: 0 }),
    /shutdown deadline/,
  );
});

test('shutdown deadline force-exits when stop never settles', async () => {
  vi.useFakeTimers();
  const source = new FakeProcess();
  let exited: number | undefined;
  let reported = '';
  let releaseStop!: () => void;
  const hanging = new Promise<void>((resolve) => { releaseStop = resolve; });
  registerGracefulShutdown({
    stop: () => hanging,
  }, {
    source,
    deadlineMs: 25,
    onError: (error) => { reported = error; },
    exit: (code) => { exited = code; },
  });
  source.emit('SIGTERM');
  await Promise.resolve();
  assert.equal(exited, undefined);
  await vi.advanceTimersByTimeAsync(25);
  assert.equal(exited, 1);
  assert.equal(source.exitCode, 1);
  assert.match(reported, /shutdown deadline exceeded/i);
  assert.equal(DEFAULT_GRACEFUL_SHUTDOWN_DEADLINE_MS, 45_000);
  releaseStop();
});

test('shutdown deadline does not exit when stop settles first', async () => {
  vi.useFakeTimers();
  const source = new FakeProcess();
  let exited: number | undefined;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  registerGracefulShutdown({
    stop: () => held,
  }, {
    source,
    deadlineMs: 1_000,
    exit: (code) => { exited = code; },
  });
  source.emit('SIGTERM');
  await Promise.resolve();
  release();
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(1_000);
  assert.equal(exited, undefined);
  assert.equal(source.exitCode, undefined);
});

describe('fatal process handlers', () => {
  test('redacts and structurally logs an unhandled rejection before exiting', () => {
    const source = new FakeFatalSource();
    const records: Array<{ bindings: Record<string, unknown>; message: string }> = [];
    let exitCode: number | undefined;
    let forcedExit: number | undefined;
    const remove = registerFatalProcessHandlers({
      source,
      logger: { fatal(bindings, message) { records.push({ bindings, message }); } },
      setExitCode: (code) => { exitCode = code; },
      exit: (code) => { forcedExit = code; },
    });

    source.rejection?.(new Error('Authorization: Bearer rejected-secret'));

    assert.equal(exitCode, 1);
    assert.equal(forcedExit, 1);
    assert.equal(records.length, 1);
    assert.deepEqual(records[0]?.bindings.event, 'unhandled_rejection');
    assert.doesNotMatch(String(records[0]?.bindings.error), /rejected-secret/u);
    assert.match(String(records[0]?.bindings.error), /\[REDACTED\]/u);

    source.exception?.(new Error('second failure is ignored'));
    assert.equal(records.length, 1);
    remove();
    assert.equal(source.rejection, undefined);
    assert.equal(source.exception, undefined);
  });

  test('logs uncaught exceptions with the same fail-fast policy', () => {
    const source = new FakeFatalSource();
    let event: unknown;
    registerFatalProcessHandlers({
      source,
      logger: { fatal(bindings) { event = bindings.event; } },
      setExitCode: () => undefined,
      exit: () => undefined,
    });

    source.exception?.(new Error('boom'));

    assert.equal(event, 'uncaught_exception');
  });
});

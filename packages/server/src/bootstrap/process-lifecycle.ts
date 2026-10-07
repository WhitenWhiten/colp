import { redactSensitiveText } from '../infrastructure/telemetry/index.js';

export const DEFAULT_GRACEFUL_SHUTDOWN_DEADLINE_MS = 45_000;

export interface StoppableRuntime {
  stop(): Promise<void>;
}

export interface SignalSource {
  exitCode?: number;
  once(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
}

export interface GracefulShutdownOptions {
  readonly signals?: readonly NodeJS.Signals[];
  readonly source?: SignalSource;
  readonly onError?: (error: string) => void;
  /**
   * Hard ceiling for runtime.stop(). When exceeded, onError fires and exit(1)
   * runs so SIGTERM / rolling deploys cannot hang on abort-ignoring work.
   */
  readonly deadlineMs?: number;
  /** Test seam; production defaults to process.exit. */
  readonly exit?: (code: number) => void;
}

export interface FatalProcessLogger {
  fatal(bindings: Record<string, unknown>, message: string): void;
}

export interface FatalEventSource {
  onUnhandledRejection(listener: (reason: unknown) => void): void;
  offUnhandledRejection(listener: (reason: unknown) => void): void;
  onUncaughtException(listener: (error: Error) => void): void;
  offUncaughtException(listener: (error: Error) => void): void;
}

export interface FatalProcessHandlerOptions {
  readonly logger: FatalProcessLogger;
  readonly source?: FatalEventSource;
  readonly setExitCode?: (code: number) => void;
  readonly exit?: (code: number) => void;
}

/** Installs fail-fast structured fallbacks for errors that escape every task boundary. */
export function registerFatalProcessHandlers(options: FatalProcessHandlerOptions): () => void {
  const source = options.source ?? nodeFatalEventSource;
  const setExitCode = options.setExitCode ?? ((code: number) => { process.exitCode = code; });
  const exit = options.exit ?? process.exit.bind(process);
  let handled = false;

  const handle = (event: 'unhandled_rejection' | 'uncaught_exception', error: unknown): void => {
    if (handled) return;
    handled = true;
    setExitCode(1);
    try {
      reportFatalProcessError(options.logger, event, error);
    } finally {
      exit(1);
    }
  };
  const onUnhandledRejection = (reason: unknown): void => handle('unhandled_rejection', reason);
  const onUncaughtException = (error: Error): void => handle('uncaught_exception', error);
  source.onUnhandledRejection(onUnhandledRejection);
  source.onUncaughtException(onUncaughtException);

  return () => {
    source.offUnhandledRejection(onUnhandledRejection);
    source.offUncaughtException(onUncaughtException);
  };
}

export function reportFatalProcessError(
  logger: FatalProcessLogger,
  event: 'startup_failure' | 'unhandled_rejection' | 'uncaught_exception',
  error: unknown,
): void {
  logger.fatal({ event, error: redactSensitiveText(error) }, 'fatal process error');
}

const nodeFatalEventSource: FatalEventSource = {
  onUnhandledRejection(listener) { process.on('unhandledRejection', listener); },
  offUnhandledRejection(listener) { process.off('unhandledRejection', listener); },
  onUncaughtException(listener) { process.on('uncaughtException', listener); },
  offUncaughtException(listener) { process.off('uncaughtException', listener); },
};

export function registerGracefulShutdown(
  runtime: StoppableRuntime,
  options: GracefulShutdownOptions = {},
): () => void {
  if (
    options.deadlineMs !== undefined
    && (!Number.isSafeInteger(options.deadlineMs) || options.deadlineMs < 1)
  ) {
    throw new RangeError('shutdown deadline must be a positive safe integer');
  }
  const source = options.source ?? process;
  const signals = options.signals ?? ['SIGTERM', 'SIGINT'];
  let shutdown: Promise<void> | undefined;

  const remove = (): void => {
    for (const signal of signals) source.off(signal, listener);
  };
  const listener = (): void => {
    shutdown ??= (async () => {
      const stop = runtime.stop().catch((error: unknown) => {
        source.exitCode = 1;
        options.onError?.(redactSensitiveText(error));
      });
      if (options.deadlineMs === undefined) {
        await stop;
        remove();
        return;
      }
      let expired = false;
      const deadline = new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          expired = true;
          resolve();
        }, options.deadlineMs);
        timer.unref?.();
        void stop.finally(() => clearTimeout(timer));
      });
      await Promise.race([stop, deadline]);
      if (expired) {
        source.exitCode = 1;
        options.onError?.(redactSensitiveText(new Error('shutdown deadline exceeded')));
        (options.exit ?? process.exit.bind(process))(1);
      }
      remove();
    })();
  };
  for (const signal of signals) source.once(signal, listener);
  return remove;
}

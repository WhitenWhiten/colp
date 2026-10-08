export interface McpListenIdleTimer {
  readonly refresh: () => void;
  readonly clear: () => void;
}

export function createMcpListenIdleTimer(timeoutMs: number, onTimeout: () => void): McpListenIdleTimer {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = (): void => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  };
  const refresh = (): void => {
    clear();
    timer = setTimeout(() => {
      timer = undefined;
      onTimeout();
    }, timeoutMs);
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
  };
  return Object.freeze({ refresh, clear });
}

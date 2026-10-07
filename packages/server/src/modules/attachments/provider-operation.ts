/** One deadline covers provider headers, body and retries; callers own disposal. */
export function createAttachmentProviderScope(parent: AbortSignal | undefined, timeoutMs: number) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new RangeError('Invalid attachment provider deadline');
  const controller = new AbortController();
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(new DOMException('Attachment provider deadline exceeded', 'TimeoutError')), timeoutMs);
  timer.unref();
  return {
    signal,
    close() { clearTimeout(timer); },
    run<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
      if (signal.aborted) return Promise.reject(signal.reason);
      return new Promise<T>((resolve, reject) => {
        const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(signal.reason); };
        signal.addEventListener('abort', onAbort, { once: true });
        // Observe late settlements after cancellation; no stale result is published.
        void Promise.resolve().then(() => { signal.throwIfAborted(); return work(signal); }).then(
          value => { signal.removeEventListener('abort', onAbort); resolve(value); },
          error => { signal.removeEventListener('abort', onAbort); reject(error); },
        );
      });
    },
  };
}

export type AttachmentProviderScope = ReturnType<typeof createAttachmentProviderScope>;

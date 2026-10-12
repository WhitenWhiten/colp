/** Coalesces reads only. Durable writes must never pass through this queue. */
export function createScopedRefresh<K>(options: {
  refresh(key: K): Promise<void>
  canRun(key: K): boolean
  retryAfter?(error: unknown): number | null
  onError?(error: unknown): void
  debounceMs?: number
  maxWaitMs?: number
}) {
  type Entry = { first: number; last: number; dirty: boolean; running: boolean; retryAt: number; failures: number }
  const entries = new Map<K, Entry>()
  let timer: ReturnType<typeof setTimeout> | undefined, disposed = false
  function schedule() {
    clearTimeout(timer); timer = undefined
    if (disposed) return
    let deadline = Infinity
    for (const [key, value] of entries) if (value.dirty && !value.running && options.canRun(key)) {
      deadline = Math.min(deadline, Math.max(value.retryAt,
        Math.min(value.last + (options.debounceMs ?? 150), value.first + (options.maxWaitMs ?? 1000))))
    }
    if (Number.isFinite(deadline)) timer = setTimeout(flush, Math.max(0, deadline - Date.now()))
  }
  function flush() {
    const now = Date.now()
    for (const [key, value] of entries) {
      if (!value.dirty || value.running || !options.canRun(key) || now < value.retryAt
        || now < Math.min(value.last + (options.debounceMs ?? 150), value.first + (options.maxWaitMs ?? 1000))) continue
      value.dirty = false; value.running = true
      void options.refresh(key).then(() => { value.failures = 0 }, error => {
        options.onError?.(error)
        const retry = options.retryAfter?.(error)
        if (retry === null) return
        value.dirty = true; value.first = value.last = Date.now()
        value.retryAt = Date.now() + Math.max(retry ?? 0, Math.min(30000, 1000 * 2 ** Math.min(value.failures++, 5)))
      }).finally(() => {
        value.running = false
        if (entries.get(key) === value && !value.dirty) entries.delete(key)
        schedule()
      })
    }
    schedule()
  }
  return {
    invalidate(key: K) {
      if (disposed) return
      const now = Date.now(), value = entries.get(key)
      if (value) { if (!value.dirty) value.first = now; value.last = now; value.dirty = true }
      else entries.set(key, { first: now, last: now, dirty: true, running: false, retryAt: 0, failures: 0 })
      schedule()
    },
    wake: schedule,
    reset() { entries.clear(); clearTimeout(timer); timer = undefined },
    dispose() { disposed = true; entries.clear(); clearTimeout(timer) },
  }
}

/** Temporary, read-only real-browser instrumentation. This file is not shipped
 * in the extension. The install function is self-contained for Worker/Page.evaluate. */
export function installChromeThroughputProfiler() {
  type Counter = { calls: number; completed: number; failed: number; pending: number;
    totalMs: number; maximumMs: number; synchronousMs: number; histogram: number[] };
  type Entry = { atMs: number; kind: string; action: string; durationMs?: number; status?: number; delayMs?: number };
  type Window = { startMs: number; calls: Record<string, number>; totalMs: Record<string, number> };
  const holder = globalThis as typeof globalThis & { __knownChromeThroughputProfiler?: {
    read(): unknown; stop(): unknown;
  } };
  if (holder.__knownChromeThroughputProfiler) return { installed: false, reason: 'already_installed' };
  const start = performance.now();
  const limits = [1, 2, 5, 10, 20, 50, 100, 250, 500, 1_000, 5_000];
  const metrics = new Map<string, Counter>();
  const windows = new Map<number, Window>();
  const timeline: Entry[] = [];
  const idbRequestCounts: Record<string, number> = {};
  const installed: string[] = [], unavailable: string[] = [];
  const restore: Array<() => void> = [];
  let droppedTimeline = 0;
  let stoppedAt: number | undefined;
  const elapsed = () => performance.now() - start;
  const recordEvent = (entry: Entry) => {
    if (timeline.length >= 512) { timeline.splice(384, 1); droppedTimeline++; }
    timeline.push(entry);
  };
  const windowFor = (at: number) => {
    const index = Math.floor(at / 5_000);
    let window = windows.get(index);
    if (!window) { window = { startMs: index * 5_000, calls: {}, totalMs: {} }; windows.set(index, window); }
    return window;
  };
  function begin(label: string, category: string, at: number, synchronousMs: number) {
    if (!metrics.has(label) && metrics.size >= 512) label = `${category}:other`;
    let counter = metrics.get(label);
    if (!counter) {
      counter = { calls: 0, completed: 0, failed: 0, pending: 0, totalMs: 0,
        maximumMs: 0, synchronousMs: 0, histogram: Array(limits.length + 1).fill(0) };
      metrics.set(label, counter);
    }
    counter.calls++; counter.pending++; counter.synchronousMs += synchronousMs;
    const window = windowFor(at); window.calls[category] = (window.calls[category] ?? 0) + 1;
    let completed = false;
    return (failed: boolean) => {
      if (completed) return 0;
      completed = true;
      const duration = Math.max(0, elapsed() - at);
      counter!.completed++; counter!.pending--; counter!.failed += Number(failed);
      counter!.totalMs += duration; counter!.maximumMs = Math.max(counter!.maximumMs, duration);
      const bucket = limits.findIndex(limit => duration <= limit);
      counter!.histogram[bucket < 0 ? limits.length : bucket]!++;
      window.totalMs[category] = (window.totalMs[category] ?? 0) + duration;
      return duration;
    };
  }
  function replace(target: object, name: string, replacement: unknown, label: string) {
    const current = Reflect.get(target, name);
    try {
      if (!Reflect.set(target, name, replacement) || Reflect.get(target, name) !== replacement) {
        unavailable.push(label); return;
      }
      installed.push(label);
      restore.push(() => { if (Reflect.get(target, name) === replacement) Reflect.set(target, name, current); });
    } catch { unavailable.push(label); }
  }
  function observe(target: object | undefined, name: string, label: string, category: string,
    extra?: (args: unknown[], value: unknown, failed: boolean, at: number, duration: number) => void) {
    if (!target || typeof Reflect.get(target, name) !== 'function') { unavailable.push(label); return; }
    const original = Reflect.get(target, name) as (...args: unknown[]) => unknown;
    replace(target, name, function (this: unknown, ...args: unknown[]) {
      const at = elapsed();
      let result: unknown;
      try { result = Reflect.apply(original, this, args); }
      catch (error) {
        const finish = begin(label, category, at, elapsed() - at);
        const duration = finish(true);
        try { extra?.(args, undefined, true, at, duration); } catch { /* observation never replaces the original error */ }
        throw error;
      }
      const finish = begin(label, category, at, elapsed() - at);
      const settled = (value: unknown, failed: boolean) => {
        try { const duration = finish(failed); extra?.(args, value, failed, at, duration); }
        catch { /* observation never changes the consumer's result */ }
      };
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        // Return the ORIGINAL promise. The observer neither awaits it nor
        // substitutes a new promise, rejection, callback, or return value.
        void (result as Promise<unknown>).then(value => settled(value, false), () => settled(undefined, true));
      } else settled(result, false);
      return result;
    }, label);
  }
  const browser = typeof chrome === 'undefined' ? undefined : chrome;
  for (const area of ['local', 'session', 'sync', 'managed'] as const) for (const method of ['get', 'set', 'remove', 'clear', 'getBytesInUse']) {
    const target = browser?.storage ? Reflect.get(browser.storage, area) as object | undefined : undefined;
    observe(target, method, `storage.${area}.${method}`, 'storage');
  }
  for (const method of ['contains', 'request', 'remove', 'getAll']) {
    observe(browser?.permissions, method, `permissions.${method}`, 'permissions');
  }
  for (const method of ['get', 'getChildren', 'getTree', 'getSubTree', 'getRecent', 'search',
    'create', 'update', 'move', 'remove', 'removeTree']) {
    observe(browser?.bookmarks, method, `bookmarks.${method}`, 'native');
  }
  for (const method of ['get', 'create', 'clear', 'getAll']) {
    observe(browser?.alarms, method, `alarms.${method}`, 'alarms', (args, _value, failed, at, duration) => {
      if (method !== 'create') return;
      const info = args[1] as { when?: unknown; delayInMinutes?: unknown } | undefined;
      const delay = typeof info?.when === 'number' ? info.when - Date.now()
        : typeof info?.delayInMinutes === 'number' ? info.delayInMinutes * 60_000 : undefined;
      recordEvent({ atMs: at, kind: 'alarm', action: failed ? 'create_failed' : 'create', durationMs: duration,
        ...(delay === undefined ? {} : { delayMs: delay }) });
    });
  }
  if (browser?.alarms?.onAlarm) {
    const event = browser.alarms.onAlarm;
    const removeListener = Reflect.get(event, 'removeListener') as ((listener: () => void) => void) | undefined;
    const listener = () => recordEvent({ atMs: elapsed(), kind: 'alarm', action: 'delivered' });
    if (typeof removeListener === 'function') {
      event.addListener(listener);
      restore.push(() => Reflect.apply(removeListener, event, [listener]));
      installed.push('alarms.onAlarm');
    } else unavailable.push('alarms.onAlarm');
  }
  const httpKind = (input: unknown) => {
    try {
      const url = typeof input === 'string' || input instanceof URL ? String(input)
        : typeof (input as Request | undefined)?.url === 'string' ? (input as Request).url : '';
      const path = new URL(url, 'https://profiler.invalid').pathname.toLowerCase();
      for (const kind of ['push', 'pull', 'ack', 'snapshot', 'sessions', 'session', 'retire',
        'manifest', 'replica-health', 'favicon', 'classification', 'metadata']) {
        if (path.split('/').some(part => part === kind || part === `${kind}.json`)) return kind;
      }
      return 'other';
    } catch { return 'other'; }
  };
  const originalFetch = globalThis.fetch;
  if (typeof originalFetch === 'function') {
    replace(globalThis, 'fetch', function (this: unknown, ...args: Parameters<typeof fetch>) {
      const at = elapsed();
      let result: ReturnType<typeof fetch>;
      try { result = Reflect.apply(originalFetch, this, args); }
      catch (error) { begin(`http.${httpKind(args[0])}`, 'http', at, elapsed() - at)(true); throw error; }
      const kind = httpKind(args[0]);
      const finish = begin(`http.${kind}`, 'http', at, elapsed() - at);
      recordEvent({ atMs: at, kind: 'http', action: `${kind}_started` });
      void result.then(response => {
        const duration = finish(false);
        recordEvent({ atMs: elapsed(), kind: 'http', action: `${kind}_completed`, durationMs: duration,
          status: response.status });
      }, () => {
        const duration = finish(true);
        recordEvent({ atMs: elapsed(), kind: 'http', action: `${kind}_failed`, durationMs: duration });
      });
      return result;
    }, 'fetch');
  }
  if (typeof IDBDatabase !== 'undefined') {
    const original = IDBDatabase.prototype.transaction;
    replace(IDBDatabase.prototype, 'transaction', function (this: IDBDatabase, ...args: Parameters<typeof original>) {
      const at = elapsed();
      const transaction = Reflect.apply(original, this, args) as IDBTransaction;
      const stores = Array.from(transaction.objectStoreNames).sort().join(',');
      const finish = begin(`idb.${transaction.mode}:${stores}`, 'idb', at, elapsed() - at);
      transaction.addEventListener('complete', () => { finish(false); }, { once: true });
      transaction.addEventListener('abort', () => { finish(true); }, { once: true });
      return transaction;
    }, 'IDBDatabase.transaction');
  }
  // Count requests without observing their arguments, keys or returned records.
  // Keep the native request/cursor return value and exception behavior intact.
  const idbSources = [
    ...(typeof IDBObjectStore === 'undefined' ? [] : [IDBObjectStore.prototype]),
    ...(typeof IDBIndex === 'undefined' ? [] : [IDBIndex.prototype]),
  ];
  const sourceName = (source: IDBObjectStore | IDBIndex) =>
    typeof IDBIndex !== 'undefined' && source instanceof IDBIndex
      ? `${source.objectStore.name}/index:${source.name}` : source.name;
  for (const target of idbSources) for (const method of [
    'get', 'getKey', 'getAll', 'getAllKeys', 'count', 'openCursor', 'openKeyCursor',
  ]) {
    const original = Reflect.get(target, method);
    if (typeof original !== 'function') continue;
    replace(target, method, function (this: IDBObjectStore | IDBIndex, ...args: unknown[]) {
      const result: unknown = Reflect.apply(original, this, args);
      try {
        const label = `${sourceName(this)}.${method}`;
        idbRequestCounts[label] = (idbRequestCounts[label] ?? 0) + 1;
      } catch { /* observation never changes the native result */ }
      return result;
    }, `IDB.${target === IDBObjectStore.prototype ? 'store' : 'index'}.${method}:count`);
  }
  if (typeof IDBCursor !== 'undefined') for (const method of ['advance', 'continue', 'continuePrimaryKey']) {
    const original = Reflect.get(IDBCursor.prototype, method);
    if (typeof original !== 'function') continue;
    replace(IDBCursor.prototype, method, function (this: IDBCursor, ...args: unknown[]) {
      const result: unknown = Reflect.apply(original, this, args);
      try {
        const label = `${sourceName(this.source)}.cursor.${method}`;
        idbRequestCounts[label] = (idbRequestCounts[label] ?? 0) + 1;
      } catch { /* observation never changes the native result */ }
      return result;
    }, `IDBCursor.${method}:count`);
  }
  if (typeof IDBObjectStore !== 'undefined') {
    const original = IDBObjectStore.prototype.put;
    const phases = new Set(['idle', 'session', 'bootstrap', 'pulling', 'applying', 'acking', 'pushing',
      'sleeping', 'offline', 'recovery', 'retired', 'error']);
    const bootstrapPhases = new Set(['draft', 'confirmed', 'scanning', 'matching', 'syncing', 'needs_attention', 'completed']);
    let lastPhase: string | undefined, lastBootstrapPhase: string | undefined;
    replace(IDBObjectStore.prototype, 'put', function (this: IDBObjectStore, ...args: Parameters<typeof original>) {
      const result = Reflect.apply(original, this, args) as IDBRequest<IDBValidKey>;
      if (this.name === 'sync_engine') {
        const phase = (args[0] as { phase?: unknown } | undefined)?.phase;
        if (typeof phase === 'string' && phases.has(phase) && phase !== lastPhase) {
          lastPhase = phase;
          // An attempted phase write is a timing marker, not a durable commit
          // or proof of completion. No record field other than this enum leaves.
          recordEvent({ atMs: elapsed(), kind: 'engine_phase_write', action: phase });
        }
      }
      if (this.name === 'bootstrap_runs') {
        const phase = (args[0] as { phase?: unknown } | undefined)?.phase;
        if (typeof phase === 'string' && bootstrapPhases.has(phase) && phase !== lastBootstrapPhase) {
          lastBootstrapPhase = phase;
          recordEvent({ atMs: elapsed(), kind: 'bootstrap_phase_write', action: phase });
        }
      }
      return result;
    }, 'IDBObjectStore.put:phase_observer');
  }
  function read() {
    return { version: 2, elapsedMs: stoppedAt ?? elapsed(), histogramUpperBoundsMs: limits,
      idbRequestCounts: { ...idbRequestCounts },
      metrics: Object.fromEntries([...metrics].map(([key, value]) => [key, { ...value, histogram: [...value.histogram] }])),
      windows: [...windows.values()].map(value => ({ ...value, calls: { ...value.calls }, totalMs: { ...value.totalMs } })),
      timeline: timeline.map(value => ({ ...value })), droppedTimeline, installed: [...installed], unavailable: [...unavailable],
      limitations: ['durations are inclusive and can overlap; never sum categories as elapsed time',
        'only calls made in this JavaScript realm after installation are measured',
        'pending calls at collection are not classified as success or failure',
        'engine and bootstrap phase markers observe existing put calls, not committed transactions',
        'request counts contain only store/index/method names, never arguments or results',
        'when the timeline overflows it retains the first 384 and latest 128 entries'] };
  }
  holder.__knownChromeThroughputProfiler = { read, stop() {
    stoppedAt ??= elapsed();
    for (const undo of restore.reverse()) undo();
    return read();
  } };
  return { installed: true, methods: installed.length, unavailable };
}

export function readChromeThroughputProfiler(stop = false) {
  const holder = globalThis as typeof globalThis & { __knownChromeThroughputProfiler?: { read(): unknown; stop(): unknown } };
  return holder.__knownChromeThroughputProfiler?.[stop ? 'stop' : 'read']() ?? { unavailable: 'realm_restarted_or_not_installed' };
}

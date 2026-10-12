export interface Kns09Locator { readonly collectionHash: string; readonly replicaHash: string; }

export const KNS09_METRICS_STORAGE_KEY = 'known.kns09.metrics.v1';
const RING_CAP = 32;
const HISTOGRAM_BOUNDS = Object.freeze([50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000]);

export interface Kns09Histogram {
  readonly bounds: readonly number[];
  readonly counts: readonly number[];
  readonly unknown: number;
}

interface DurableMetrics {
  counters: Record<string, number>;
  histograms: Record<string, { counts: number[]; unknown: number }>;
  firstRunKeys: Record<string, string>;
  ring: Array<{ readonly at: number; readonly kind: string }>;
  locators: Record<string, Kns09Locator>;
}

const memory: DurableMetrics = emptyMetrics();
let hydration: Promise<void> | undefined;
let writes = Promise.resolve();
let hydrated = false;
let epoch = 0;
const pendingOutcomes: Array<{ key: string; outcome: string }> = [];

function emptyMetrics(): DurableMetrics {
  return { counters: {}, histograms: {}, firstRunKeys: {}, ring: [], locators: {} };
}

export function resetKns09DurableMetricsForTests(): void {
  Object.assign(memory, emptyMetrics());
  hydration = undefined; hydrated = false; epoch++; pendingOutcomes.length = 0;
}

export function snapshotKns09DurableMetrics(): {
  readonly counters: Readonly<Record<string, number>>;
  readonly histograms: Readonly<Record<string, Kns09Histogram>>;
  readonly locators: readonly Kns09Locator[];
  readonly ringLength: number;
} {
  return {
    counters: { ...memory.counters },
    histograms: Object.fromEntries(Object.entries(memory.histograms).map(([name, row]) => [name, {
      bounds: HISTOGRAM_BOUNDS, counts: [...row.counts], unknown: row.unknown,
    }])),
    locators: Object.values(memory.locators),
    ringLength: memory.ring.length,
  };
}

export function incrementCounter(name: string, value = 1): void {
  memory.counters[name] = (memory.counters[name] ?? 0) + value;
}

export function clearCounter(name: string): void {
  delete memory.counters[name];
}

export function observeDuration(name: string, value: number | null): void {
  const row = memory.histograms[name] ?? { counts: HISTOGRAM_BOUNDS.map(() => 0).concat([0]), unknown: 0 };
  if (value === null || !Number.isFinite(value) || value < 0) {
    row.unknown += 1;
  } else {
    let index = HISTOGRAM_BOUNDS.findIndex((bound) => value <= bound);
    if (index < 0) index = HISTOGRAM_BOUNDS.length;
    row.counts[index] = (row.counts[index] ?? 0) + 1;
  }
  memory.histograms[name] = row;
}

export function rememberFirstRunOutcome(key: string, outcome: string): boolean {
  const prior = memory.firstRunKeys[key];
  if (prior === outcome) return false;
  if (outcome === 'started' && prior) return false;
  if (!hydrated) pendingOutcomes.push({ key, outcome });
  memory.firstRunKeys[key] = outcome;
  trimKeys(memory.firstRunKeys, 512);
  return true;
}

export function pushDiagnosis(kind: string): void {
  memory.ring.push({ at: Date.now(), kind });
  if (memory.ring.length > RING_CAP) memory.ring.splice(0, memory.ring.length - RING_CAP);
}

export function putLocator(locator: Kns09Locator): void {
  memory.locators[`${locator.collectionHash}:${locator.replicaHash}`] = locator;
  trimKeys(memory.locators, 128);
}

export function persistKns09Metrics(): Promise<void> {
  const currentEpoch = epoch;
  writes = writes.catch(() => undefined).then(async () => {
    await restoreKns09Metrics();
    if (currentEpoch !== epoch) return;
    try { await chrome.storage.local.set({ [KNS09_METRICS_STORAGE_KEY]: structuredClone(memory) }); }
    catch { /* No Chrome storage in unit tests; keep the in-memory snapshot. */ }
  });
  return writes;
}

export function restoreKns09Metrics(): Promise<void> {
  if (hydration) return hydration;
  const currentEpoch = epoch;
  hydration = (async () => {
    let row: DurableMetrics | undefined;
    try { row = (await chrome.storage.local.get(KNS09_METRICS_STORAGE_KEY))[KNS09_METRICS_STORAGE_KEY] as DurableMetrics; }
    catch { /* Missing Chrome keeps in-memory collection available. */ }
    if (currentEpoch !== epoch) return;
    if (row && typeof row === 'object') {
      for (const [name, count] of Object.entries(row.counters ?? {})) {
        if (Number.isFinite(count)) memory.counters[name] = (memory.counters[name] ?? 0) + count;
      }
      for (const [name, prior] of Object.entries(row.histograms ?? {})) {
        const delta = memory.histograms[name];
        memory.histograms[name] = { counts: prior.counts.map((count, i) => count + (delta?.counts[i] ?? 0)),
          unknown: prior.unknown + (delta?.unknown ?? 0) };
      }
      const outcomes = { ...(row.firstRunKeys ?? {}) };
      for (const { key, outcome } of pendingOutcomes) {
        if (outcomes[key] === outcome || outcome === 'started' && outcomes[key]) {
          const name = `kns09.first_run_total.${outcome}`;
          memory.counters[name] = Math.max(0, (memory.counters[name] ?? 0) - 1);
        } else outcomes[key] = outcome;
      }
      memory.firstRunKeys = { ...outcomes };
      memory.locators = { ...(row.locators ?? {}), ...memory.locators };
      memory.ring = [...(Array.isArray(row.ring) ? row.ring : []), ...memory.ring].slice(-RING_CAP);
    }
    trimKeys(memory.firstRunKeys, 512); trimKeys(memory.locators, 128);
    pendingOutcomes.length = 0; hydrated = true;
  })();
  return hydration;
}

function trimKeys(record: Record<string, unknown>, limit: number) {
  const keys = Object.keys(record);
  for (const key of keys.slice(0, Math.max(0, keys.length - limit))) delete record[key];
}

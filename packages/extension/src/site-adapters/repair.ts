import { jsonBytes } from './schema.js';

export interface SourceDiagnostic { format: 'colp-source-diagnostic'; version: 1; schemaVersion: number;
  stores: { name: string; records: { key: IDBValidKey; value: unknown; specialValues?: { path: (string | number)[]; type: 'undefined' | 'date' }[] }[] }[] }
function diagnosticRecord(key: IDBValidKey, value: unknown): SourceDiagnostic['stores'][number]['records'][number] {
  const specialValues: { path: (string | number)[]; type: 'undefined' | 'date' }[] = [], ancestors = new Set<object>(); let nodes = 0;
  const encode = (value: unknown, path: (string | number)[]): unknown => {
    if (++nodes > 100000 || path.length > 32) throw new Error('diagnosticLimit');
    if (value === undefined) { specialValues.push({ path, type: 'undefined' }); return null; }
    if (value instanceof Date && Number.isFinite(value.getTime())) { specialValues.push({ path, type: 'date' }); return value.toISOString(); }
    if (!value || typeof value !== 'object') return value;
    if (ancestors.has(value) || !Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('diagnosticEncodingUnsupported');
    ancestors.add(value);
    const result = Array.isArray(value) ? value.map((v, i) => encode(v, [...path, i]))
      : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v, [...path, k])]));
    ancestors.delete(value); return result;
  };
  const record = { key: encode(key, ['key']) as IDBValidKey, value: encode(value, ['value']) };
  return specialValues.length ? { ...record, specialValues } : record;
}
/** Open the existing schema without upgrading, interpreting, deleting or replaying it. */
export async function exportSourceDiagnostic(factory: IDBFactory = indexedDB, name = 'known-site-adapters'): Promise<SourceDiagnostic> {
  if (typeof factory.databases === 'function' && !(await factory.databases()).some(db => db.name === name && db.version))
    return { format: 'colp-source-diagnostic', version: 1, schemaVersion: 0, stores: [] };
  const db = await new Promise<IDBDatabase | null>((resolve, reject) => {
    const request = factory.open(name);
    let missing = false;
    request.onupgradeneeded = () => { missing = true; request.transaction!.abort(); };
    request.onerror = () => missing ? resolve(null) : reject(new Error('sourceStoreUnavailable'));
    request.onblocked = () => reject(new Error('sourceStoreBusy'));
    request.onsuccess = () => resolve(request.result);
  });
  if (!db) return { format: 'colp-source-diagnostic', version: 1, schemaVersion: 0, stores: [] };
  try {
    const names = Array.from(db.objectStoreNames), stores: SourceDiagnostic['stores'] = [];
    let count = 0, bytes = 0;
    if (names.length > 100) throw new Error('diagnosticLimit');
    if (names.length) await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(names, 'readonly');
      let failure: Error | undefined;
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(failure ?? new Error('sourceStoreUnavailable'));
      for (const name of names) {
        const records: SourceDiagnostic['stores'][number]['records'] = []; stores.push({ name, records });
        const request = tx.objectStore(name).openCursor();
        request.onsuccess = () => {
          const cursor = request.result; if (!cursor || failure) return;
          let record: SourceDiagnostic['stores'][number]['records'][number];
          try { record = diagnosticRecord(cursor.key, cursor.value); } catch (e) { failure = e instanceof Error ? e : new Error('diagnosticEncodingUnsupported'); tx.abort(); return; }
          // Never silently omit an unknown structured-clone type or truncate recovery evidence.
          if (!jsonBytes(record, 32 * 1024 * 1024)) failure = new Error('diagnosticEncodingUnsupported');
          else { bytes += new TextEncoder().encode(JSON.stringify(record)).byteLength;
            if (++count > 100_000 || bytes > 32 * 1024 * 1024) failure = new Error('diagnosticLimit'); }
          if (failure) { tx.abort(); return; }
          records.push(record); cursor.continue();
        };
      }
    });
    return { format: 'colp-source-diagnostic', version: 1, schemaVersion: db.version, stores };
  } finally { db.close(); }
}

/** Deliberately projects no capabilities, leases, cookies or arbitrary payloads into the inspector. */
export function diagnosticSummary(data: SourceDiagnostic) {
  const summaries = data.stores.map(s => ({ store: s.name, records: s.records.length }));
  const attention: { store: string; key: IDBValidKey; state: string; reason: string }[] = [];
  for (const store of data.stores) for (const row of store.records) {
    const value = row.value as { state?: string; phase?: string; reason?: string } | null;
    if (!value || typeof value !== 'object') continue;
    const state = value.state ?? value.phase;
    if (['unknown', 'submitted', 'blocked', 'detached', 'suppressed', 'attention', 'paused'].includes(state ?? '') && attention.length < 100)
      attention.push({ store: store.name, key: row.key, state: state!, reason: typeof value.reason === 'string' ? value.reason :
        ['unknown', 'submitted'].includes(state!) ? 'Recover the original command; replacement creates are blocked.' : 'Explicit review required; existing objects are retained.' });
  }
  const ordinal = data.stores.find(s => s.name === 'meta')?.records.find(r => r.key === 'ordinal')?.value;
  return { schemaVersion: data.schemaVersion, supportedSchema: data.schemaVersion <= 3, stores: summaries, attention,
    lastAcceptedOrdinal: data.schemaVersion <= 3 && Number.isSafeInteger(ordinal) ? ordinal : null,
    pendingObservations: data.schemaVersion <= 3 ? data.stores.find(s => s.name === 'observations')?.records.filter(r => (r.value as { state?: string })?.state !== 'settled').length ?? 0 : null,
    truncated: data.stores.reduce((n, s) => n + s.records.filter(r => {
      const v = r.value as { state?: string; phase?: string } | null;
      return v && typeof v === 'object' && ['unknown', 'submitted', 'blocked', 'detached', 'suppressed', 'attention', 'paused'].includes(v.state ?? v.phase ?? '');
    }).length, 0) > attention.length };
}

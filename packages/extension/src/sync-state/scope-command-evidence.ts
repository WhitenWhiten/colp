import { digestJson } from '../bookmark-event-codec.js';
import { SyncStateError, type ScopeCommandPlanRecord, type UnknownRecord } from './types.js';
import { safeInteger, strictObject, validateRecord } from './codec.js';
import { requestValue } from './idb.js';
import { STORES } from './schema.js';
import { validateScopeCommandPlan } from './scope-command-record.js';

const KIND = 'scope_command_evidence_v1';
const rangeFor = (prefix: string) => IDBKeyRange.bound(prefix, `${prefix}\uffff`);
const scopePrefix = (key: string) => `scope-command-evidence:${digestJson({ scopeKey: key })}:`;
const commandPrefix = (key: string, commandId: string) => `${scopePrefix(key)}${digestJson({ commandId })}:`;
const pageKey = (record: ScopeCommandPlanRecord, bodyDigest: string, ordinal: number) =>
  `${commandPrefix(record.scopeKey, record.commandId)}${digestJson({ baselineDigest: record.baselineDigest, bodyDigest })}:${ordinal}`;

/** The logical plan stays complete; only its physical IndexedDB representation is paged. */
export async function writeScopeCommandRecord(tx: IDBTransaction, key: string, input: ScopeCommandPlanRecord,
  maxBytes: number): Promise<void> {
  const record = validateScopeCommandPlan(key, input, Number.MAX_SAFE_INTEGER);
  let header = record;
  const pages: UnknownRecord[] = [];
  try { validateRecord(record, maxBytes); }
  catch (error) {
    if (!(error instanceof SyncStateError) || error.code !== 'record_too_large' || record.kind !== 'rejoin') throw error;
    const body = JSON.stringify({ dependencies: record.dependencies,
      ...(record.rejoinDecision ? { rejoinDecision: record.rejoinDecision } : {}) });
    const bodyDigest = digestJson({ body });
    const template = { key: pageKey(record, bodyDigest, 10_000), kind: KIND, scopeKey: key,
      commandId: record.commandId, baselineDigest: record.baselineDigest, ordinal: 10_000, bodyDigest, chunk: '' };
    // JSON can expand one UTF-16 unit to six bytes. Split text, never truncate evidence.
    const chunkSize = Math.min(16_384, Math.floor((maxBytes - new TextEncoder().encode(JSON.stringify(template)).length) / 6));
    if (chunkSize < 1) throw new SyncStateError('record_too_large');
    for (let offset = 0; offset < body.length; offset += chunkSize) {
      const ordinal = pages.length;
      pages.push({ ...template, key: pageKey(record, bodyDigest, ordinal), ordinal, chunk: body.slice(offset, offset + chunkSize) });
    }
    if (pages.length > 10_000) throw new SyncStateError('record_too_large');
    header = { ...record, dependencies: [], rejoinDecision: { kind: KIND, bodyDigest, pageCount: pages.length } };
    validateRecord(header, maxBytes);
    for (const page of pages) validateRecord(page, maxBytes);
  }
  const metadata = tx.objectStore(STORES.metadata);
  metadata.delete(rangeFor(commandPrefix(key, record.commandId)));
  for (const page of pages) metadata.put(page);
  tx.objectStore(STORES.scopeCommandPlans).put(header);
}

/** An incomplete/corrupt manifest never becomes an executable plan with empty dependencies. */
export async function readScopeCommandRecord(tx: IDBTransaction, key: string, raw: unknown,
  maxBytes: number): Promise<ScopeCommandPlanRecord> {
  const header = validateScopeCommandPlan(key, raw, maxBytes);
  if (header.rejoinDecision?.kind !== KIND) return header;
  const manifest = strictObject(header.rejoinDecision, ['kind', 'bodyDigest', 'pageCount'], 'command evidence');
  const count = safeInteger(manifest.pageCount, 'pageCount', 1);
  if (count > 10_000 || typeof manifest.bodyDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(manifest.bodyDigest)
    || header.kind !== 'rejoin' || header.dependencies.length) throw new SyncStateError('command_evidence_invalid');
  const digest = manifest.bodyDigest;
  const pages = await Promise.all(Array.from({ length: count }, (_, ordinal) =>
    requestValue(tx.objectStore(STORES.metadata).get(pageKey(header, digest, ordinal)))));
  const chunks = pages.map((value, ordinal) => {
    if (!value) throw new SyncStateError('command_evidence_missing');
    const page = strictObject(value, ['key', 'kind', 'scopeKey', 'commandId', 'baselineDigest', 'ordinal', 'bodyDigest', 'chunk'], 'command evidence page');
    validateRecord(page, maxBytes);
    if (page.key !== pageKey(header, digest, ordinal) || page.kind !== KIND || page.scopeKey !== key
      || page.commandId !== header.commandId || page.baselineDigest !== header.baselineDigest || page.ordinal !== ordinal
      || page.bodyDigest !== digest || typeof page.chunk !== 'string') throw new SyncStateError('command_evidence_invalid');
    return page.chunk;
  });
  const body = chunks.join('');
  if (digestJson({ body }) !== digest) throw new SyncStateError('command_evidence_invalid');
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { throw new SyncStateError('command_evidence_invalid'); }
  const value = strictObject(parsed, ['dependencies', 'rejoinDecision'], 'command evidence body', ['rejoinDecision']);
  const { rejoinDecision: _manifest, ...rest } = header;
  return validateScopeCommandPlan(key, { ...rest, ...value }, Number.MAX_SAFE_INTEGER);
}

export function deleteScopeCommandEvidence(tx: IDBTransaction, key: string): void {
  tx.objectStore(STORES.metadata).delete(rangeFor(scopePrefix(key)));
}

/** Authorized cleanup archives corrupt bytes as diagnostics, without interpreting them as work. */
export async function archiveScopeCommandEvidence(tx: IDBTransaction, key: string, raw: ScopeCommandPlanRecord,
  error: unknown): Promise<UnknownRecord> {
  const pages = await requestValue(tx.objectStore(STORES.metadata).getAll(rangeFor(commandPrefix(key, raw.commandId))));
  return { commandId: raw.commandId, code: error instanceof SyncStateError ? error.code : 'command_evidence_invalid',
    manifest: raw, pages };
}

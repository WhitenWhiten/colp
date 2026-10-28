import { sql, type RawBuilder } from 'kysely';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { managedSlotKey, parseManagedSave, parseManagedSlot, parseManagedCopy, parseManagedReconcile, sourceConnectionKey, text, SourceArchiveError,
  type ManagedSaveState, type ManagedSaveCommand, type ManagedNode, type ManagedSlot } from '../../modules/source-archives/index.js';
import { recordHash, managedRecord, bindingContent, slotIdentity, type ManagedRecord, type RecordKind } from './managed-record-codec.js';
type Legacy = { folders: Record<string, ManagedNode>; copies: Record<string, ManagedNode> };
const kinds = ['bindings', 'receipts', 'semanticClaims', 'edits'] as const;
async function writeRows(tx: DatabaseTransaction, accountId: string, rows: ManagedRecord[]) {
  for (let offset = 0; offset < rows.length; offset += 500) {
    const page = JSON.stringify(rows.slice(offset, offset + 500));
    await sql`INSERT INTO source_archive_managed_records
      (account_id,kind,record_hash,record_key,collection_id,node_id,content_hash,identity_hash,identity_version,payload_json)
      SELECT ${accountId},kind,record_hash,record_key,collection_id,node_id,content_hash,identity_hash,identity_version,payload_json
      FROM jsonb_to_recordset(${page}::jsonb) AS r(kind text, record_hash text, record_key text, collection_id text, node_id text,
        content_hash text, identity_hash text, identity_version integer, payload_json jsonb)
      ON CONFLICT(account_id,kind,record_hash) DO UPDATE SET payload_json=excluded.payload_json,
        collection_id=excluded.collection_id,node_id=excluded.node_id,content_hash=excluded.content_hash,
        identity_hash=excluded.identity_hash,identity_version=excluded.identity_version`.execute(tx);
  }
}
/** Caller holds the source account row lock. Upgrade once, preserving every immutable receipt. */
export async function migrateManagedRecords(tx: DatabaseTransaction, accountId: string) {
  const result = await sql<{ state_json: Legacy & { version: number; managed?: ManagedSaveState } }>`SELECT state_json FROM source_archive_accounts WHERE account_id=${accountId}`.execute(tx);
  const state = result.rows[0]!.state_json;
  if (state.version !== 1) throw new SourceArchiveError('source_schema_unsupported', 503);
  const rows: ManagedRecord[] = [];
  for (const kind of kinds) for (const [key, value] of Object.entries(state.managed?.[kind] ?? {})) rows.push(managedRecord(kind, key, value));
  for (const [key, value] of Object.entries(state.folders ?? {})) rows.push(managedRecord('legacyFolders', key, value));
  for (const [key, value] of Object.entries(state.copies ?? {})) rows.push(managedRecord('legacyCopies', key, value));
  await writeRows(tx, accountId, rows);
  await sql`UPDATE source_archive_accounts SET state_json=jsonb_set(state_json - 'managed','{version}','2'::jsonb) WHERE account_id=${accountId}`.execute(tx);
}
/** Load indexed dependencies only; updating a receipt never rewrites another site's history. */
export function createManagedRecordStore(tx: DatabaseTransaction, accountId: string) {
  const state: ManagedSaveState = { bindings: {}, receipts: {}, semanticClaims: {}, edits: {} }, baseline = new Map<string, string>();
  const maps = state as unknown as Record<RecordKind, Record<string, unknown>>;
  const legacy: Legacy = { folders: {}, copies: {} };
  const remember = (rows: readonly ManagedRecord[]) => {
    for (const row of rows) {
      baseline.set(JSON.stringify([row.kind, row.record_key]), JSON.stringify(row.payload_json));
      if (row.kind === 'legacyFolders') legacy.folders[row.record_key] = row.payload_json as ManagedNode;
      else if (row.kind === 'legacyCopies') legacy.copies[row.record_key] = row.payload_json as ManagedNode;
      else maps[row.kind][row.record_key] = row.payload_json;
    }
    return rows;
  };
  async function read(kind: RecordKind, predicate: RawBuilder<unknown>, limit = 100001) {
    const rows = (await sql<ManagedRecord>`SELECT * FROM source_archive_managed_records WHERE account_id=${accountId} AND kind=${kind} AND ${predicate} LIMIT ${limit}`.execute(tx)).rows;
    if (rows.length > 100000) throw new SourceArchiveError('source_capacity'); return remember(rows);
  }
  const exact = (kind: RecordKind, key: string) => read(kind, sql`record_hash=${recordHash(key)} AND record_key=${key}`, 1);
  async function aliases(collectionId: string, nodeId: string, folder = false) {
    await read('bindings', folder ? sql`collection_id=${collectionId}` : sql`collection_id=${collectionId} AND node_id=${nodeId}`);
  }
  async function legacyFor(command: ManagedSaveCommand) {
    const slot = command.slot;
    if (slot.kind === 'bookmark' && slot.copy.purpose !== 'sourceArchive') return;
    if (slot.kind === 'folder') {
      const source = slot.source, connection = sourceConnectionKey(source);
      await read('legacyFolders', sql`identity_hash=${recordHash([connection, 'folder', command.collectionId, source.sourceCollectionId])}`);
    } else if (slot.copy.purpose === 'sourceArchive') {
      const source = { site: slot.copy.content.site, identityVersion: slot.copy.content.identityVersion, sourceAccount: slot.copy.sourceAccount };
      await read('legacyCopies', sql`content_hash=${recordHash([sourceConnectionKey(source), 'item', slot.copy.content.itemId])} AND (collection_id=${command.collectionId} OR collection_id IS NULL)`);
    }
  }
  return {
    state, legacy,
    async load(action: string, raw: unknown) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SourceArchiveError('invalid_source_document', 422);
      const input = raw as Record<string, unknown>;
      if (action === 'managed.save') {
        const c = parseManagedSave(raw); await exact('receipts', c.commandId); if (Object.hasOwn(state.receipts, c.commandId)) return state;
        await exact('bindings', managedSlotKey(c.collectionId, c.slot));
        if (c.converge && c.adopt) await aliases(c.collectionId, c.adopt.nodeId);
        if (c.slot.kind === 'bookmark' && c.copyPolicy && c.copyPolicy !== 'sourceAndSemantic')
          await read('bindings', sql`content_hash=${bindingContent(c.collectionId, c.slot)}`);
        const identity = slotIdentity(c.collectionId, c.slot);
        // Separate index ranges avoid walking every row of the current version.
        await read('bindings', sql`identity_hash=${identity.hash} AND identity_version < ${identity.version}`, 1);
        await read('bindings', sql`identity_hash=${identity.hash} AND identity_version > ${identity.version}`, 1);
        if (c.slot.kind === 'bookmark' && c.slot.copy.purpose === 'semantic') await exact('semanticClaims', managedSlotKey(c.collectionId, c.slot));
        await legacyFor(c); return state;
      }
      if (action === 'managed.recover') { await exact('receipts', text(input.commandId)); return state; }
      if (action === 'managed.reconcile.recover') { await exact('edits', text(input.commandId)); return state; }
      if (action === 'managed.reconcile') {
        const c = parseManagedReconcile(raw); await exact('edits', c.commandId);
        if (!Object.hasOwn(state.edits!, c.commandId)) await aliases(c.collectionId, c.expected.nodeId, c.expected.url === null);
        return state;
      }
      if (action === 'managed.reconcile.undo') {
        await exact('edits', text(input.commandId)); await exact('edits', text(input.original));
        const original = Object.hasOwn(state.edits!, String(input.original)) ? state.edits![String(input.original)] : undefined;
        if (original && !Object.hasOwn(state.edits!, String(input.commandId))) await aliases(text(input.collectionId), original.after.nodeId, original.after.url === null);
        return state;
      }
      if (['managed.lookup', 'managed.semantic.claim', 'managed.semantic.release', 'managed.manual', 'managed.relocate'].includes(action)) {
        const collectionId = text(input.collectionId), slot: ManagedSlot = input.slot ? parseManagedSlot(input.slot) : { kind: 'bookmark', copy: parseManagedCopy(input.copy) };
        const key = managedSlotKey(collectionId, slot); await exact('bindings', key);
        if (action.startsWith('managed.semantic.')) await exact('semanticClaims', key);
        if (action === 'managed.manual' || action === 'managed.relocate')
          await aliases(collectionId, text(action === 'managed.manual' ? input.nodeId : (input.expected as { nodeId?: unknown })?.nodeId));
      }
      return state;
    },
    async list(collectionId: string, after: string | null) {
      if (after !== null && !/^v2:[a-f0-9]{64}$/u.test(after)) throw new SourceArchiveError('source_list_restart_required');
      const rows = (await sql<ManagedRecord>`SELECT * FROM source_archive_managed_records WHERE account_id=${accountId} AND kind='bindings'
        AND collection_id=${collectionId} AND record_hash > ${after?.slice(3) ?? ''} ORDER BY record_hash LIMIT 101`.execute(tx)).rows;
      return { bindings: rows.slice(0, 100).map(row => ({ key: row.record_key, ...(row.payload_json as object) })), nextCursor: rows.length > 100 ? `v2:${rows[99]!.record_hash}` : null };
    },
    async hasSource(collectionId: string, site: string, account: string) {
      const result = await sql<{ present: boolean }>`SELECT EXISTS(SELECT 1 FROM source_archive_managed_records WHERE account_id=${accountId} AND kind='bindings'
        AND identity_hash=${recordHash([collectionId, site, account])}
        AND (payload_json->'slot'->>'kind'='folder' OR payload_json->'slot'->'copy'->>'purpose'='sourceArchive')) AS present`.execute(tx);
      return result.rows[0]!.present;
    },
    trackLegacy(value: Legacy) {
      for (const [key, row] of Object.entries(value.folders)) baseline.set(JSON.stringify(['legacyFolders', key]), JSON.stringify(row));
      for (const [key, row] of Object.entries(value.copies)) baseline.set(JSON.stringify(['legacyCopies', key]), JSON.stringify(row));
    },
    async flush(value?: Legacy) {
      const changed: ManagedRecord[] = [];
      const collect = (kind: RecordKind, values: Record<string, unknown>) => {
        for (const [key, row] of Object.entries(values)) if (baseline.get(JSON.stringify([kind, key])) !== JSON.stringify(row)) changed.push(managedRecord(kind, key, row));
      };
      for (const kind of kinds) collect(kind, maps[kind]);
      if (value) { collect('legacyFolders', value.folders); collect('legacyCopies', value.copies); }
      await writeRows(tx, accountId, changed);
    },
  };
}

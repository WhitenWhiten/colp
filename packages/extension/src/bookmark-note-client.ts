import { digestJson } from './bookmark-event-codec.js';
import { createNoteProductTransport, type NoteProductTransportOptions, type NoteProductTransport } from './note-product-transport.js';
import { sameMetadataAuthority } from './local-metadata-state.js';
export { NoteSyncError } from './note-product-transport.js';
import type { NoteBinding, NoteIntent } from './bookmark-annotation-sync-types.js';
import { ANNOTATION_LIMITS } from './bookmark-annotation-store.js';

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f"\\]/u.test(value);

export function createBookmarkNoteClient(options: NoteProductTransportOptions & {
  readonly scopeKey: string; readonly nodeId?: string; readonly transport?: NoteProductTransport;
}) {
  const transport = options.transport ?? createNoteProductTransport(options);
  if (transport.authority.serverOrigin !== options.serverOrigin || transport.authority.accountId !== options.accountId
    || transport.authority.collectionId !== options.collectionId) throw new Error('annotation_scope_changed');
  const request = (path: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET', body?: unknown, intent?: NoteIntent) =>
    transport.request(path, { method, body, guard: options.assertCurrent,
      ...(intent ? { command: { commandId: intent.commandId, ...(intent.action === 'create' ? {} : { revision: intent.revision }) } } : {}),
      maxBytes: 16 * 1024 * 1024 });
  const assertNode = (nodeId: string) => {
    if (options.nodeId !== undefined && options.nodeId !== nodeId) throw new Error('annotation_target_changed');
  };
  const root = `/api/v1/collections/${encodeURIComponent(options.collectionId)}/annotations`;
  const binding = (nodeId: string, note: Record<string, unknown> | undefined, supported = true): NoteBinding => ({
    scopeKey: options.scopeKey, resourceId: nodeId, revision: note ? String(note.revision) : 'absent',
    annotationId: note ? String(note.id) : null, value: note && typeof note.value === 'string' ? note.value : null, supported,
  });
  function validateNote(value: unknown, nodeId: string): Record<string, unknown> {
    if (!object(value) || !identifier(value.id) || !identifier(value.revision) || value.collectionId !== options.collectionId
      || !object(value.subject) || value.subject.type !== 'node' || value.subject.id !== nodeId) throw new Error('annotation_response_invalid');
    return value;
  }
  const supported = (note: Record<string, unknown>) => note.format === 'plain' && typeof note.value === 'string'
    && new TextEncoder().encode(note.value).length <= ANNOTATION_LIMITS.noteBytes
    && (!object(note.provenance) || note.provenance.kind === 'human');
  return {
    /** One collection request when unchanged; pages contain notes rather than one request per bookmark. */
    async readCollection(nodeIds: readonly string[]): Promise<(ReadonlyMap<string, NoteBinding> & { snapshotRevision: string; snapshotScopeKey: string }) | null> {
      const cacheKey = 'known.annotations.snapshot-revision.v1';
      const snapshotScopeKey = `${options.scopeKey}:${digestJson([...nodeIds].sort())}`;
      const cached = (await chrome.storage.local.get(cacheKey))[cacheKey] as { scopeKey?: string; revision?: string } | undefined;
      let cursor: string | undefined, revision: string | undefined;
      const seen = new Set<string>(), ids = new Set<string>(), notes = new Map<string, Record<string, unknown>[]>();
      for (let page = 0; page < 4096; page++) {
        const query = new URLSearchParams({ resourceType: 'collection', resourceId: options.collectionId, collectionNotes: 'true',
          ...(cursor ? { cursor } : cached?.scopeKey === snapshotScopeKey && cached.revision ? { knownRevision: cached.revision } : {}) });
        const data = await request(`${root}?${query}`);
        if (!object(data) || typeof data.revision !== 'string' || !data.revision || data.revision.length > 512
          || revision !== undefined && revision !== data.revision || !Array.isArray(data.annotations) || data.annotations.length > 100 || !object(data.page)
          || data.page.returnedCount !== data.annotations.length || typeof data.page.hasMore !== 'boolean'
          || (data.page.hasMore ? typeof data.page.nextCursor !== 'string' || !data.page.nextCursor || data.page.nextCursor.length > 2048 : data.page.nextCursor !== null))
          throw new Error('annotation_response_invalid');
        if (data.unchanged === true) {
          if (page || cached?.scopeKey !== snapshotScopeKey || cached.revision !== data.revision || data.annotations.length || data.page.hasMore)
            throw new Error('annotation_response_invalid');
          return null;
        }
        revision = data.revision;
        for (const entry of data.annotations) {
          if (!object(entry) || !object(entry.subject) || entry.subject.type !== 'node' || !identifier(entry.subject.id)) throw new Error('annotation_response_invalid');
          const note = validateNote(entry, entry.subject.id);
          if (ids.has(String(note.id)) || note.type !== 'note' || note.visibility !== 'private') throw new Error('annotation_response_invalid');
          ids.add(String(note.id)); const list = notes.get(entry.subject.id) ?? []; list.push(note); notes.set(entry.subject.id, list);
        }
        if (!data.page.hasMore) {
          await options.assertCurrent?.();
          const result = new Map([...notes].map(([id, list]) => [id, binding(id, list[0], list.length === 1 && supported(list[0]!))]));
          // The caller commits this revision only after all observations are durable.
          return Object.assign(result, { snapshotRevision: revision, snapshotScopeKey });
        }
        cursor = data.page.nextCursor as string;
        if (seen.has(cursor)) throw new Error('annotation_response_invalid'); seen.add(cursor);
      }
      throw new Error('annotation_response_invalid');
    },
    async read(nodeId: string): Promise<NoteBinding> {
      assertNode(nodeId);
      let cursor: string | undefined;
      const seen = new Set<string>(), ids = new Set<string>(), notes: Record<string, unknown>[] = [];
      for (let page = 0; page < 16; page++) {
        const query = new URLSearchParams({ resourceType: 'node', resourceId: nodeId, ...(cursor ? { cursor } : { limit: '16' }) });
        const data = await request(`${root}?${query}`);
        if (!object(data) || !Array.isArray(data.annotations) || data.annotations.length > 16 || !object(data.page)
          || typeof data.page.hasMore !== 'boolean' || data.page.returnedCount !== data.annotations.length
          || (data.page.hasMore ? typeof data.page.nextCursor !== 'string' || !data.page.nextCursor
            || data.page.nextCursor.length > 2048 : data.page.nextCursor !== null)) throw new Error('annotation_response_invalid');
        for (const entry of data.annotations) {
          const note = validateNote(entry, nodeId);
          if (ids.has(String(note.id))) throw new Error('annotation_response_invalid');
          ids.add(String(note.id));
          if (note.type === 'note' && note.visibility === 'private') notes.push(note);
        }
        if (!data.page.hasMore) return binding(nodeId, notes[0], notes.length <= 1 && (!notes[0] || supported(notes[0])));
        cursor = data.page.nextCursor as string;
        if (seen.has(cursor)) throw new Error('annotation_response_invalid');
        seen.add(cursor);
      }
      throw new Error('annotation_response_invalid');
    },
    async send(intent: NoteIntent): Promise<NoteBinding> {
      assertNode(intent.nodeId);
      if (!sameMetadataAuthority(intent.scopeKey, options.scopeKey)) throw new Error('annotation_scope_changed');
      if (intent.action === 'delete') {
        const data = await request(`${root}/${encodeURIComponent(intent.annotationId!)}`, 'DELETE', undefined, intent);
        if (!object(data) || !object(data.receipt) || data.receipt.targetId !== intent.annotationId
          || data.receipt.collectionId !== options.collectionId) throw new Error('annotation_response_invalid');
        return binding(intent.nodeId, undefined);
      }
      const data = intent.action === 'create'
        ? await request(`${root}?${new URLSearchParams({ resourceType: 'node', resourceId: intent.nodeId })}`, 'POST',
          { type: 'note', format: 'plain', value: intent.value, visibility: 'private' }, intent)
        : await request(`${root}/${encodeURIComponent(intent.annotationId!)}`, 'PATCH', { value: intent.value }, intent);
      const note = validateNote(data, intent.nodeId);
      if (note.visibility !== 'private' || note.type !== 'note' || !supported(note) || note.value !== intent.value
        || (intent.action === 'update' && note.id !== intent.annotationId)) throw new Error('annotation_response_invalid');
      return binding(intent.nodeId, note);
    },
  };
}

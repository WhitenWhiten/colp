import { editMetadata, metadataAttempt, observeMetadata, rebaseMetadataTags, sameMetadataAuthority, sameMetadataField, sameTags,
  type MetadataBinding, type MetadataField } from './local-metadata-state.js';
import type { NoteBinding, NoteField, NoteIntent, NoteCompletion, PinBinding, PinField } from './bookmark-annotation-sync-types.js';
import { notifyBookmarkAnnotationChanged } from './bookmark-annotation-notice.js';
import { BOOKMARK_TAG_LIMITS, tagsFitSync, validateRetainedTags } from './bookmark-tag-limits.js';
import { METADATA_RETENTION_MS, retainedMetadataFor } from './metadata-retention.js';

export const BOOKMARK_ANNOTATION_DATABASE = 'known-bookmark-annotations';
const TABLE = 'bookmarks';
/** Raw input bounds: anything larger is a broken caller, not a note to be shortened. */
const MAX_RAW_TAGS = 1_000;
const MAX_RAW_TAG_LENGTH = 1_000;
const MAX_RAW_NOTE_LENGTH = 262_144;

export const ANNOTATION_LIMITS = { tags: BOOKMARK_TAG_LIMITS.count, tagLength: BOOKMARK_TAG_LIMITS.length, noteBytes: 16_384 } as const;

export interface AnnotatedBookmark { readonly id: string; readonly dateAdded?: number; readonly url?: string; readonly title?: string }
export interface BookmarkAnnotation {
  readonly nativeId: string; readonly dateAdded?: number; readonly url: string | null;
  readonly tags: readonly string[]; readonly note: string | null; readonly updatedAt: number; readonly version: number;
  readonly tagsSync?: MetadataField<readonly string[]>;
  readonly noteSync?: NoteField;
  readonly noteIntent?: NoteIntent;
  readonly noteConflictVersion?: number;
  readonly noteCheckedAt?: number;
  /** Pinned above the folder's other bookmarks; see bookmark-pin-order.ts. */
  readonly pinned?: true;
  readonly pinSync?: PinField;
  readonly title?: string; readonly removedAt?: number;
  readonly localEditedAt?: number;
}
export interface BookmarkAnnotationInput { readonly tags: readonly string[]; readonly note: string | null;
  /** Save form only: pin the new bookmark when the worker can (see sw/bookmark-pins.ts). */
  readonly pinned?: true }
export interface BookmarkAnnotationEditBase extends BookmarkAnnotationInput { readonly sourceTags?: readonly string[] }
export interface BookmarkAnnotationSaveOptions {
  readonly captureCreatedAt?: number;
  readonly preserveTags?: boolean;
  readonly base?: BookmarkAnnotationEditBase;
}

const encoder = new TextEncoder();

/** Trim, collapse inner whitespace, strip a leading '#', drop empties and commas, dedupe case-insensitively keeping the first spelling, cap count and length. */
export function normalizeAnnotationTags(tags: readonly string[]): string[] {
  const seen = new Set<string>(), result: string[] = [];
  for (const raw of tags) {
    // A comma separates tags in every export format, so it can never be part of one.
    for (const piece of String(raw).split(',')) {
      const clean = piece.replace(/[\u0000-\u001f\u007f\s]+/gu, ' ').trim().replace(/^#+\s*/u, '').trim();
      let tag = clean.slice(0, ANNOTATION_LIMITS.tagLength);
      if (/[\uD800-\uDBFF]$/u.test(tag)) tag = tag.slice(0, -1);
      tag = tag.trim();
      const key = tag.toLowerCase();
      if (!tag || seen.has(key)) continue;
      seen.add(key); result.push(tag);
      if (result.length >= ANNOTATION_LIMITS.tags) return result;
    }
  }
  return result;
}

/** Plain text: LF line breaks, no NUL, no trailing whitespace, at most noteBytes of UTF-8. Blank notes are null. */
export function normalizeAnnotationNote(note: string | null | undefined): string | null {
  if (note === null || note === undefined) return null;
  let text = note.replace(/\u0000/gu, '').replace(/\r\n?/gu, '\n').trimEnd();
  const bytes = encoder.encode(text);
  if (bytes.length > ANNOTATION_LIMITS.noteBytes) {
    let end: number = ANNOTATION_LIMITS.noteBytes;
    while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
    text = new TextDecoder().decode(bytes.subarray(0, end)).trimEnd();
  }
  return text.trim() === '' ? null : text;
}

/** Preserve existing authoritative spellings/members; normalize only newly typed tags. */
export function normalizeAnnotationEditTags(tags: readonly string[], existing: readonly string[]): string[] {
  const result: string[] = [];
  for (const raw of tags) {
    const preserved = existing.includes(raw);
    for (const tag of preserved ? [raw] : normalizeAnnotationTags([raw])) {
      if (preserved ? result.includes(tag) : result.some(value => value.toLowerCase() === tag.toLowerCase())) continue;
      result.push(tag);
      if (result.length >= ANNOTATION_LIMITS.tags) return result;
    }
  }
  return result;
}

function validateInput(input: BookmarkAnnotationInput): { tags: string[]; note: string | null } {
  const raw = input as unknown;
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as BookmarkAnnotationInput).tags)
    || (raw as BookmarkAnnotationInput).tags.length > MAX_RAW_TAGS
    || (raw as BookmarkAnnotationInput).tags.some(tag => typeof tag !== 'string' || tag.length > MAX_RAW_TAG_LENGTH)) {
    throw new Error('bookmark_annotation_invalid');
  }
  const note = (raw as BookmarkAnnotationInput).note;
  if (note !== null && (typeof note !== 'string' || note.length > MAX_RAW_NOTE_LENGTH)) throw new Error('bookmark_annotation_invalid');
  return { tags: normalizeAnnotationTags(input.tags), note: normalizeAnnotationNote(note) };
}

/** The normalized request field for a save, or undefined when there is nothing to keep. Throws like save() on malformed input. */
export function annotationForCaptureStart(input: BookmarkAnnotationInput | null | undefined,
  options: Pick<BookmarkAnnotationSaveOptions, 'preserveTags'> = {}): BookmarkAnnotationInput | undefined {
  if (!input) return undefined;
  let { tags, note } = validateInput(input);
  if (options.preserveTags) { validateRetainedTags(input.tags); tags = [...input.tags]; }
  const pinned = input.pinned === true;
  return tags.length || note !== null || pinned ? { tags, note, ...(pinned ? { pinned } : {}) } : undefined;
}

/** A reused native id (after a restore or import) carries a different creation date and must not inherit the old row. */
export function annotationMatchesBookmark(record: BookmarkAnnotation, bookmark: AnnotatedBookmark): boolean {
  return record.removedAt === undefined && record.nativeId === bookmark.id && (record.dateAdded === undefined || bookmark.dateAdded === undefined
    || record.dateAdded === bookmark.dateAdded);
}

export function annotationTagField(record: BookmarkAnnotation): MetadataField<readonly string[]> {
  return record.tagsSync ?? { value: record.tags, version: record.version, state: record.tags.length ? 'dirty' : 'synced' };
}
/** A row that never recorded a pin has no local intent, so a remote pin is adopted, never undone. */
export function annotationPinField(record: BookmarkAnnotation): PinField | undefined {
  return record.pinSync ?? (record.pinned ? { value: true, version: record.version, state: 'dirty' } : undefined);
}
const samePin = (a: boolean, b: boolean) => a === b;
const withPin = <Row extends BookmarkAnnotation>(row: Row, pinned: boolean): Row => {
  const { pinned: _pinned, ...rest } = row;
  return (pinned ? { ...rest, pinned: true } : rest) as Row;
};
export function annotationNoteField(record: BookmarkAnnotation): NoteField {
  return record.noteSync ?? { value: record.note, version: record.version, state: record.note !== null ? 'dirty' : 'synced' };
}

export type AnnotationSyncProblem = 'note-conflict' | 'note-unsupported' | 'tags-incompatible';
export function annotationSyncProblem(record: BookmarkAnnotation | null): AnnotationSyncProblem | undefined {
  if (!record) return undefined;
  if (!tagsFitSync(record.tags)) return 'tags-incompatible';
  if (record.noteSync?.remote?.supported === false) return 'note-unsupported';
  if (record.noteConflictVersion !== undefined && record.noteConflictVersion >= annotationNoteField(record).version) return 'note-conflict';
  return undefined;
}
export function sameAnnotationPresentation(a: BookmarkAnnotation | null, b: BookmarkAnnotation | null): boolean {
  return sameTags(a?.tags ?? [], b?.tags ?? []) && (a?.note ?? null) === (b?.note ?? null) && Boolean(a?.pinned) === Boolean(b?.pinned)
    && annotationSyncProblem(a) === annotationSyncProblem(b);
}

/** Profile-local values survive sign-out; sync state binds each field to its remote authority. */
export function createBookmarkAnnotationStore(options: { readonly indexedDB?: IDBFactory; readonly now?: () => number } = {}) {
  let opening: Promise<IDBDatabase> | undefined;
  const now = options.now ?? Date.now;
  const open = () => opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const factory = options.indexedDB ?? globalThis.indexedDB;
    if (!factory) { reject(new Error('indexeddb_unavailable')); return; }
    const request = factory.open(BOOKMARK_ANNOTATION_DATABASE, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore(TABLE, { keyPath: 'nativeId' }); };
    request.onerror = () => { opening = undefined; reject(request.error); };
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); opening = undefined; };
      resolve(request.result);
    };
  });

  async function transaction<T>(mode: IDBTransactionMode, work: (table: IDBObjectStore, result: (value: T) => void, fail: (error: unknown) => void) => void): Promise<T> {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(TABLE, mode); let result: T, failure: unknown;
      tx.oncomplete = () => resolve(result!);
      tx.onabort = tx.onerror = () => reject(failure ?? tx.error ?? new Error('bookmark_annotation_write_failed'));
      try { work(tx.objectStore(TABLE), value => { result = value; }, error => { failure = error; tx.abort(); }); }
      catch (error) { tx.abort(); reject(error); }
    });
  }

  const get = (bookmark: AnnotatedBookmark): Promise<BookmarkAnnotation | null> => transaction('readonly', (table, result) => {
    const request = table.get(bookmark.id);
    request.onsuccess = () => { const row = request.result as BookmarkAnnotation | undefined;
      result(row && annotationMatchesBookmark(row, bookmark) ? row : null); };
  });

  const getMany = (bookmarks: readonly AnnotatedBookmark[]): Promise<ReadonlyMap<string, BookmarkAnnotation>> =>
    transaction('readonly', (table, result) => {
      const found = new Map<string, BookmarkAnnotation>(); result(found);
      for (const bookmark of bookmarks) {
        const request = table.get(bookmark.id);
        request.onsuccess = () => { const row = request.result as BookmarkAnnotation | undefined;
          if (row && annotationMatchesBookmark(row, bookmark)) found.set(row.nativeId, row); };
      }
    });

  const list = (includeRemoved = false): Promise<readonly BookmarkAnnotation[]> => transaction('readonly', (table, result) => {
    const request = table.getAll(); request.onsuccess = () => result((request.result as BookmarkAnnotation[]).filter(row => includeRemoved || row.removedAt === undefined));
  });

  async function save(bookmark: AnnotatedBookmark, input: BookmarkAnnotationInput,
    options: BookmarkAnnotationSaveOptions = {}): Promise<BookmarkAnnotation | null> {
    const { preserveTags = false, base: editBase } = options;
    let { tags, note } = validateInput(input);
    if (preserveTags) {
      validateRetainedTags(input.tags);
      tags = [...input.tags];
    }
    if (typeof bookmark.id !== 'string' || !bookmark.id) throw new Error('bookmark_annotation_invalid');
    let changed = false;
    const saved = await modify(bookmark, current => {
      if (options.captureCreatedAt !== undefined && current) {
        if (current.localEditedAt !== undefined && current.localEditedAt >= options.captureCreatedAt) return current;
        tags = [...new Set([...current.tags, ...tags])]; note ??= current.note;
      }
      if (current && sameTags(input.tags, current.tags)) tags = [...current.tags];
      else if (current && !preserveTags) tags = normalizeAnnotationEditTags(input.tags, current.tags);
      if (current && input.note === current.note) note = current.note;
      const tagsEdited = Boolean(editBase && !sameTags(input.tags, editBase.tags));
      const noteEdited = Boolean(editBase && normalizeAnnotationNote(input.note) !== normalizeAnnotationNote(editBase.note));
      const captureConflict = options.captureCreatedAt !== undefined && current?.note !== null && current?.note !== undefined && current.note !== note;
      if (current && editBase) {
        const sourceTags = editBase.sourceTags ?? editBase.tags;
        // AI result chips may be visible before their canonical tag projection arrives locally.
        const observedTags = [...sourceTags, ...editBase.tags.filter(tag => !sourceTags.includes(tag)
          && current.tags.includes(tag) && !input.tags.includes(tag))];
        tags = !tagsEdited ? [...current.tags] : rebaseMetadataTags(observedTags, tags, current.tags);
        if (!noteEdited) note = current.note;
        else if (normalizeAnnotationNote(current.note) !== normalizeAnnotationNote(editBase.note) && current.note !== note) {
          throw new Error('bookmark_annotation_changed');
        }
        validateRetainedTags(tags);
      }
      if (!current && !tags.length && note === null && !tagsEdited && !noteEdited) return undefined;
      const url = bookmark.url ?? current?.url ?? null;
      if (!tagsEdited && !noteEdited && current && current.note === note && current.url === url
        && sameTags(current.tags, tags)) return current;
      changed = true;
      return { nativeId: bookmark.id,
        title: bookmark.title ?? current?.title,
        ...(bookmark.dateAdded === undefined ? current?.dateAdded === undefined ? {} : { dateAdded: current.dateAdded } : { dateAdded: bookmark.dateAdded }),
        url, tags, note, updatedAt: now(), localEditedAt: now(), version: (current?.version ?? 0) + 1,
        tagsSync: { ...editMetadata(current ? annotationTagField(current) : undefined, tags, [], sameTags, tagsEdited),
          ...(tagsEdited && !current?.tagsSync?.remote ? { unboundBase: editBase!.tags } : {}) },
        noteSync: editMetadata(current ? annotationNoteField(current) : undefined, note, null, (a, b) => a === b, noteEdited),
        ...(current?.noteIntent ? { noteIntent: current.noteIntent } : {}),
        ...(current?.noteConflictVersion === undefined ? {} : { noteConflictVersion: current.noteConflictVersion }),
        ...(captureConflict ? { noteConflictVersion: (current?.noteSync?.version ?? current?.version ?? 0) + 1 } : {}),
        ...(current?.noteCheckedAt === undefined ? {} : { noteCheckedAt: current.noteCheckedAt }),
        ...(current?.pinned ? { pinned: true } : {}), ...(current?.pinSync ? { pinSync: current.pinSync } : {}) };
    });
    if (saved && changed) void notifyBookmarkAnnotationChanged(bookmark.id);
    return saved;
  }

  /** Pin or unpin. Placement belongs to the worker's order pass; this only records the flag. */
  async function setPinned(bookmark: AnnotatedBookmark, pinned: boolean): Promise<BookmarkAnnotation | null> {
    if (typeof bookmark.id !== 'string' || !bookmark.id || bookmark.url === undefined) throw new Error('bookmark_annotation_invalid');
    let changed = false;
    const saved = await modify(bookmark, current => {
      if ((current?.pinned === true) === pinned) return current;
      changed = true;
      const row = current ?? emptyRecord(bookmark);
      const field = editMetadata(current ? annotationPinField(current) : undefined, pinned, false, samePin);
      return withPin({ ...row, pinSync: field, updatedAt: now(), localEditedAt: now(), version: row.version + 1 }, pinned);
    });
    if (saved && changed) void notifyBookmarkAnnotationChanged(bookmark.id);
    return saved;
  }

  async function modify(bookmark: AnnotatedBookmark, work: (row: BookmarkAnnotation | undefined) => BookmarkAnnotation | undefined) {
    return transaction<BookmarkAnnotation | null>('readwrite', (table, result, fail) => {
      result(null); const request = table.get(bookmark.id);
      request.onsuccess = () => {
        try {
          const candidate = request.result as BookmarkAnnotation | undefined;
          const next = work(candidate && annotationMatchesBookmark(candidate, bookmark) ? candidate : undefined);
          if (next) { if (next !== candidate) table.put(next); result(next); }
        } catch (error) { fail(error); }
      };
    });
  }

  const emptyRecord = (bookmark: AnnotatedBookmark): BookmarkAnnotation => ({ nativeId: bookmark.id,
    title: bookmark.title,
    ...(bookmark.dateAdded === undefined ? {} : { dateAdded: bookmark.dateAdded }), url: bookmark.url ?? null,
    tags: [], note: null, version: 0, updatedAt: now() });

  function observeTagRow(bookmark: AnnotatedBookmark, previous: BookmarkAnnotation | undefined, binding: MetadataBinding<readonly string[]>, settledVersion?: number) {
    // Remote values must be lossless: never normalize/truncate an authoritative tag set.
    if (!tagsFitSync(binding.value)) throw new Error('bookmark_annotation_invalid');
      const row = previous ?? emptyRecord(bookmark);
      let previousField = previous ? annotationTagField(row) : undefined;
      const attempt = previousField?.attempt;
      if (previousField && attempt && previousField.version > attempt.version
        && sameMetadataAuthority(attempt.scopeKey, binding.scopeKey) && attempt.resourceId === binding.resourceId
        && (settledVersion === attempt.version || sameTags(attempt.value, binding.value))) {
        previousField = { ...previousField, value: rebaseMetadataTags(attempt.value, previousField.value, binding.value) };
      }
      const field = observeMetadata(previousField, binding, sameTags, settledVersion);
      if (previous && sameMetadataField(previousField, field, sameTags)) return previous;
      return { ...row, tags: field.value, tagsSync: field, updatedAt: now(),
        version: row.version + Number(!sameTags(row.tags, field.value)) };
  }
  async function observeTags(bookmark: AnnotatedBookmark, binding: MetadataBinding<readonly string[]>, settledVersion?: number) {
    return modify(bookmark, previous => observeTagRow(bookmark, previous, binding, settledVersion));
  }
  async function observeTagsMany(observations: readonly { bookmark: AnnotatedBookmark; binding: MetadataBinding<readonly string[]>; settledVersion?: number }[]) {
    return transaction('readwrite', (table, result, fail) => {
      result(undefined);
      for (const { bookmark, binding, settledVersion } of observations) { const request = table.get(bookmark.id); request.onsuccess = () => {
        try {
          const row = request.result as BookmarkAnnotation | undefined;
          const next = observeTagRow(bookmark, row && annotationMatchesBookmark(row, bookmark) ? row : undefined, binding, settledVersion);
          if (next !== row) table.put(next);
        } catch (error) { fail(error); }
      }; }
    });
  }

  async function markTagsAttempt(bookmark: AnnotatedBookmark, sent: MetadataField<readonly string[]>, eventId?: string) {
    return modify(bookmark, row => {
      if (!row || !sent.remote || annotationTagField(row).state !== 'dirty') return row;
      const field = annotationTagField(row);
      return { ...row, tagsSync: { ...field, attempt: metadataAttempt(sent, sent.remote, sameTags, eventId) } };
    });
  }

  function observePinRow(bookmark: AnnotatedBookmark, previous: BookmarkAnnotation | undefined, binding: PinBinding, settledVersion?: number) {
    const row = previous ?? emptyRecord(bookmark);
    const previousField = previous ? annotationPinField(row) : undefined;
    const field = observeMetadata(previousField, binding, samePin, settledVersion);
    if (previous && sameMetadataField(previousField, field, samePin)) return previous;
    return withPin({ ...row, pinSync: field, updatedAt: now(), version: row.version + Number(Boolean(row.pinned) !== field.value) }, field.value);
  }
  const observePinsMany = (observations: readonly { bookmark: AnnotatedBookmark; binding: PinBinding; settledVersion?: number }[]) =>
    transaction('readwrite', (table, result, fail) => {
      result(undefined);
      for (const { bookmark, binding, settledVersion } of observations) { const request = table.get(bookmark.id); request.onsuccess = () => {
        try {
          const row = request.result as BookmarkAnnotation | undefined;
          const next = observePinRow(bookmark, row && annotationMatchesBookmark(row, bookmark) ? row : undefined, binding, settledVersion);
          if (next !== row) table.put(next);
        } catch (error) { fail(error); }
      }; }
    });
  async function markPinAttempt(bookmark: AnnotatedBookmark, sent: PinField, eventId?: string) {
    return modify(bookmark, row => {
      const field = row ? annotationPinField(row) : undefined;
      if (!row || !field || !sent.remote || field.state !== 'dirty') return row;
      return { ...row, pinSync: { ...field, attempt: metadataAttempt(sent, sent.remote, samePin, eventId) } };
    });
  }

  function observeNoteRow(bookmark: AnnotatedBookmark, previous: BookmarkAnnotation | undefined, binding: NoteBinding, settledVersion?: number) {
      const row = previous ?? emptyRecord(bookmark);
      const previousField = previous ? annotationNoteField(row) : undefined;
      if (previousField?.remote && !sameMetadataAuthority(previousField.remote.scopeKey, binding.scopeKey)) return row;
      if (!binding.supported) return { ...row, noteSync: { ...annotationNoteField(row), remote: binding }, noteCheckedAt: now() };
      if (previousField?.remote?.supported === false && previousField.state === 'dirty' && previousField.value !== binding.value) {
        return { ...row, noteSync: { ...previousField, remote: binding }, noteConflictVersion: previousField.version };
      }
      // A refused command is a review boundary, not a committed queue resolution.
      // Refresh its baseline without uploading a draft written before the refusal was known.
      const reviewing = row.noteConflictVersion !== undefined && previousField?.state === 'dirty'
        && previousField.value !== binding.value;
      const field = reviewing ? { ...previousField, remote: binding }
        : observeMetadata(previousField, binding, (a, b) => a === b, settledVersion);
      if (previous && sameMetadataField(previousField, field, (a, b) => a === b)) return previous;
      const { noteConflictVersion: _conflict, ...clean } = row;
      return { ...field.state === 'synced' ? clean : row, note: field.value, noteSync: field,
        ...(field.reviewVersion === undefined ? {} : { noteConflictVersion: field.reviewVersion }),
        updatedAt: now(), version: row.version + Number(row.note !== field.value) };
  }
  const observeNote = (bookmark: AnnotatedBookmark, binding: NoteBinding, settledVersion?: number) =>
    modify(bookmark, previous => observeNoteRow(bookmark, previous, binding, settledVersion));
  const observeNotesMany = (observations: readonly { bookmark: AnnotatedBookmark; binding: NoteBinding }[]) =>
    transaction('readwrite', (table, result, fail) => {
      result(undefined);
      for (const { bookmark, binding } of observations) { const request = table.get(bookmark.id); request.onsuccess = () => {
        try {
          const row = request.result as BookmarkAnnotation | undefined;
          const next = observeNoteRow(bookmark, row && annotationMatchesBookmark(row, bookmark) ? row : undefined, binding);
          if (next !== row) table.put(next);
        } catch (error) { fail(error); }
      }; }
    });


  async function prepareNote(bookmark: AnnotatedBookmark, scopeKey: string, nodeId: string) {
    return modify(bookmark, row => {
      if (!row || row.noteIntent) return row;
      const field = annotationNoteField(row), binding = field.remote;
      if (field.state !== 'dirty' || !binding?.supported || binding.resourceId !== nodeId
        || !sameMetadataAuthority(binding.scopeKey, scopeKey)
        || (row.noteConflictVersion !== undefined && row.noteConflictVersion >= field.version)) return row;
      const intent: NoteIntent = { scopeKey, nodeId, version: field.version, commandId: crypto.randomUUID(),
        action: binding.annotationId === null ? 'create' : field.value === null ? 'delete' : 'update',
        annotationId: binding.annotationId, revision: binding.revision, value: field.value };
      if (intent.action === 'create' && field.value === null) return row;
      return { ...row, noteIntent: intent, noteSync: { ...field,
        attempt: metadataAttempt(field, binding, (a, b) => a === b, intent.commandId) } };
    });
  }

  async function finishNote(bookmark: AnnotatedBookmark, intent: NoteIntent, outcome: NoteCompletion) {
    return modify(bookmark, row => {
      if (!row || row.noteIntent?.commandId !== intent.commandId) return row;
      const { noteIntent: _intent, noteConflictVersion: _review, ...rest } = row;
      if (outcome.kind === 'review') {
        const { attempt: _attempt, ...field } = annotationNoteField(row);
        return { ...rest, noteSync: field, noteConflictVersion: field.version };
      }
      const field = observeMetadata(annotationNoteField(row), outcome.binding, (a, b) => a === b, intent.version);
      return { ...rest, note: field.value, noteSync: field, updatedAt: now() };
    });
  }

  async function resolveNoteConflict(bookmark: AnnotatedBookmark, expected: { version: number; revision: string }, value: string, adoptCloud: boolean) {
    const saved = await modify(bookmark, row => {
      if (!row) throw new Error('bookmark_annotation_changed');
      const field = annotationNoteField(row);
      if (field.version !== expected.version || field.remote?.revision !== expected.revision || row.noteIntent || !field.remote.supported)
        throw new Error('bookmark_annotation_changed');
      const { noteConflictVersion: _review, ...rest } = row;
      const note = adoptCloud ? field.remote.value : normalizeAnnotationNote(value);
      return { ...rest, note, version: row.version + 1, updatedAt: now(), localEditedAt: now(),
        noteSync: { value: note, version: field.version + 1, state: adoptCloud || note === field.remote.value ? 'synced' : 'dirty', remote: field.remote } };
    });
    if (saved) void notifyBookmarkAnnotationChanged(bookmark.id);
    return saved;
  }

  const markNoteChecked = (bookmark: AnnotatedBookmark) => modify(bookmark, row => ({
    ...row ?? emptyRecord(bookmark), noteCheckedAt: now(),
  }));

  async function releaseBindings(bookmarks: readonly AnnotatedBookmark[]) {
    for (const bookmark of bookmarks) await modify(bookmark, row => row ? {
      nativeId: row.nativeId, dateAdded: row.dateAdded, url: row.url, tags: row.tags, note: row.note,
      updatedAt: now(), localEditedAt: row.localEditedAt, title: row.title, version: row.version + 1,
      tagsSync: { value: row.tags, version: row.version + 1, state: row.tags.length ? 'dirty' : 'synced' },
      noteSync: { value: row.note, version: row.version + 1, state: row.note === null ? 'synced' : 'dirty' },
      ...(row.pinned ? { pinned: true, pinSync: { value: true, version: row.version + 1, state: 'dirty' } } : {}),
    } : row);
  }

  const removeMany = (nativeIds: readonly string[], nodes: readonly AnnotatedBookmark[] = []): Promise<void> => nativeIds.length === 0 ? Promise.resolve()
    : transaction('readwrite', (table, result) => {
      const identities = new Map(nodes.map(node => [node.id, node])); result(undefined);
      for (const id of nativeIds) { const request = table.get(id); request.onsuccess = () => {
        const row = request.result as BookmarkAnnotation | undefined, node = identities.get(id);
        if (row && row.removedAt === undefined) table.put({ ...row, title: node?.title ?? row.title, removedAt: now() });
      }; }
    });

  async function restoreRemoved(bookmark: AnnotatedBookmark) {
    if (!bookmark.url) return;
    return transaction('readwrite', (table, result) => {
      result(undefined); const request = table.getAll(); request.onsuccess = () => {
        const rows = request.result as BookmarkAnnotation[];
        if (rows.some(row => annotationMatchesBookmark(row, bookmark))) return;
        const row = retainedMetadataFor(rows, bookmark, now()); if (!row) return;
        // Exact native restoration is not a new local edit. Keep remote authority,
        // conflict review and unresolved command identities across the tombstone.
        const { removedAt: _removedAt, ...restored } = row;
        table.put({ ...restored, title: bookmark.title ?? row.title, updatedAt: now() });
      };
    });
  }
  /** Explicit same-resource restoration; never select another bookmark's metadata by URL. */
  async function rebindExact(original: AnnotatedBookmark, bookmark: AnnotatedBookmark) {
    if (original.id === bookmark.id) return;
    await transaction('readwrite', (table, result) => {
      result(undefined); const request = table.get(original.id);
      request.onsuccess = () => {
        const row = request.result as BookmarkAnnotation | undefined;
        if (!row || row.dateAdded !== original.dateAdded || row.url !== original.url || row.url !== bookmark.url) return;
        const next = table.get(bookmark.id); next.onsuccess = () => {
          if (next.result) return; const { removedAt: _removedAt, ...retained } = row;
          table.put({ ...row, removedAt: row.removedAt ?? now() });
          table.put({ ...retained, nativeId: bookmark.id, dateAdded: bookmark.dateAdded, title: bookmark.title ?? row.title, updatedAt: now() });
        };
      };
    });
  }
  const pruneRemoved = () => transaction('readwrite', (table, result) => {
    result(undefined); const request = table.openCursor(); request.onsuccess = () => {
      const cursor = request.result; if (!cursor) return;
      const row = cursor.value as BookmarkAnnotation;
      if (row.removedAt !== undefined && now() - row.removedAt >= METADATA_RETENTION_MS) cursor.delete();
      cursor.continue();
    };
  });

  async function tagCounts(): Promise<readonly { readonly tag: string; readonly count: number }[]> {
    const counts = new Map<string, { spellings: Map<string, number>; count: number }>();
    for (const row of await list()) for (const tag of row.tags) {
      const entry = counts.get(tag.toLowerCase()) ?? { spellings: new Map(), count: 0 };
      entry.count++; entry.spellings.set(tag, (entry.spellings.get(tag) ?? 0) + 1); counts.set(tag.toLowerCase(), entry);
    }
    return [...counts.values()].map(({ spellings, count }) => ({
      tag: [...spellings].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0], count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  async function search(query: string): Promise<readonly string[]> {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    return (await list()).filter(row => row.tags.some(tag => tag.toLowerCase().includes(needle))
      || (row.note?.toLowerCase().includes(needle) ?? false)).map(row => row.nativeId);
  }

  return Object.freeze({ get, getMany, save, setPinned, observePinsMany, markPinAttempt, observeTags, observeTagsMany, markTagsAttempt, observeNote, observeNotesMany, prepareNote, finishNote, resolveNoteConflict, markNoteChecked,
    remove: (nativeId: string) => removeMany([nativeId]), removeMany, list, tagCounts, search, releaseBindings, restoreRemoved, rebindExact, pruneRemoved,
    close() { void opening?.then(db => db.close()).catch(() => undefined); opening = undefined; } });
}
export type BookmarkAnnotationStore = ReturnType<typeof createBookmarkAnnotationStore>;

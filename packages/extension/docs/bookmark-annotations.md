# Bookmark tags and notes

Every bookmark can carry tags and a note. Both persist in the browser profile and work
without an account. Eligible personal bookmarks also synchronize these fields; Chrome
has no such native fields, so IndexedDB remains the source for the extension UI.

## Storage

`src/bookmark-annotation-store.ts` owns the `known-bookmark-annotations` IndexedDB
database (one `bookmarks` table keyed by `nativeId`). Pages (popup, options) open it
directly in the extension origin, the same way the folder-description store is used.
A row holds `nativeId`, `dateAdded`, the bookmark `url` at the last save, `tags`, `note`,
`updatedAt` (from the injected clock) and `version` (+1 on every real change; saving
identical content is a no-op).

Native ids can be reused after a browser restore or import, so a row only matches a
bookmark whose `dateAdded` equals the stored one (a missing date on either side matches).
A mismatching row is invisible to reads and replaced by the next save. Editing a
bookmark's title or URL does not detach its annotation.

Clearing an existing value retains a dirty record until the cloud confirms its removal.
An empty save of a never-annotated bookmark is a no-op. Actual bookmark deletion still
removes the row. Tags and notes have independent field versions, baselines and attempts.

## Limits

| Field | Rule |
| --- | --- |
| Tags | At most 64 per bookmark, 64 UTF-16 code units each, matching the cloud node contract |
| Tag text | Trimmed, inner whitespace collapsed, a leading `#` removed, empties dropped, de-duplicated case-insensitively (first spelling wins) |
| Commas | Newly typed commas split tags. Existing authoritative cloud members retain their exact spelling and membership |
| Note | Plain text, 16,384 bytes of UTF-8. Line breaks become LF, NUL is removed, trailing whitespace is trimmed, and a longer note is cut at a character boundary |

Input that is not an array of strings, or is absurdly large (more than 1,000 tags, 1,000
characters per tag, 262,144 characters of note), throws `bookmark_annotation_invalid`.

## Lifecycle

- **Save from the popup.** `known.capture.start` accepts an optional `annotation`
  (`{ tags, note }`, bounded in `validCaptureRequest`). The worker normalizes it with
  `annotationForCaptureStart`, stores it on the capture task, and writes it through the
  coordinator's `acknowledge` hook once the task is `local-saved`, even if the popup has
  closed or the worker restarted in between. A task that resolves as `existing` writes
  nothing, and an existing row is never overwritten by a repeated receipt.
- **Delete and Undo in Know-N.** `backupLocalDelete` copies each bookmark's tags and
  note into the delete snapshot; `restoreLocalDelete` saves them against the restored
  native ids, right after the folder descriptions, and is safe to resume. Deletes of
  synced bookmarks undo through the cloud, which re-creates the bookmarks under new ids;
  their annotations are not restored (see the follow-up below).
- **Removal anywhere.** The worker sees every `onRemoved` event, whether the change came
  from Know-N or from the browser's own manager, and drops the annotation of the bookmark
  and of everything inside a removed folder. This runs before the sync filters, so it
  works for local-only users.
- **Garbage collection.** On browser startup and on the periodic reconcile alarm,
  `collectAnnotationGarbage` removes rows whose bookmark is gone, is now a folder, or has
  a different `dateAdded`. It does nothing without the optional bookmarks permission, and
  an empty tree never removes anything.
- **Permission.** Bookmark access is optional. Pages still read and write the store
  without it; backup, export, import, delete and garbage collection check the permission
  before they read the tree.

## Backup, export and import

- **Know-N JSON backup.** Bookmark nodes gain optional `tags` and `note`. The codec stays
  at version 1: the fields are additive, absent in older backups (which still restore
  unchanged), and rejected on folders. Restore writes annotations onto the new native
  ids in the metadata phase, which is idempotent and resumes after a restart.
  History entries never include notes. A pinned bookmark also carries `pinned: true`
  (bookmarks only), and Undo of a local delete restores the pin with tags and note; see
  [bookmark-save-placement.md](bookmark-save-placement.md#pinned-bookmarks).
- **HTML export.** Tags are written as `TAGS="a,b"` on the `<A>` element and the note as
  a `<DD>` line directly after that bookmark's `<DT><A>`, the Netscape convention used
  by Firefox, Pinboard and Raindrop. All text is HTML-escaped.
- **HTML import.** The local importer reads `TAGS` (comma separated) and the `<DD>` that
  follows a bookmark, normalizes them with the same rules, and saves them after the
  bookmarks are created (a plan with annotations finishes with the same metadata phase
  as a backup). A `<DD>` after a folder is ignored. The cloud import path is unchanged,
  and `TAGS` still travels as an unknown attribute there.

## Cloud sync

The shared lifecycle and authority boundary are described in [local-metadata-sync.md](local-metadata-sync.md).

- **Tags** map to the Node `tags` field (`tags?: string[]`; `NodeMergePatch.tags` for
  updates).
- **Note** maps to an `Annotation` with `type: 'note'`, `format: 'plain'` and the text
  in `value`, with `subject` pointing at the bookmark's node, `provenance.kind: 'human'`.

Tags use the existing durable node-update queue and server observed-remove merge.
Typed and accepted AI tags use the same worker-owned save. Notes use conditional,
idempotent Product Annotation mutations, bound to the verified Web session matching
the extension account. If that session is unavailable, notes remain local and pending.
Private, detached and subscription branches never upload or receive remote metadata.
Conflicted or unsupported cloud notes retain the local draft and display a review hint.
Plain notes up to 16 KiB are supported; markdown, larger notes and multiple private
notes on one subject require review in Web. The note scan is bounded to 20 bookmarks
per wake, prioritizing pending writes and rotating through clean bookmarks.

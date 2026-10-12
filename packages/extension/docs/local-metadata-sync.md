# Local and remote bookmark metadata

Folder descriptions, bookmark tags and personal notes share a local-first lifecycle:
save in IndexedDB, retain a dirty value and an authoritative baseline, persist an
attempt before dispatch, and acknowledge only an authoritative result. Native title,
URL and placement continue to use the existing bookmark event queue.

## Resource boundaries

- Folder descriptions and bookmark tags are COLP node fields. Use description/tag-only
  `update_node_content` operations in the existing durable queue, with base/value and
  baseRevision. Tags use the server's observed-remove merge, not array replacement.
- A note is a private, plain-text human Annotation on the bookmark, not its description.
  Use the existing Product annotation API with verified account/session, CSRF, a durable
  command id, and the exact original If-Match on retries. No new bearer permissions.
- Upload and download only inside the active personal sync range. Managed, private,
  detached and subscription branches remain local. A binding from another account or
  collection is never automatically reused to upload local content.

## State and recovery

The field state machine is shared. Tags and notes have independent versions and
baselines: editing tags must not overwrite or re-author a note. Empty values retain
dirty records until confirmed. Legacy rows become dirty without discarding content.
Canonical tag labels are preserved through the popup, capture worker, backup and Undo.
The wire supports 64 tags of 64 UTF-16 code units; local retention supports 128 members
of 128 units for legacy values and temporary merge overflow. Existing members stay
visible, incompatible fields pause their own uplink and display a review hint, and
other bookmark metadata continues syncing. Existing tags are not silently truncated to fit.
An old receipt advances the baseline without replacing a newer local edit. Queue
conflicts are acknowledged only after their bound Pull resolution commits.
An open form submits its original field values: untouched fields retain intervening
cloud changes, tag edits rebase onto concurrent additions, and a changed note is
rejected locally rather than overwriting another edit without review.

An Annotation mutation intent is stored before networking and freezes its target,
body, command id and ETag. Ambiguous outcomes replay that exact command before doing
another read or mutation. Session changes fail before admission; a private note with
an unsupported format/size or ambiguous selection is not overwritten or duplicated.
Note conflicts keep the local draft and expose the conflict rather than rebasing
silently. Remote reads never truncate a value and then write the truncated value back.
Refusals block the latest local draft version until a later explicit edit, including
expired receipts and lost permissions. A supported note recovered from an unsupported
format establishes a fresh review baseline without automatically replacing either side.

Note HTTP/session transport is separate from Annotation selection and validation. One
session bootstrap is shared per scan, every resource response remains session-bound,
and the complete note scan has a ten-second deadline. Up to 16 pages of 16 annotations
with a bounded 3 MiB response cover the server's 256-resource subject limit. Duplicate
ids/cursors fail before mutation. A pre-admission CSRF refusal can refresh the verified
identity and replay the exact immutable command. Dispatch rechecks the live cloud id,
native creation date/URL, selected range and subscription boundary inside its lock.

Historical queue confirmations can be read from the exact retired scope archive after
re-authentication. Archive reads are cached per wake and never cross account/collection
authority. Unchanged polls do not invalidate the editing UI.

## Verification

Focused tests cover clear propagation, legacy data, authoritative echoes, newer drafts,
tag merges, restart retries, conflict receipts, reused native ids, scope changes,
excluded branches, mismatched Product sessions and annotation pagination/validation.

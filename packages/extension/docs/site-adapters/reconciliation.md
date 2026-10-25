# Rechecking website collections

This shared website-adapter feature reads the site's current favorites and compares them with existing mappings. It does not write browser organization changes back to the website or empty and rebuild mapped folders.

On the Sync tab, click **Check again**, then review **Collection differences** when reading finishes. The normal import handles new favorites; the difference list handles existing bookmarks. These changes wait for approval.

| Situation | Default behavior | Explicitly available action |
| --- | --- | --- |
| Order, pins, tags and notes | Preserve them; order does not determine collection membership | No reconstruction needed |
| Custom bookmark title | Preserve it independently of collection membership | Use the source title |
| Source copy deleted locally | Keep it deleted | Restore this copy, including local annotations and pins that can be matched exactly |
| Matching content directly inside the mapped collection folder, without a source association | Keep the existing bookmark; neither adopt it automatically nor create another source copy | Choose a candidate explicitly and link it |
| Personal bookmark or folder inside a mapped folder | Keep it in place | Move it to a chosen folder; folders containing protected copies cannot be moved |
| Individual source copy moved elsewhere | Preserve its location and pause this copy | Return it to its mapped collection folder |
| Collection folder moved elsewhere | Pause further writes to that folder | Return it to its previous location, or approve continued use if the new location remains inside the authorized root |
| Website explicitly proves removal from the collection | Retain the browser copy | Move it to a dedicated history folder outside the mappings |
| Item missing from this read, without proof of removal | Retain it and mark it unverified | No cleanup action based on this absence |
| URL changed to different content, missing identity proof, or an entire mapped folder deleted | Retain visible objects and require review | No guessed identity, adoption of similar folders, or blind reconstruction |

Source copies are distinguished by website, source account, collection and content identity. Semantic copies are distinguished by content and bookmark library. Content present in multiple website collections can have a separate source copy in each. Deduplication does not merge source and semantic purposes. Other purposes sharing the same physical bookmark, and protected descendants inside a folder, block movement or deletion.

Destinations for personal items and retained history must preserve the original local or synced library boundary and remain outside every website mapping. A history destination must be an empty dedicated folder or a previously registered history folder. History folders are excluded from automatic semantic classification destinations.

**Applied** means that the chosen operations completed, not that the browser exactly matches the website. Unverified items and explicitly retained differences remain listed. Newly created website collections require selection; unreadable or inaccessible collections do not authorize cleanup of their bookmarks.

## Failures, retries and undo

Each operation persists an immutable command before execution, then records its result. After disconnection, page closure or worker termination, recovery first checks that original command's result. An uncertain result never causes a replacement create under a new command. A bookmark conflict pauses only the affected operation. The user can explicitly change the destination of a move that has not been issued; issued commands remain unchanged.

Execution rechecks the account, library, source authorization, rule version, folder identity and ownership. Manual changes made after the preview block the affected operation. Restoration reuses the same canonical bookmark identity; local reconstruction uses the existing reliable creation-receipt protocol. Ordinary synchronization and restoration creates share an execution lock.

Undo checks the resulting content, location, annotation revision and ownership. Later edits or use by another purpose pause undo instead of overwriting newer changes. Undoing a restoration or association leaves the source copy opted out, preventing immediate automatic reconstruction. Cancellation stops subsequent operations while preserving result lookup for issued commands. Starting another check retains the history. **Recovery → Previous collection checks** provides paged history, inspection, retry and undo.

The server commits source-association changes, bookmark changes, ordinary Sync effects, deletion authority and receipts in the same transaction. Association revisions prevent stale offline deletion reports from overriding a newer explicit restoration. Update both the extension and COLP Server; the server must support `managedReconcile: 1`.

## Current capability limits

Only a host-qualified, contiguous and complete point-in-time snapshot, or fresh explicit negative readback, can prove removal from a collection. Bilibili currently provides best-effort reads, so items missing from a read remain unverified and cannot be cleaned up automatically. The foundation supports collection membership sets; lists allowing repeated occurrences of the same content are not yet supported. Blank titles are preserved locally. Cloud writes retain the existing bookmark-content validation and never invent a title to bypass it.

Reconciliation previews have explicit item and byte limits. Exceeding them stops the operation rather than presenting truncated data as complete. Large historical previews are loaded on demand. Background work processes pending commands in bounded batches without rescanning all history. Unknown results, manual conflicts and old receipts are retained.

Controlled acceptance entry points: `tests/site-adapter-reconcile*.test.ts`, `e2e/mv3-site-adapter-reconcile.spec.ts`, `e2e/mv3-site-adapter-reconcile-server.spec.ts` and `e2e/mv3-site-adapter-shared-sync.spec.ts`. Browser tests run under xvfb. Website and model responses use controlled fixtures; cloud synchronization tests use a real disposable PostgreSQL database and server.

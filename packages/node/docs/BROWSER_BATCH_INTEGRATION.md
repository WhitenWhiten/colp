# Browser batch integration

`applySyncBrowserBatch` is available from
`@collection-protocol/node/sync/browser` (and the Node `sync` entry).

For a Move from A to B, supply `{ folderId: 'B', sourceFolderId: 'A', ...payload }`.
The driver still receives the complete change. Additional folders can be named
in `affectedFolderIds`; all IDs are deduplicated before rereading. Writes remain
sequential. A failed write still stops the batch and produces no completed
folder view; reconcile native partial progress at the host boundary.

Use `await applySyncBrowserBatch(changes, driver, { grouped: true })` when refreshing
folder indexes. It returns `{ folderId, items }[]`, retaining even empty source
folders. The default flat array remains available for compatible existing
callers whose items already carry parent identity. The helper cannot infer a
source folder that the browser adapter does not supply.

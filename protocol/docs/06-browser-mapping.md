# 06. Browser Bookmark Compatibility and Mapping

<a id="colp-section-1"></a>

## 1. Compatibility Targets

The first version must cover:

- Chromium-based browsers such as Chrome, Edge, Brave, and Opera.
- The Firefox WebExtensions bookmarks API.
- The Netscape Bookmark HTML import and export format.
- Safari, through import / export or a platform native bridge adapter.

The browser bookmark model is the protocol's lowest common denominator, not its upper limit.

<a id="colp-section-2"></a>

## 2. Chromium Mapping

The actual core fields of a Chromium `BookmarkTreeNode` include:

- `id`
- `parentId`
- `index`
- `title`
- `url`
- `children`
- `dateAdded`
- `dateGroupModified`
- `dateLastUsed`
- `folderType`
- `syncing`
- `unmodifiable`

Mapping table:

| Chromium | Collection Protocol | Notes |
|---|---|---|
| `id` | `sourceRefs.nativeId` | Not used as the primary protocol ID |
| `parentId` | `sourceRefs.nativeParentId` + the mapped `parentId` | Requires a local ID map |
| `index` | `sourceRefs.nativeIndex` | Protocol order follows `position` |
| `title` | `title` | Kept as is |
| `url` | `url` | Kept as is |
| `children` | Flat Nodes + `parentId` | Expanded on import |
| `dateAdded` | `createdAt` | Milliseconds converted to RFC 3339; the original value is still kept |
| `dateGroupModified` | `childrenModifiedAt` | Folders only |
| `dateLastUsed` | `lastUsedAt` | Chrome 114+ |
| `folderType` | `folderRole` | bookmarks-bar / other / mobile / managed |
| `syncing` | `sourceRefs.syncing` | Only describes the browser's built-in account sync |
| `unmodifiable=managed` | `constraints.readOnly=true` | Write-back to the browser is forbidden |

<a id="colp-section-2-1"></a>

### 2.1 Chromium Limitations

- Extensions cannot create or delete entries directly at the root.
- Special root folders such as the bookmarks bar and other bookmarks cannot be renamed, moved, or deleted.
- `update()` usually supports only `title` and `url`.
- The Chromium API does not support separators.
- The native browser model does not support tags, notes, annotations, relations, aliases, or attachments.

A Chromium adapter must therefore maintain a sidecar store:

```text
native bookmark tree        authoritative browser fields
local adapter database      protocol IDs, source references, notes, tags, sync cursors
remote Collection server    complete extension fields and publication policy
```

URLs such as `file:`, `about:`, `chrome:`, `edge:`, and `moz-extension:` that are legal in a browser but cannot be published enter the authoritative and Sync representations unchanged through `$defs.bookmarkUrl`. They may be written to a target browser only when the mount's `acceptedSchemes` allows them, and must not enter Publication or Feed.

<a id="colp-section-3"></a>

## 3. Firefox Mapping

A Firefox `BookmarkTreeNode` is close to Chromium's, but explicitly supports:

- `type=bookmark`
- `type=folder`
- `type=separator`

Mapping table:

| Firefox | Collection Protocol |
|---|---|
| `type=bookmark` | `kind=bookmark` |
| `type=folder` | `kind=folder` |
| `type=separator` | `kind=separator` |
| Other tree fields | Same as Chromium |

Firefox batched asynchronous creates and moves can change indexes before the operations finish. An adapter MUST wait for writes to complete in order, or re-read the entire affected folder at the end of the batch.

<a id="colp-section-4"></a>

## 4. Netscape Bookmark HTML

The protocol SHOULD support the common `NETSCAPE-Bookmark-file-1`:

```html
<DL><p>
  <DT><H3 ADD_DATE="..." LAST_MODIFIED="...">Folder</H3>
  <DL><p>
    <DT><A HREF="https://example.com" ADD_DATE="..." ICON="data:image/png;base64,...">Example</A>
  </DL><p>
</DL><p>
```

Mapping:

| HTML | Protocol |
|---|---|
| `<H3>` | Folder Node |
| `<A HREF>` | Bookmark Node |
| Nested `<DL>` | Parent / child |
| Document order | Position |
| `ADD_DATE` | createdAt |
| `LAST_MODIFIED` | updatedAt / childrenModifiedAt |
| `ICON_URI` | HTTP(S) favicon Attachment |
| `ICON=data:` | Decoded and materialized into controlled blob or object storage; otherwise kept in the source extension |
| `PERSONAL_TOOLBAR_FOLDER` | folderRole=bookmarks-bar |
| Unknown attributes | Netscape extension namespace |

Example of unknown attributes:

```json
{
  "extensions": {
    "https://collectionprotocol.org/ns/netscape-bookmark-html/v1": {
      "attributes": {
        "TAGS": "design,css"
      }
    }
  }
}
```

On export, if the target format does not support notes or annotations, an adapter must not concatenate them into the title on its own. It can:

1. Generate a sidecar JSON file alongside.
2. Use an explicitly enabled HTML extension attribute.
3. Return a lossy conversion report.

<a id="colp-section-5"></a>

## 5. Safari

Safari has no cross-platform real-time interface fully equivalent to the WebExtensions bookmarks API. The first version defines two adapter levels:

- `safari-import-export`: import from a bookmark file exported by Safari or from a readable data file.
- `safari-native-bridge`: a macOS native helper reads and writes within the scope the user authorized.

A Safari adapter MUST declare itself in the replica capabilities of the Sync session; the public HTTP Manifest only declares server profiles and does not carry local adapter state:

```json
{
  "adapter": "safari-native-bridge",
  "capabilities": {
    "read": true,
    "write": false,
    "events": false,
    "separator": false
  }
}
```

Without real-time events, the adapter uses periodic Snapshot diffs, but must respect the minimum scan interval configured by the server and locally.

<a id="colp-section-6"></a>

## 6. Special Root Folders

Adapters MUST build a root mapping and must not rely on fixed browser ID values:

| Browser role | Protocol role |
|---|---|
| Root | root |
| Bookmarks Bar / Toolbar | bookmarks-bar |
| Other Bookmarks / Menu | other-bookmarks |
| Mobile Bookmarks | mobile-bookmarks |
| Managed Bookmarks | managed-bookmarks |

If a target browser lacks a root role:

- It is mapped by default to a folder of the same name under `other-bookmarks`.
- A `root_role_materialized` warning is produced.
- Managed content must not be written into an editable folder unless the user explicitly chooses "copy as ordinary bookmarks".

<a id="colp-section-6-1"></a>

### 6.1 Collection Ownership Boundary

A browser profile usually has a single global bookmark tree. An adapter must choose and persist one of these modes:

- `whole-profile`: one Collection owns the entire browser profile exclusively; no other Collection may bind the same profile.
- `mounted-folder`: each Collection is bound to one explicit native folder, and reads, writes, reconciliation, and deletes must not cross that folder's boundary.

A Sync session must carry the browser profile, mount mode, mount native ID, and generation. Two-way sync must not start before an ownership boundary has been established.

<a id="colp-section-6-1-1"></a>

#### 6.1.1 Whole-profile Binding

In `whole-profile` mode, the browser's special roots map to mount folders under the one Collection, so no single native ID names the mount. Such a replica's `replica.binding` uses `mountMode = 'whole-profile'` and may send `mountNativeId = null`. The 0.1 `replicaBinding` schema does not require `null` here; a host may still send `whole-profile` with a non-null `mountNativeId`.

A replica that changes its mount mode or mount folder is not rewritten in place: it drains its queue, is retired, and registers a new generation.

<a id="colp-section-6-1-2"></a>

#### 6.1.2 Folder Roles Created Through Sync

A Sync `create_node` of a folder that is a direct child of the Collection root may use these folder roles:

- `bookmarks-bar`
- `other-bookmarks`
- `mobile-bookmarks`
- `custom`
- `recovered`

`managed-bookmarks` keeps its capability gate and stays read-only by default. Clients do not create `root`, `archive`, or `inbox` through Sync.

Each Collection has at most one live folder per special root role (`bookmarks-bar`, `other-bookmarks`, `mobile-bookmarks`). When a second concurrent create for the same root role arrives, exactly one live mount remains; the later receipt is `rebased`, carries the `nodeId` of the existing mount, and reports the registry code `invalid_node_constraints`. `custom` mounts are told apart by `extensions.customSourceKey` and do not follow the root-role uniqueness rule.

`recovered` is unique per live parent: at most one live `folderRole=recovered` Folder under a given parent (the owning mount, or the Collection root fallback when that mount is gone). A second concurrent create under the same parent is `rebased` with `invalid_node_constraints`. Recovered Folders created for different mounts MUST remain distinct. Clients MUST NOT guess `bookmarks-bar` when the owning mount cannot be confirmed.

The reference package exports these lists as `SYNC_CREATE_FOLDER_ROLE_ALLOW_LIST`, `SYNC_CREATE_FOLDER_ROLE_UNIQUE_LIVE`, and related constants; the server enforces uniqueness inside the write transaction.

<a id="colp-section-7"></a>

## 7. Lossy Conversion Rules

Every conversion returns:

```json
{
  "profile": "chromium-bookmarks-v1",
  "lossless": false,
  "warnings": [
    {
      "code": "separator_omitted",
      "nodeId": "node-separator-1",
      "message": "Chromium does not support bookmark separators. The node remains on the server but was not materialized locally."
    }
  ]
}
```

Standard warning codes:

- `separator_omitted`
- `alias_materialized`
- `annotation_sidecar_only`
- `attachment_not_materialized`
- `root_role_materialized`
- `managed_node_skipped`
- `unsupported_url_scheme`
- `timestamp_precision_changed`
- `unknown_extension_preserved_remote_only`
- `favicon_sidecar_only`
- `lossy_conversion` (an extension was removed or degraded, see `docs/01-core-data-model.md` Section 10)

<a id="colp-section-8"></a>

## 8. Alias

The native browser bookmark tree does not support aliases. Adaptation strategies:

- `duplicate`: create an independent native bookmark at each location, with one source reference per native ID.
- `skip`: keep only the server alias; the client does not show it.
- `reject`: stop this Collection from syncing to this browser.

`duplicate` is the default, and on the way back an `aliasGroupId` in a sidecar or namespaced extension keeps the copies from being mistaken for ordinary duplicates. `aliasGroupId` is not a core Node field. When the user edits a materialized copy, the adapter by default detaches that copy explicitly into an ordinary bookmark; it must not silently change every alias.

<a id="colp-section-9"></a>

## 9. Separator

- Firefox can round-trip separators natively.
- Netscape HTML can use `<HR>` or a source extension rule.
- Chromium does not materialize them by default, but keeps the server object.
- A client UI MAY show a server separator as a visual divider, even though it is invisible in the browser's bookmark manager.

<a id="colp-section-10"></a>

## 10. Notes, Tags, and Other Sidecar Data

When the native browser API does not provide these fields:

- The adapter MUST write them to a local sidecar.
- The sidecar uses the protocol Node ID as its primary key; the native ID is only an index.
- After a browser Node is deleted, its sidecar record enters the same retention flow as the tombstone.
- Before the user uninstalls the extension, the adapter SHOULD offer a way to export the sidecar.

The sidecar must also have a fail-safe contract:

- Persist `(browser, profile, collectionId, nodeId, nativeId, generation)`.
- Write a mutation journal before executing a native mutation, and commit the mapping and cursor only after it succeeds.
- Reconcile after startup, after an event gap, and after abnormal termination.
- When the sidecar is lost, the generation does not match, or native IDs are reused on a large scale, enter safe mode: uploading deletes and moves is forbidden until a full diff has been confirmed and the mapping rebuilt.
- Provide automatic backup and restore; "export manually before uninstalling" cannot be the only way to recover.

<a id="colp-section-11"></a>

## 11. Event Conversion

Browser event mapping:

| Browser event | Sync operation |
|---|---|
| onCreated | create_node |
| onChanged | update_node_content |
| onMoved | move_node |
| onChildrenReordered | reorder_children |
| onRemoved | delete_node |
| onImportBegan | The adapter starts a local mutation journal and uploads no protocol operation |
| onImportEnded | The adapter reconciles locally, then uploads only a standard operation batch |

When a folder is deleted recursively, some browsers emit only the folder deletion event. The adapter MUST convert that event into `delete_subtree` and must not assume it will receive a deletion event for every child.

<a id="colp-section-11-1"></a>

### 11.1 Hosts Without `reorder_children`

A host that has not implemented `reorder_children` rejects it with the non-retryable `422 unsupported_operation` (see `docs/03-sync.md` Section 6.3). An adapter that syncs with such a host does not upload `onChildrenReordered`: it updates its local projection and records a diagnostic, and it does not expand a reorder into a series of `move_node` operations. The authoritative sibling order stays the server `position` and children revision from pull.

<a id="colp-section-11-2"></a>

### 11.2 Sync Scenarios and Problem Codes

UIs and workers key off the codes in `09-problem-registry.md` and receipt reasons; they do not parse the English `title` or `detail` or exception text. New codes go through the registry; this table does not invent codes.

| Scenario | Code |
|---|---|
| Parent not ready | `node_ancestry_unresolved` / `dependency_failed` |
| Conflict | `revision_conflict` plus `conflictId` |
| Cursor expired | `sync_cursor_expired` / `snapshot_expired` |
| Over budget | `payload_too_large` / `rate_limited` |
| Replica invalid | `stale_replica` / `replica_retired` |
| Purged | `resource_purged` |
| Read-only | `node_read_only` |

On the wire, "parent not ready" is also the `deferred` receipt reason `dependency_pending` (`03-sync.md` Section 6); that reason is not a registry code.

`node_ancestry_unresolved` and `invalid_node_constraints` are the helper denials described in the registry notes; hosts use those spellings for mount-role uniqueness and ancestry preflight so that every consumer shares one code table.

Local-only signals (not wire codes): permission loss, the `root_role_materialized` warning, duplicate candidates and match reports, and the extension `rootStatus` values `permission_required`, `root_missing`, `nested_normalized`, `tree_unavailable`, and `corrupt`.

<a id="colp-section-12"></a>

## 12. Loop Prevention

- For remote operations, the adapter should record `opId → nativeMutation`.
- When the corresponding browser event arrives later, it is marked as an `echo` and must not be uploaded again as a new operation.
- When no direct association is possible, use a short-lived fingerprint: the Node ID map, a field digest, the parent, the index, and a time window.
- A fingerprint can only be used for loop detection, never as a long-term identity.

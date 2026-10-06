# 06. Browser Bookmark Compatibility and Mapping

## 1. 兼容目标

首版必须覆盖：

- Chrome、Edge、Brave、Opera 等 Chromium 系浏览器。
- Firefox WebExtensions Bookmarks API。
- Netscape Bookmark HTML 导入导出格式。
- Safari 通过 Import / Export 或平台 Native Bridge 的适配。

浏览器收藏夹模型是协议的最低公共能力，不是协议能力上限。

## 2. Chromium 映射

Chromium BookmarkTreeNode 的真实核心字段包括：

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

映射表：

| Chromium | Collection Protocol | 说明 |
|---|---|---|
| `id` | `sourceRefs.nativeId` | 不作为协议主 ID |
| `parentId` | `sourceRefs.nativeParentId` + 映射后的 `parentId` | 需要本地 ID Map |
| `index` | `sourceRefs.nativeIndex` | 协议顺序以 `position` 为准 |
| `title` | `title` | 原样保留 |
| `url` | `url` | 原样保留 |
| `children` | 扁平 Node + `parentId` | 导入时展开 |
| `dateAdded` | `createdAt` | 毫秒转 RFC 3339，原值仍保留 |
| `dateGroupModified` | `childrenModifiedAt` | 仅 Folder |
| `dateLastUsed` | `lastUsedAt` | Chrome 114+ |
| `folderType` | `folderRole` | bookmarks-bar / other / mobile / managed |
| `syncing` | `sourceRefs.syncing` | 只表示浏览器内建账号同步 |
| `unmodifiable=managed` | `constraints.readOnly=true` | 禁止向浏览器写回 |

### 2.1 Chromium 限制

- 扩展不能在根节点直接创建或删除条目。
- 书签栏、其他书签等特殊根目录不能重命名、移动或删除。
- `update()` 通常只支持 `title` 和 `url`。
- Chromium API 不支持 Separator。
- 浏览器原生模型不支持 Tag、Note、Annotation、Relation、Alias 和附件。

因此 Chromium Adapter 必须维护 Sidecar Store：

```text
native bookmark tree        浏览器权威字段
local adapter database      协议 ID、SourceRef、Note、Tag、同步游标
remote Collection server    完整扩展字段和公共策略
```

浏览器中合法但不可公开的 `file:`、`about:`、`chrome:`、`edge:`、`moz-extension:` 等 URL 使用 `$defs.bookmarkUrl` 原样进入权威 / Sync 表示；只有 Mount `acceptedSchemes` 允许时才可写入目标浏览器，且不得进入 Publication / Feed。

<a id="colp-section-3"></a>

## 3. Firefox 映射

Firefox BookmarkTreeNode 与 Chromium 接近，但显式支持：

- `type=bookmark`
- `type=folder`
- `type=separator`

映射表：

| Firefox | Collection Protocol |
|---|---|
| `type=bookmark` | `kind=bookmark` |
| `type=folder` | `kind=folder` |
| `type=separator` | `kind=separator` |
| 其余树字段 | 与 Chromium 相同 |

Firefox 批量异步 Create / Move 可能导致 Index 在操作完成前变化。Adapter MUST 按顺序等待写入完成，或在批次结束后重新读取整个受影响 Folder。

<a id="colp-section-4"></a>

## 4. Netscape Bookmark HTML

协议 SHOULD 支持常见的 `NETSCAPE-Bookmark-file-1`：

```html
<DL><p>
  <DT><H3 ADD_DATE="..." LAST_MODIFIED="...">Folder</H3>
  <DL><p>
    <DT><A HREF="https://example.com" ADD_DATE="..." ICON="data:image/png;base64,...">Example</A>
  </DL><p>
</DL><p>
```

映射：

| HTML | Protocol |
|---|---|
| `<H3>` | Folder Node |
| `<A HREF>` | Bookmark Node |
| 嵌套 `<DL>` | Parent / Child |
| 文档顺序 | Position |
| `ADD_DATE` | CreatedAt |
| `LAST_MODIFIED` | UpdatedAt / ChildrenModifiedAt |
| `ICON_URI` | HTTP(S) Favicon Attachment |
| `ICON=data:` | 解码并物化到受控 Blob / 对象存储；否则保留在来源 Extension |
| `PERSONAL_TOOLBAR_FOLDER` | folderRole=bookmarks-bar |
| 未知属性 | Netscape Extension Namespace |

未知属性示例：

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

导出时，如果目标格式不支持 Note 或 Annotation，适配器不得擅自拼接到标题。可以：

1. 生成并列 Sidecar JSON。
2. 使用明确启用的 HTML Extension Attribute。
3. 返回有损转换报告。

<a id="colp-section-5"></a>

## 5. Safari

Safari 没有与 WebExtensions bookmarks API 完全等价的跨平台实时接口。首版定义两种适配级别：

- `safari-import-export`：通过 Safari 导出的书签文件或可读数据文件导入。
- `safari-native-bridge`：由 macOS 原生 Helper 在用户授权范围内读取与写入。

Safari Adapter MUST 在 Sync Session 的 Replica Capability 中声明；公共 HTTP Manifest 只声明服务器 Profile，不承载本地 Adapter 状态：

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

没有实时事件能力时，适配器使用定期 Snapshot Diff，但必须遵守服务端与本地配置的最小扫描间隔。

<a id="colp-section-6"></a>

## 6. 特殊根目录

适配器 MUST 建立 Root Mapping，不得依赖浏览器 ID 固定值：

| Browser role | Protocol role |
|---|---|
| Root | root |
| Bookmarks Bar / Toolbar | bookmarks-bar |
| Other Bookmarks / Menu | other-bookmarks |
| Mobile Bookmarks | mobile-bookmarks |
| Managed Bookmarks | managed-bookmarks |

若目标浏览器没有某个 Root Role：

- 默认映射到 `other-bookmarks` 下的同名 Folder。
- 产生 `root_role_materialized` Warning。
- 不得将 Managed 内容写入可编辑目录，除非用户显式选择“复制为普通书签”。

<a id="colp-section-6-1"></a>

### 6.1 Collection 所有权边界

浏览器 Profile 通常只有一棵全局书签树。Adapter 必须选择并持久化以下模式之一：

- `whole-profile`：一个 Collection 独占整个浏览器 Profile；其他 Collection 不得绑定同一 Profile。
- `mounted-folder`：每个 Collection 绑定到一个明确 Native Folder，读取、写入、Reconcile 和 Delete 不得越过该 Folder 边界。

Sync Session 必须携带 Browser Profile、Mount Mode、Mount Native ID 和 Generation。未建立所有权边界时不得开始双向同步。

<a id="p0-whole-profile-mount-mode"></a>

#### Know-N P0 whole-profile Mount Mode

Know-N P0 Session `replica.binding` uses `mountMode = 'whole-profile'` and `mountNativeId = null`.

Reasons:

1. One browser Profile binds one Collection, matching this section's `whole-profile` definition.
2. Multiple browser special roots map to mount Folders under that Collection; a single `mountNativeId` cannot name them.
3. Backend does not persist `mountNativeId`, so `mounted-folder` plus a sentinel native id gives no server-side boundary.

The rejected alternative (`mounted-folder` plus Chrome root `'0'`) stays unused unless a later KNS-00 review explicitly rejects this choice. Already-registered `mounted-folder` Replicas are not rewritten in place; remount uses drain then retire/archive then a new generation (KNS-01).

This note does not tighten the 0.1 `replicaBinding` schema: other hosts may still send `whole-profile` with a non-null `mountNativeId`. Know-N P0 sends `null`.

<a id="p0-kns-06-restore-and-create-collection-schedule"></a>

#### Know-N W0 restore and collection-create schedule

Canonical `restore_node` mutation and `POST /colp/v0.1/sync/collections` landed in KNS-06. This W0 gate originally recorded that schedule; this document still does not add those Backend routes.

<a id="p0-sync-create-folder-role-allow-list"></a>

#### Know-N P0 Sync create folderRole allow-list

Sync `create_node` of a Collection-root **direct child Folder** may use:

- `bookmarks-bar`
- `other-bookmarks`
- `mobile-bookmarks`
- `custom`
- `recovered`

`managed-bookmarks` keeps the existing capability gate and stays read-only by default. Clients do not create `root`, `archive`, or `inbox`.

Each Collection has at most one live Folder per special root role (`bookmarks-bar`, `other-bookmarks`, `mobile-bookmarks`). A second concurrent create for the same root role leaves exactly one live mount; the later receipt is `rebased`, carries the existing mount `nodeId`, and surfaces existing registry code `invalid_node_constraints`. `custom` mounts are distinguished by `extensions.customSourceKey` and do not use that root-role uniqueness rule.

`recovered` is unique per live parent: at most one live `folderRole=recovered` Folder under a given parent (the owning mount, or the Collection root fallback when that mount is gone). A second concurrent create under the same parent is `rebased` with `invalid_node_constraints`. Recovered Folders created for different mounts MUST remain distinct. Clients MUST NOT guess `bookmarks-bar` when the owning mount cannot be confirmed.

KNS-06 implements the Backend constraint; KNS-00 locks the wire/semantic with fixtures.

## 7. 有损转换规则

每次转换返回：

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

标准 Warning Code：

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

## 8. Alias

浏览器原生书签树不支持 Alias。适配策略：

- `duplicate`：在每个位置创建独立原生 Bookmark，多个 SourceRef 指向各自 Native ID。
- `skip`：只保留服务器 Alias，客户端不显示。
- `reject`：阻止该 Collection 同步到此浏览器。

默认使用 `duplicate`，并在回传时通过 Sidecar 或命名空间 Extension 中的 `aliasGroupId` 避免误判为普通重复项。`aliasGroupId` 不是核心 Node 字段。用户编辑物化副本时，Adapter 默认将该副本显式 Detach 为普通 Bookmark；不得静默修改全部 Alias。

<a id="colp-section-9"></a>

## 9. Separator

- Firefox 可原生往返。
- Netscape HTML 可使用 `<HR>` 或来源扩展规则。
- Chromium 默认不物化，但保留服务器对象。
- 客户端 UI MAY 用视觉分隔线显示服务器 Separator，即使浏览器管理器中不可见。

<a id="colp-section-10"></a>

## 10. Note、Tag 与其他附加信息

浏览器原生 API 不提供这些字段时：

- Adapter MUST 写入本地 Sidecar。
- Sidecar 使用协议 Node ID 作为主键，Native ID 只作索引。
- 浏览器 Node 被删除后，Sidecar 记录进入与 Tombstone 相同的保留流程。
- 用户卸载扩展前 SHOULD 提供导出 Sidecar 的入口。

Sidecar 还必须具备故障安全合同：

- 持久化 `(browser, profile, collectionId, nodeId, nativeId, generation)`。
- 执行 Native Mutation 前先写 Mutation Journal，成功后再提交 Mapping / Cursor。
- 启动、事件缺口或异常终止后执行 Reconcile。
- Sidecar 丢失、Generation 不匹配或 Native ID 大量重用时进入 Safe Mode，禁止上传 Delete / Move，直到全量 Diff 被确认并重新建立 Mapping。
- 提供自动备份与恢复；“卸载前手动导出”不能是唯一恢复方式。

<a id="colp-section-11"></a>

## 11. 事件转换

浏览器事件映射：

| Browser event | Sync Operation |
|---|---|
| onCreated | create_node |
| onChanged | update_node_content |
| onMoved | move_node |
| onChildrenReordered | reorder_children |
| onRemoved | delete_node |
| onImportBegan | Adapter 本地开始 Mutation Journal，不上传协议 Operation |
| onImportEnded | Adapter 本地 Reconcile，随后只上传标准 Operation Batch |

递归删除 Folder 时，某些浏览器只发 Folder 删除事件。Adapter MUST 将该事件转换为 `delete_subtree`，不得假设会收到每个 Child 的删除事件。

## 12. 回环防止

- Adapter 对远端 Operation 应记录 `opId → nativeMutation`。
- 随后收到对应浏览器事件时，将其标记为 `echo`，不得重新上传为新 Operation。
- 无法直接关联时，使用短期 Fingerprint：Node ID Map、字段摘要、Parent、Index 和时间窗口。
- Fingerprint 只能用于回环检测，不得作为长期身份。

<a id="p0-reorder-children-handling"></a>

#### Know-N P0 reorder_children handling

P0 does **not** upload `onChildrenReordered` as a `reorder_children` Operation. The adapter updates the local projection and records a diagnostic. It does not expand reorder into a series of `move_node` Operations. Authoritative sibling order remains the server `position` / children revision from Pull.

Backend still treats `reorder_children` as `unsupported_operation` until a later protocol host implements it. KNS-00 fixtures lock “unselected range / local-only reorder → no operations”.

<a id="p0-scenario-problem-code-map"></a>

#### Know-N P0 scenario to problem-code map

UI and workers key off these existing `09-problem-registry.md` codes (and receipt reasons). They do not parse English `title` / `detail` / exception text. New codes go through the registry; this table does not invent codes.

| Scenario | Code |
|---|---|
| Parent not ready | `node_ancestry_unresolved` / `dependency_failed` |
| Conflict | `revision_conflict` plus `conflictId` |
| Cursor expired | `sync_cursor_expired` / `snapshot_expired` |
| Over budget | `payload_too_large` / `rate_limited` |
| Replica invalid | `stale_replica` / `replica_retired` |
| Purged | `resource_purged` |
| Read-only | `node_read_only` |

Parent-not-ready on the Wire is also a `deferred` receipt reason `dependency_pending` (`03-sync.md` §6). That reason is not a new registry code.

`node_ancestry_unresolved` and `invalid_node_constraints` are helper denials in the registry notes; Know-N still uses those spellings for mount-role uniqueness and ancestry preflight so consumers share one code table.

Local-only (not Wire codes): permission loss, `root_role_materialized` warning, duplicate candidates / match-report, extension `rootStatus` values `permission_required`, `root_missing`, `nested_normalized`, `tree_unavailable`, `corrupt`.

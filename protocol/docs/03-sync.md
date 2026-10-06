# 03. Synchronization Protocol

## 1. 目标

同步子协议用于浏览器插件、桌面客户端、Web 应用、个人服务器和其他可信副本之间的双向复制。

本章为突出流程而使用的 `{}` 表示“嵌入对应完整对象”，不是可发送的空对象。可执行 Wire 示例位于 `examples/sync-*.json`，端点请求与响应必须按 `docs/10-implementation-contract.md` 的命名 `$defs` 校验。

它必须处理：

- 首次同步。
- 离线编辑与恢复联网。
- 多设备并发。
- 浏览器字段与协议字段转换。
- 移动、重排和递归删除。
- 幂等重试。
- 冲突暴露与解决。
- Tombstone 与旧副本复活问题。

<a id="colp-section-1-1"></a>

### 1.1 一致性选择

首版采用“服务器权威 Operation Log + 字段级合并 + 显式 Conflict”，不采用全量 CRDT 作为 Wire Model。

原因：

- 浏览器 API 本身是有序树与事件流，不暴露 CRDT 标识。
- ACL、公开性、Key、删除和 Managed Node 需要明确的服务器授权顺序。
- Title、URL、私人 Note 等冲突通常需要用户选择，而不是自动收敛后隐藏歧义。
- 服务器生成 Position 可以解决绝大多数并发插入与移动问题。

实现内部 MAY 使用 CRDT，但 Wire 行为必须符合本文的 Operation、Revision、Conflict 和 Tombstone 语义。

## 2. Replica

每个独立同步副本有稳定 `replicaId`：

```json
{
  "replicaId": "019b3dd0-7636-770a-a789-bf62d3eb91cc",
  "name": "Chrome on Alice's laptop",
  "kind": "browser_extension",
  "adapter": {
    "profile": "chromium-bookmarks-v1",
    "version": "1.0.0"
  },
  "capabilities": {
    "read": true,
    "write": true,
    "events": true,
    "separator": false,
    "alias": false,
    "annotations": "sidecar",
    "maxBatchOperations": 200
  },
  "binding": {
    "browserProfileId": "profile-hmac-1",
    "mountMode": "mounted-folder",
    "mountNativeId": "431",
    "generation": "generation-7"
  }
}
```

- Replica ID 首次安装时生成，重启后保持。
- 重装后不得复用旧 Replica ID，除非恢复了完整本地同步数据库。
- Replica Secret / Token 不得包含在 Replica 对象中。

## 3. Local State

客户端至少持久化：

- Replica ID。
- 每个 Collection 的最后 Pull Cursor。
- 每个协议 Node ID 与 Native ID 的映射。
- 本地 Operation Queue。
- 已提交但未 Ack 的 Operation。
- Tombstone 与 Conflict。
- Adapter Conversion Warning。
- 最近处理的远端 Op ID，用于回环检测。

仅把 Cursor 存入浏览器内存不符合 Sync Client 要求。

## 4. Session Negotiation

<!-- COLP-REQ SYNC-0007 -->

<!-- COLP-REQ SYNC-0001 -->

`POST /collections/-/sync/sessions`

```json
{
  "protocolVersion": "0.1",
  "replica": {},
  "scope": "collection",
  "collection": {
    "collectionId": "collection-1",
    "lastCursor": "sync_01JZ...",
    "lastRevision": "r_1020",
    "bootstrapMode": "merge"
  },
  "clientTime": "2026-07-16T07:00:00Z"
}
```

空实例没有可绑定的 Collection。客户端需要通过 Sync 创建第一个 Collection 时，使用 Instance-scoped Session：

```json
{
  "protocolVersion": "0.1",
  "replica": {},
  "scope": "instance",
  "purpose": "create_collection",
  "clientTime": "2026-07-16T07:00:00Z"
}
```

`bootstrapMode`：

- `download`：服务器覆盖本地受管范围。
- `upload`：本地树作为初始来源，服务器已有数据需显式处理。
- `merge`：两端均保留，执行 ID Mapping、查重和冲突生成。
- `mirror`：服务器为权威，本地额外内容可删除。必须额外确认。

响应：

```json
{
  "sessionId": "syncsess_01JZ...",
  "expiresAt": "2026-07-16T08:00:00Z",
  "serverTime": "2026-07-16T07:00:01Z",
  "clockSkewMilliseconds": 1000,
  "acceptedProtocolVersion": "0.1",
  "scope": "collection",
  "maxBatchOperations": 200,
  "tombstoneRetentionSeconds": 2592000,
  "replicaLease": {
    "leaseId": "lease_01JZ...",
    "generation": "leasegen_7",
    "state": "active",
    "lastSeenAt": "2026-07-16T07:00:01Z",
    "expiresAt": "2026-08-15T07:00:01Z",
    "acknowledgedCursor": "sync_01JZ..."
  },
  "collection": {
    "collectionId": "collection-1",
    "snapshotRequired": false,
    "serverCursor": "sync_01K0...",
    "serverRevision": "r_1042"
  },
  "conversionPolicy": {
    "alias": "duplicate",
    "separator": "preserve_remote",
    "unknownExtensions": "preserve_remote"
  }
}
```

0.1 的普通模式是一 Session 一 Collection。这样 Cursor、Revision、授权域、原子 Batch 和 Tombstone Ack 都只有一个明确作用域。多 Collection Session 只有在 Manifest 声明 `features.sync.multiCollectionSessions=true` 时才可使用，并且必须提供 Collection Revision Vector；客户端不能假定其存在。

Instance-scoped Session 是唯一例外，并且必须同时满足以下限制：

- `purpose` 只能是 `create_collection`，Principal 必须同时具有 `sync:bootstrap`、`sync:push` 和 `collections:create`。
- Session 尚未绑定 Collection 时，只接受一个 `atomic=true`、只含一个 `create_collection` 的 Batch。该 Operation 的 `sequence` 必须为 1，`collectionId` 和 `targetId` 必须省略，`baseRevision` 必须为 `null`。
- `applied` 后服务器在同一事务内生成 Collection 与 Root、写入 Operation / Sequence Receipt / Cursor，并在结果的 `boundCollection` 返回生成的 `collectionId`、Revision 和 Cursor。原 Session 随即转为 Collection-scoped，后续该 Collection 的 Expected Sequence 为 1；Instance lane 的 Sequence 不与新 Collection lane 混用。
- `deferred` 保持 Instance Session 未绑定，客户端必须用同一 Operation 重试。`rejected` 消费 Instance Sequence 并终止该 Session；修正后的请求必须创建新的 Instance Session。
- 服务器不得允许 Instance Session 执行读取、更新、删除、Release 或第二次创建，也不得让客户端预占 Collection ID。

Session ID 不是认证凭据。服务器必须把它绑定到 Principal、Token / Key ID、OAuth Client、Origin、Session Scope 和协议版本；Collection-scoped 或已完成创建的 Session 还必须绑定生成的 Collection。撤权或 Scope 降级时立即终止 Session 与订阅。

## 5. Bootstrap

### 5.1 空服务器、已有浏览器树

1. Adapter 读取完整浏览器树。
2. 生成协议 ID 与 SourceRef。
3. 创建 `scope=instance`、`purpose=create_collection` 的 Session，并原子创建 Collection 与 Root Role Mapping。
4. 以 Snapshot Import 或 Create Operation Batch 上传。
5. 服务端返回主 ID / Revision / Cursor。
6. 客户端持久化映射和 Cursor。

### 5.2 已有服务器、空浏览器树

1. 下载 Sync Snapshot。
2. 执行 Conversion Preview。
3. 用户确认有损项和 Managed Root 行为。
4. 按父目录顺序写入浏览器。
5. 建立 SourceRef Mapping。
6. Ack Snapshot Cursor。

### 5.3 两端已有数据

Merge 匹配顺序：

1. 已存在 SourceRef Native Mapping。
2. 协议 ID 嵌入或 Sidecar Mapping。
3. 同 Parent、同 URL、同 Title 的严格匹配。
4. Canonical URL + 可配置时间窗口的候选匹配。
5. 无法确定时创建独立 Node，并返回 Duplicate Candidate，不自动合并。

模糊匹配不得直接删除任一对象。

## 6. Operation Envelope

```json
{
  "opId": "019b3de2-7f76-7b8b-8ffc-941d6e6318dd",
  "replicaId": "019b3dd0-7636-770a-a789-bf62d3eb91cc",
  "sequence": 1842,
  "collectionId": "collection-1",
  "type": "move_node",
  "targetId": "node-9",
  "baseRevision": "r_1041",
  "occurredAt": "2026-07-16T07:05:00Z",
  "dependencies": ["019b3de1-..."],
  "payload": {
    "newParentId": "folder-4",
    "afterId": "node-7",
    "beforeId": null,
    "baseSourceParentRevision": "children_r_8",
    "baseTargetParentRevision": "children_r_9"
  },
  "source": {
    "adapterProfile": "chromium-bookmarks-v1",
    "nativeEvent": "onMoved"
  }
}
```

<a id="colp-section-6-1"></a>

### 6.1 幂等性

<!-- COLP-REQ SYNC-0002 -->

- `(replicaId, sequenceScope, sequence)` MUST 唯一。普通 Session 的 `sequenceScope` 是 `collectionId`；尚未绑定的 Instance Session 使用 `sessionId` 作为临时 Sequence Scope。
- `sequence` 从 1 开始，在单 Replica、单 Sequence Scope 内连续递增，不得复用或跳号。不同 Collection 的 Sequence 独立，避免一个离线队列阻塞其他 Collection。
- `opId` 在 `serverUuid` 生命周期内唯一；客户端 SHOULD 使用 UUIDv7 以降低跨服务器迁移碰撞风险。
- 服务器必须持久化 Canonical Request Digest 与完整 `operationResult`。相同 `(replicaId, sequenceScope, sequence)` 或 `opId` 的相同请求重试时，必须逐字段返回已持久化的原结果，不得再次执行，也不得用信息更少的 `duplicate` 状态代替。
- HTTP 重试同时使用 `Idempotency-Key`，其值可等于 Batch ID。
- 同一 `(replicaId, sequenceScope, sequence)` 或 `opId` 携带不同 Canonical Request Digest 时，服务器 MUST 返回 `409 sequence_reuse` / `op_id_reused` 并审计。
- 收到大于 Expected Sequence 的 Operation 时返回 `409 sequence_gap` 与 `expectedSequence`；客户端必须补齐或重新 Bootstrap，服务器不得按到达顺序猜测。
- Batch ID / Idempotency Key 必须绑定 Principal、Endpoint 和请求摘要；相同 Key 不同 Body 返回 `409 idempotency_key_reused`。

Sequence Receipt 状态机：

| Result | 是否终态 | 是否消费 Sequence | Cursor |
|---|---:|---:|---|
| `applied` / `rebased` | 是 | 是 | 必须产生；目标资源发生权威变更 |
| `noop` | 是 | 是 | 不得产生；没有权威状态变化 |
| `conflicted` | 是 | 是 | 必须产生；目标资源不变，但持久化 Conflict 并进入 Pull 顺序 |
| `rejected` | 是 | 是 | 不得产生；修正后必须使用下一个 Sequence |
| `deferred` | 否 | 否 | 不得产生；保留当前 Expected Sequence |

`deferred` 是唯一非终态。服务器必须保存其 Digest、原因与当前结果；原因未解除时相同重试返回同一结果，原因解除后同一 Operation 可以从 `deferred` 原子转换为一个终态。存在 Deferred Receipt 时，该 Replica 在同一 Sequence Scope 的更大 Sequence 一律返回 `409 sequence_blocked` 和当前 `expectedSequence`，不得越过执行。

只有 `rejected` 与 `deferred` Result 携带必需的机器可读 `code`；只有 `deferred` MAY 携带 `retryAfterSeconds`。`applied` / `rebased` 不得携带 `conflictId`，`conflicted` 必须携带持久化的 `conflictId` 与 Cursor。相同 Sequence 重试时这些字段也必须逐字段保持不变。

### 6.2 Operation Type

Collection：

- `create_collection`
- `update_collection_metadata`
- `delete_collection`
- `restore_collection`
- `publish_release`

Node：

- `create_node`
- `update_node_content`
- `move_node`
- `reorder_children`
- `delete_node`
- `delete_subtree`
- `restore_node`

附加信息：

- `create_annotation`
- `update_annotation`
- `delete_annotation`
- `create_attachment`
- `update_attachment`
- `delete_attachment`
- `create_relation`
- `update_relation`
- `delete_relation`

管理类 ACL、Key、Rate Limit 不进入普通书签 Sync Log，使用独立管理审计流。

<a id="colp-section-6-3"></a>

### 6.3 Payload 与并发边界

<!-- COLP-REQ SYNC-0003 -->

- `create_*` 使用专用 Create DTO，`baseRevision=null`。
- 修改已有对象的 Operation MUST 提供 `targetId` 与 `baseRevision`。
- Update Operation 使用资源专用 Payload，包含客户端观察到的 `base` 与期望的 `value`。服务器在 Schema 校验后 MUST 确认 `base` 与 `value` 包含完全相同的自有字段集合并执行跨对象键集合语义检查，不相等时返回 `422 invalid_document`；JSON Schema 负责限制可用字段名。
- 服务器 MUST 以 Base / Current / Incoming 执行确定性三方合并，因此不能通过 JSON Pointer 修改服务器管理字段、原型属性或绕过 Move / Reorder 并发边界。

```json
{
  "base": {
    "title": "Old title",
    "tags": ["a", "b"]
  },
  "value": {
    "title": "New title",
    "tags": ["b", "c"]
  }
}
```
- `update_collection_metadata` 使用 `collectionMetadataUpdateOperationPayload` 和 `collectionMergePatch`，需要 `collections:write`；将 Visibility 改为 `public` / `unlisted` 还需要 `access:write` 和与 HTTP 相同的高风险审批。
- `update_node_content` 使用 `nodeContentUpdateOperationPayload` 和 `nodeMergePatch`，需要 `nodes:write`。`kind`、`parentId`、`position`、`sourceRefs`、ID、Revision 和时间字段在 Schema 中不可表达；Parent / Position 只能由 `move_node` / `reorder_children` 修改。
- `update_annotation`、`update_attachment`、`update_relation` 分别使用各自的 Typed Payload 与 `annotations:write`、`attachments:write`、`relations:write`。
- 普通 Sync Log 不接受 `set_access_policy`、Key 或 Rate Limit 操作；它们继续使用管理 API、独立审计流和对应管理 Scope。
- `move_node` 使用 `newParentId`、`afterId`、`beforeId`、`baseSourceParentRevision` 和 `baseTargetParentRevision`。同 Parent 重排时两个 Revision 相同，跨 Parent Move 时分别保护源 Children Set 与目标 Children Set。
- Tag 的 Observed Remove 从 `base.tags` 与 `value.tags` 集合差推导；只有 Base 中已观察到的成员可以删除。Current 中由其他 Operation 新增且不在 Base 的成员必须保留。无法证明观察关系时生成 Conflict，不能按普通数组覆盖。
- 未知 Operation Type 必须拒绝或版本协商，不能用开放 `payload` 猜测执行。
- Schema 合法但宿主尚未实现的 Operation Type 必须返回非重试的 `422 unsupported_operation` Problem，且不得创建 Sequence Receipt、推进 lane 或产生任何 mutation。

## 7. Push

<!-- COLP-REQ SYNC-0004 -->

`POST /collections/-/sync/push`

```json
{
  "sessionId": "syncsess_01JZ...",
  "batchId": "batch_01JZ...",
  "atomic": false,
  "operations": [
    {
      "opId": "op_update_1842",
      "replicaId": "replica_laptop",
      "sequence": 1842,
      "collectionId": "collection-1",
      "type": "update_node_content",
      "targetId": "node-9",
      "baseRevision": "r_1041",
      "occurredAt": "2026-07-16T07:05:00Z",
      "dependencies": [],
      "payload": {
        "base": { "title": "Old title" },
        "value": { "title": "New title" }
      }
    }
  ]
}
```

响应：

```json
{
  "batchId": "batch_01JZ...",
  "results": [
    {
      "opId": "op_update_1842",
      "sequence": 1842,
      "status": "applied",
      "targetId": "node-9",
      "revision": "r_1043",
      "cursor": "sync_01K0...",
      "warnings": []
    }
  ],
  "serverCursor": "sync_01K0..."
}
```

Status：

- `applied`
- `rebased`
- `noop`
- `conflicted`
- `rejected`
- `deferred`

`atomic=true` 时，服务器必须先完成 Scope、Sequence、Dependency、Schema、授权和前置条件预检；任一项不能成立时，整个请求返回 Problem，所有 Sequence 保持未消费。进入事务后，业务状态、Canonical Operation、Sequence Receipt、Conflict、Cursor、Audit 与 Outbox 必须全部提交或全部回滚。任何 Operation 不能达到可提交终态时，整个事务回滚，不得返回看似已消费的逐项结果。服务器不支持所需原子边界时必须拒绝，而不能部分提交。

`atomic=false` 时服务器按数组顺序处理，每个 Operation 各自在上述完整事务边界内提交。Batch 内 Dependency 必须指向已经达到终态的 Operation 或数组中更早的 Operation；依赖尚未达到终态时当前 Operation 返回 `deferred` / `dependency_pending`，不得越过依赖执行。依赖已经 `rejected` 时当前 Operation 可以终态 `rejected` / `dependency_failed` 并消费自己的 Sequence。事务失败时该 Operation 的资源状态、Receipt、Cursor 和审计提交全部回滚，客户端可安全重试相同 Sequence。

## 8. Pull

<!-- COLP-REQ SYNC-0005 -->

`GET /collections/-/sync/pull?sessionId=syncsess_...&cursor=sync_...&limit=200`

```json
{
  "events": [
    {
      "cursor": "sync_01K1...",
      "kind": "operation",
      "operation": {}
    }
  ],
  "nextCursor": "sync_01K1...",
  "hasMore": false,
  "collectionRevision": "r_1050",
  "recommendedPullAfterSeconds": 30
}
```

规则：

- Pull 可以返回来源于当前 Replica 的已接受 Operation，客户端通过 Op ID 识别 Echo。
- 服务器不得只按时间过滤当前 Replica，因为其他副本可能基于其操作生成 Transform。
- Cursor 过期返回 `410 sync_cursor_expired` 与 Snapshot URL。
- Pull 响应顺序是服务器提交顺序。
- Operation 与 Conflict 使用同一个 `events` 序列，才能表达真实交错提交顺序。客户端必须按 Event 顺序应用，除非事件明确无依赖且客户端实现可证明安全。
- Cursor 必须绑定 Session、Principal、Collection 和协议版本；跨上下文使用返回 `400 invalid_cursor_scope`。
- Pull 必须先完整验证请求 Cursor 的签名、有效期、Session/Principal/Collection、协议版本、策略、页面大小与
  authority handoff 证据。验证完成后，若 `events` 为空，`hasMore` 必须为 `false`，且 `nextCursor` 必须与请求
  `cursor` 字节级完全相同；服务器不得重签、延长有效期或借 key rotation 改变 token。首次 Pull 未携带
  `cursor` 时不适用该 identity 规则：服务器必须签发一个绑定当前 Session 与初始 exclusive tuple 的
  `nextCursor`。非空页的 `nextCursor` 必须等于最后一个 event 的 `cursor` 并推进 exclusive tuple；携带事件却
  保持原 tuple/Cursor 必须拒绝。跨 Session 的 durable handoff 仍须先验证旧 authority lineage；空页继续 echo
  输入 token，直到非空页通过 event cursor 显式进入新 Session authority，或 Session 协商通过明确的
  `serverCursor` rebase 在 Pull 前完成切换。

<a id="colp-section-8-1"></a>

### 8.1 COLP 0.2 Authoritative Pull Effect

<!-- COLP-REQ SYNC-0027 -->

COLP 0.1 的 `syncPullEvent` 保持原样：operation event 只包含 `cursor`、`kind` 和原始
`operation`，并且必须拒绝 `effect`。支持本节的服务器在 Manifest `protocolVersions` 中同时
声明 `0.1` 和 `0.2`，客户端在 Session request 明确请求一个版本，服务器只能在
`acceptedProtocolVersion` 回显该版本或以版本协商 Problem 拒绝。Session、Pull cursor 和 Pull
representation 必须绑定 accepted version；不得在 0.1 Session 下发送 0.2 event。

COLP 0.2 的 operation event MUST 同时携带原始 Operation 和不可变 `effect`。effect 必须绑定
Operation 的 `opId`、`replicaId`、`sequence`、`collectionId` 和 canonical Operation digest；event
`cursor` 仍然绑定接收 Replica 的 Session，不得复用 source Replica 的 Push result cursor。
删除 effect 内 Sync Tombstone 的 `deleteCursor` 是服务端持久化的 stable mutation/source cursor，
属于不可变 effect 和 `effectDigest`；它不得改写为 receiver-bound event `cursor`。同一 effect 可由多个
Replica 在不同 Session cursor 下读取，receiver 进度只由 event `cursor` 表达。
`operationDigest` 和 `effectDigest` 使用 RFC 9530 `sha-256=:base64:` 格式。Operation digest 输入是
完整 Operation 的 canonical I-JSON；effect digest 输入是删除 `effectDigest` member 后的完整 effect
canonical I-JSON。对象 member 按 UTF-16 code unit 升序，数组保持 Wire 顺序，UTF-8 编码后计算 SHA-256。

只有 `applied` 和 `rebased` mutation 可以进入 operation stream。`noop`、`rejected`、`deferred`
不得产生 mutation event；`conflicted` 只产生独立 Conflict event。Conflict resolution 成功时必须
创建新的 applied Operation 和匹配 effect，不能把原 conflicted Operation 改写成 mutation。

effect 是按 Operation type 封闭的 union：

| Operation | effect kind | 必需 authority |
|---|---|---|
| `create_node` | `node_created` | 完整最终 Node（含服务器 ID/revision）、placement、parent children revision，以及新 Folder 自身的 children revision（非 Folder 为 `null`） |
| `update_node_content` | `node_content_updated` | merge/rebase 后的完整最终 Node 和 revision |
| `move_node` | `node_moved` | 完整最终 Node、parent/anchors/position、source/target children revisions |
| `delete_node` | `node_deleted` | deletion authority、Sync Tombstone、delete revision、source parent children revision |
| `delete_subtree` | `subtree_deleted` | root Tombstone、exact members authority、member digest/count、source parent children revision |
| `restore_node` | `node_restored` | 完整最终 Node（原 ID、新 revision）、placement（原 Parent 或 `recovered` Folder）、target parent children revision、被消费的 Tombstone `deleteCursor` |

<a id="p0-restore-node-effect"></a>

`restore_node` already exists as a Sync Operation name. COLP 0.2 Pull now includes the matching `node_restored` effect so receivers apply restore from closed-union authority instead of guessing a `create_node`. After `node_restored`, Live Node and Tombstone for that ID are mutually exclusive. A purged Tombstone is `resource_purged` and is not restoreable. If the original Parent is gone, placement is the originating mount's `recovered` Folder (unique per parent). If that mount is gone, placement is the Collection-root `recovered` fallback. Receivers MUST NOT guess `bookmarks-bar`.

Know-N canonical `restore_node` mutation and `POST /colp/v0.1/sync/collections` landed in KNS-06. This protocol document still does not define those Backend routes; hosts implement them.

Pull 内联 effect 的 UTF-8 canonical representation 最大 262144 bytes、最大 JSON depth 32、最大
10000 members。subtree 的 exact member list 最多内联 512 个 ID；更大集合必须使用 immutable
`effectRef`。Manifest 的 `syncEffectPages` HTTPS URI Template 是唯一 effect-page endpoint；客户端
必须按 RFC 6570 使用当前 `effectId` 和从 1 开始的 `pageNumber` 展开该 Template，`effectRef` 不复制
或覆盖 endpoint URL。展开结果不得包含 userinfo、query credential、fragment 或跨 Manifest authority。
读取必须使用当前 Session 的正常 Authorization，URL 自身不得是
bearer capability 或携带任何 credential。

每个 effect page 最大 262144 bytes、512 个 member、JSON depth 32；整个引用最多 1024 pages、
524288 members。page number 从 1 连续递增，`pageCount`、effect ID 不变；第一页
`previousPageDigest=null`，后续页必须精确引用前一页 `pageDigest`。每页 digest 对删除 `pageDigest`
后的完整 canonical page 计算；所有 page 的 members 按页序连接后必须与 event 的 `memberCount` 和
`memberDigest` 一致。响应必须 immutable、Session-authenticated、`Cache-Control: private, no-store`；
任何缺页、乱序、重复、digest/count 不一致或预算超限都必须 fail closed，不能应用部分 mutation 或推进 cursor。

effect 可以包含所选 Collection 内正常同步所需的 Node content；不得暴露数据库主键、Principal、
credential、浏览器 native ID/profile ID、内部审计 ID 或其他 server implementation identity。
历史 Operation 不得猜测回填。0.2 deployment 必须宣告每 Collection 的 effect cutover；早于 cutover
的 cursor 返回 `sync_cursor_expired` / `recovery_required` 并要求完整 Snapshot，随后签发绑定 0.2
Session 的新 cursor。

COLP 0.2 Sync Snapshot 使用 `syncSnapshotV02`，并为本页出现的每个 Root/Folder 提供
`parentRevisions`。客户端完成所有 Snapshot 页后，必须已经获得完整树中每个可作为父节点的
children revision；`resourceRevision` 与 `childrenRevision` 是独立 authority，不能互相代替。

## 9. Ack

<!-- COLP-REQ SYNC-0009 -->

<!-- COLP-REQ SYNC-0006 -->

客户端只有在远端 Operation 已写入浏览器或本地数据库并持久化后才能 Ack：

```json
{
  "sessionId": "syncsess_01JZ...",
  "cursor": "sync_01K1...",
  "warnings": []
}
```

Ack 用于：

- 监控落后副本。
- 判断 Tombstone 是否可 Purge。
- 发现长期无法应用的转换。

服务器不得仅因一个 Replica Ack 就删除仍可能被其他活跃 Replica 需要的 Tombstone。

Replica 必须有服务端 Lease，并处于以下状态机之一：

| State | 含义 | 允许的 Sync 行为 |
|---|---|---|
| `active` | Lease 未到期，Session 身份与 Replica 绑定有效 | 可 Pull / Push / Ack；成功且已认证的 Sync 请求可续租 |
| `expired` | `expiresAt` 已过，尚未判定能否安全恢复 | 现有 Session 终止；不得 Push，只能重新协商 Session |
| `recovery_required` | Ack Cursor 已早于保留窗口，或其后已有 Tombstone 被 Purge | 只能下载权威 Sync Snapshot 并完成 Bootstrap Ack |
| `retired` | 用户或管理员显式退役 | 终态；Replica ID 永久不得再建立 Session 或 Push |

合法转换如下：

```text
new -> active
active -> expired                  (lease deadline)
active|expired -> recovery_required (cursor/tombstone window lost)
expired -> active                  (resume window still complete)
recovery_required -> active        (authoritative snapshot durably applied and acked)
active|expired|recovery_required -> retired
```

- 无效、未授权或失败请求不得续租。Session `expiresAt` 与 Replica Lease `expiresAt` 是两个独立期限；创建新 Session 不得自动绕过 Lease 恢复检查。
- `expired` Replica 重新协商时，服务器必须比较其持久化 Ack Cursor、当前最早可 Pull Cursor 和 `purgedThroughCursor`。窗口完整时可恢复为 `active`；否则转为 `recovery_required` 并返回 `410 stale_replica` 与 Snapshot URL。
- `recovery_required` Replica 的旧 Queue 不得直接 Push。客户端必须先下载绑定 Revision/Cursor 的权威 Snapshot，重建本地映射，处理或导出未同步本地修改，再持久化 Snapshot Ack。服务器只有在该 Ack 与新 Lease Generation 原子提交后才能恢复 `active`。
- `retired` 不可撤销。需要继续同步时必须注册新 Replica ID；旧 Replica 的 Operation、Receipt 与 Audit 仍按保留策略可查。
- 只有 `active` Replica 参与 Tombstone Ack 阻塞。`expired` / `recovery_required` 不阻塞 Purge，但恢复为 `active` 前必须经过上述窗口检查；`retired` 同样不阻塞 Purge，并且永不恢复。

Sync Tombstone 只有同时满足以下条件才可 Purge：

1. 已超过 Manifest 的最短 Tombstone 保留期。
2. 全部 `active` Replica 已 Ack 到不早于删除 Event 的 Cursor，并且 Ack 前已消解本地 Queue 中针对该删除范围的旧 Operation。
3. 服务端已原子推进 `purgedThroughCursor`，使 Ack 更早的 Replica 必须进入 `recovery_required`。
4. 服务端把每个已删除 ID 的成员关系压缩为不可复活的 Deletion / Generation Watermark。该 Watermark 不是 Wire Tombstone，必须至少保留到 `serverUuid` 生命周期结束或发生能证明旧 ID 永不再被接受的命名空间迁移。

Purge、`purgedThroughCursor`、Watermark 与物理 Tombstone 删除必须在一个事务内提交。任一步失败都不得推进 Purge 边界。超过 Cursor / Tombstone Window 的 Replica 返回 `410 stale_replica`；已 retired Replica 返回 `410 replica_retired`。

## 10. 冲突模型

### 10.1 原则

- 可以安全合并的字段自动合并。
- 用户可见且不可逆的歧义生成 Conflict。
- 删除和公开策略采用更保守规则。
- 服务器接收顺序是最终提交顺序，但不应把它伪装为无冲突的用户意图。

### 10.2 字段规则

| 字段 / 操作 | 默认规则 |
|---|---|
| 不同字段同时修改 | Field Merge |
| `lastUsedAt` | 取最大有效时间 |
| Tag Add | Set Union |
| Tag Remove | Observed Remove，需要基于 Revision |
| Title 同时修改 | Conflict，服务器值暂时保留 |
| URL 同时修改 | Conflict，不自动选择 |
| 私人 Note 同时修改 | Conflict，保留两版 |
| Folder Move 并发 | 最后服务器提交生效，生成 Move Conflict Notice |
| 并发插入 | 按 Position + Op ID 稳定排序 |
| Delete 与 Update | Delete Dominates，Update 进入 Conflict |
| Delete 与 Move | Delete Dominates |
| Parent 被删 | 移至 Recovered Folder 或 Conflict |
| 产生 Cycle 的 Move | Reject |
| ACL / Publication | 不自动合并，独立管理冲突 |

### 10.3 Conflict

```json
{
  "id": "conflict_01JZ...",
  "collectionId": "collection-1",
  "targetId": "node-9",
  "type": "concurrent_field_update",
  "field": "/title",
  "base": "Old title",
  "server": "Server title",
  "incoming": "Laptop title",
  "incomingOpId": "op-1",
  "createdAt": "2026-07-16T07:05:01Z",
  "status": "open",
  "allowedResolutions": ["server", "incoming", "custom", "both"],
  "revision": "cr_2"
}
```

Conflict 内容属于同步私有数据，不进入公共 Feed。

Conflict 必须带自身 `revision`。Resolve 使用 `If-Match` 与 `Idempotency-Key`；Custom Value 执行与普通写入相同的 Schema、URL、授权和可见性检查。

`both` 只适用于可以安全复制为两个独立资源的冲突，例如 Bookmark 标题 / URL 分歧。服务器必须为复制对象生成新 ID，并把解决结果作为权威 Operation 写入日志；ACL、删除、公开性和 Key 冲突不得使用 `both`。

## 11. Conflict Resolution

`POST /collections/-/sync/conflicts/{id}/resolve`

```json
{
  "resolution": "custom",
  "value": "Merged title",
  "baseConflictRevision": "cr_2"
}
```

解决冲突会生成新的权威 Operation，所有副本都能 Pull 到。

## 12. Move 与 Reorder

### 12.1 Move

客户端提交语义位置：

```json
{
  "newParentId": "folder-b",
  "afterId": "node-x",
  "beforeId": "node-y",
  "baseSourceParentRevision": "children_r_8",
  "baseTargetParentRevision": "children_r_9"
}
```

- `afterId` / `beforeId` 至少一个可省略，均省略表示放到末尾。
- 两者同时提供时必须相邻，否则服务器返回 `position_context_stale` 并给出当前 Child Order 摘要。
- 服务器分配 Position。

### 12.2 Reorder Children

用于浏览器发出的完整 `onChildrenReordered`：

```json
{
  "parentId": "folder-a",
  "childIds": ["n3", "n1", "n2"],
  "baseChildrenRevision": "children_r_9"
}
```

若列表缺失或多出 Child，服务器不得猜测，返回 Conflict 或要求客户端重新读取 Folder。

## 13. 删除

<!-- COLP-REQ SYNC-0008 -->

### 13.1 Delete Node

- 删除 Bookmark 或空 Folder 使用 `delete_node`。
- 递归删除 Folder 使用 `delete_subtree`。
- Sync Tombstone 必须记录根 Node 与删除范围摘要。
- 服务端不必为子树每个 Node 生成独立公共 Feed Event，但 Sync Snapshot 必须能阻止旧副本复活全部子项。
- 服务端内部必须保留每个被删除 ID 的成员关系或等价 Generation Watermark；Wire `syncTombstone` 使用 `scope=subtree`、`targetId`、必需的 `deleteCursor` 和 `affectedCount` 表达范围。Publisher HTTP DELETE 返回不含 `deleteCursor` 的 `deletionReceipt`，不得为无 Sync 部署伪造 Cursor。

Known 同步部署为多成员 `delete_subtree` 要求
`source.extensions["https://known.example/extensions/sync-subtree-observation-v1"]`。
值为 `{version: 1, count, digest}`；digest 使用 canonical Operation digest 算法编码
`{rootId, members: [[id, resourceRevision], ...]}`，members 按 ID 的码位字典序排列，包含根且 ID 不重复。
这是一项操作前置条件，必须参与不可变 Operation 的摘要与重放身份。
客户端在删除捕获/预览时冻结该值，重试不得读取当前树后重新生成。
服务端在删除事务的锁内比较当前成员与版本；变化返回 `revision_conflict`。
没有该扩展的旧请求只允许删除当前无子项的根；存在后代返回 `precondition_required`。
这项保护独立于根 resourceRevision，覆盖任意深度的新增、更新和移入。

### 13.2 Restore

Restore 是新 Operation：

- 恢复原 Parent 可用时返回原位置附近。
- Parent 已删除时放入所属 mount 的 `recovered` Folder；原 mount 已删除时放入 Collection root 下的 `recovered` fallback。不得猜测 `bookmarks-bar`。
- 与现有 ID 冲突时仍使用原协议 ID，不得生成看似全新的对象。

## 14. 转换阶段

每个方向都包括：

```text
native event / tree
  → adapter normalization
  → protocol validation
  → operation generation
  → server authorization
  → conflict / transform
  → authoritative operation
  → target adapter preview
  → native write + sidecar write
  → ack
```

### 14.1 Conversion Preview

首次同步、Mirror、大批量 Delete、Alias Materialization 前必须支持预览：

```json
{
  "creates": 120,
  "updates": 18,
  "moves": 4,
  "deletes": 0,
  "sidecarOnly": 32,
  "lossy": 3,
  "warnings": []
}
```

<a id="colp-section-15"></a>

## 15. Offline Queue

- 客户端离线时正常生成 Sequence。
- Operation 在本地按依赖拓扑存储。
- 网络恢复后先 Pull 再 Rebase 本地 Queue，再 Push。
- 如果先 Push 会导致明显冲突，客户端 SHOULD 先执行轻量 Pull。
- Queue 中对尚未上传 Create 的后续操作可在本地压缩，例如 Create + Update 合并。
- 已上传或已被其他 Operation 依赖的操作不得重写 Op ID。

## 16. 时间与 Clock Skew

- `occurredAt` 是用户设备时间，只作展示与诊断。
- 冲突排序和权威提交不得只依赖客户端时间。
- 服务器记录 `receivedAt` 与提交顺序。
- `lastUsedAt` 等时间字段可接受客户端值，但应校验异常未来时间。

## 17. Snapshot Compaction

服务器可压缩 Operation Log，但必须：

- 生成新的权威 Snapshot。
- 保留仍在 Tombstone Window 内的删除信息。
- 让旧 Cursor 返回 `410` 与 Snapshot URL。
- 不在客户端无感的情况下改变 Collection 可见内容。

## 18. Sync Rate Limits

- Sync Pull 与 Feed Poll 使用不同 Bucket。
- 活跃同步客户端可以比匿名 Feed 更频繁，但仍须遵守服务器返回间隔。
- Push 的 Operation 数、Body Size 和并发数均受限制。
- 429 后不得拆成更多小请求绕过限制。

## 19. 安全

- Sync Token 默认只允许指定 Collection。
- 浏览器插件不得获得 Key / ACL 管理 Scope。
- 服务器不得把一个用户的 SourceRef 返回给另一个用户。
- Mirror 与大规模 Delete 需要显式确认或部署策略许可。
- Managed Browser Node 的写回必须拒绝。Sync 会接收或应用远端 Node Operation，因此该 Profile 的通用变更边界识别 `managed-bookmarks` Folder 及其后代并执行默认只读规则；不承担 Sync 或 Managed Bookmark 角色的普通权威写入部署不因此需要接受或存储该角色。
- Adapter 必须防止远端 URL 触发浏览器内部页面、JavaScript URL 或不安全 Scheme。
- 任意入口（包括 MCP `sync.push`）都必须递归检查 Operation 的最高风险。`delete_collection`、`delete_subtree`、Mirror、Public Exposure、Key / ACL 等高风险动作不能通过 Generic Batch 绕过 Plan / Commit 或部署确认策略。

## 20. 推荐同步循环

```text
1. 读取本地浏览器事件队列
2. 与已知远端 Echo 去重
3. GET sync/pull(lastCursor)
4. 预览并应用远端操作
5. 持久化 Native Mapping 与新 Cursor
6. POST sync/ack
7. Rebase 本地未发送队列
8. POST sync/push
9. 保存每个 Operation 结果
10. 若 serverCursor 前进，再次 Pull 直到 hasMore=false
```

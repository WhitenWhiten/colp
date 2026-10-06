# 10. Implementation Contract and Node Package Guide

## 1. 实现依据

实现者按以下顺序读取规范：

1. `docs/00-practical-profile.md`：Profile 依赖与首个实现范围。
2. `schemas/collection-protocol.schema.json`：所有核心 Wire DTO 的机器合同。
3. 对应分主题文档：HTTP 行为、同步算法、安全或 MCP 适配规则。
4. `examples/*.json` 与 `scripts/validate_examples.py`：正例、语义校验和负例。

若说明文字与 Schema 不一致，Draft 阶段必须把不一致作为规范 Bug 修复，不能由实现者任选其一。Profile Conformance 同时要求结构 Schema、语义规则和 HTTP 行为通过。

Schema 根部的 `anyOf` 只覆盖可独立识别的资源与响应表示。请求、Query 和 Merge Patch 必须按本表指定的 `$defs` 名称编译 Validator；不得用根 Schema 代替端点级校验，否则不完整资源可能被误当成另一个 DTO。

<a id="colp-section-2"></a>

## 2. 0.1 推荐交付边界

首个服务和 Node 包 SHOULD 按顺序交付：

1. `core + publication`
2. `publisher`
3. `feed`，先实现 `release` 模式
4. `sync`
5. `mcp-read` / `mcp-write`

Sync、MCP、OAuth、管理 API 不阻塞第一阶段，但包可以提前导出它们的类型和 Schema。不得在运行时声明尚未通过测试的 Profile。

Profile 依赖用于组合数据模型和 Wire / Endpoint 合同，不会自动启用依赖章节中的所有部署角色。部署一致性计划应把 Profile 固有 HTTP / Transport 合同与条件角色分开：普通权威写入与可选的 Managed Bookmark 写入边界是不同角色；Publisher 和 Sync 因其通用 Node 变更面可能遇到 Managed Nodes，其部署一致性范围同时包含两者，Sync 还要求未知 Extension 存储；AI 内容写入、本地 Profile ID Store、服务端 Profile ID HMAC 仅在部署实际启用相应角色时要求。未声明 Publisher 或 Sync、且不接受或存储 `managed-bookmarks` 的权威写入部署，不得为通过 Managed Bookmark 测试而伪造该角色。纯 `core + publication` 只读部署不得被迫实现这些角色。

## 3. HTTP 合同索引

<!-- COLP-REQ PUB-0010 -->

| 能力 | Endpoint Key | Request `$defs` | Response `$defs` |
|---|---|---|---|
| Manifest | well-known 固定位置 | — | `manifest` |
| Directory | `directory` | `directoryQuery` | `collectionDirectory` |
| Collection Metadata | `collection` | — | `collectionMetadata` |
| Snapshot | `snapshot` | `snapshotQuery` | `snapshot` |
| Node Detail | `node` | `nodeDetailQuery` | `nodeDetail` |
| Create Collection | `directory` POST | `collectionCreateRequest` | `collectionCreateResult` |
| Patch Collection | `collection` PATCH | `collectionMergePatch` | `collection` |
| Create Node | `nodes` | `nodeCreateRequest` | `node` |
| Patch Node | `node` PATCH | `nodeMergePatch` | `node` |
| Move Node | `nodeMove` | `nodeMoveRequest` | `nodeMoveResult` |
| Delete Node / Subtree | `node` DELETE | `nodeDeleteQuery` | `deleteResult` |
| Delete Other Resource | 对应 Item Endpoint | — | `deleteResult` |
| Create Annotation | `annotations` | `annotationCreate` | `annotation` |
| Patch Annotation | `annotation` PATCH | `annotationMergePatch` | `annotation` |
| Create Attachment | `attachments` | `attachmentCreate` | `attachment` |
| Patch Attachment | `attachment` PATCH | `attachmentMergePatch` | `attachment` |
| Create Relation | `relations` | `relationCreate` | `relation` |
| Patch Relation | `relation` PATCH | `relationMergePatch` | `relation` |
| Publish Release | `release` | `releaseCreate` | `releaseResult` |
| Release History | `releases` | `cursorPageQuery` | `releaseDirectory` |
| Release Metadata | `releaseItem` | — | `releaseResult` |
| Instance Feed | `instanceFeed` | `feedQuery` | `feed` |
| Collection Feed | `collectionFeed` | `feedQuery` | `feed` |
| Collection Access | `collectionAccess` | `accessPolicyPatch` for PATCH | `accessPolicy` |
| Admin Key Directory / Create | `adminKeys` | `cursorPageQuery` / `apiKeyCreateRequest` | `apiKeyDirectory` / `apiKeyCreateResult` |
| Admin Key Rotate / Revoke | `adminKeyRotate` / `adminKey` | `apiKeyRotateRequest` / — | `apiKeyRotateResult` / `apiKeyRevokeResult` |
| Admin Rate Limit | `adminRateLimits` | `cursorPageQuery` / `rateLimitPolicyUpdateRequest` | `rateLimitDirectory` / `rateLimitPolicy` |
| Admin Audit | `adminAudit` | `auditQuery` | `auditDirectory` |
| Error | 任意 | — | `problem` |

写入必须把 HTTP Header 合同与 Body DTO 一起实现：`If-Match`、`Idempotency-Key`、`Location`、`ETag` 和状态码都不是可选的 SDK 细节。

## 4. Sync 合同索引

| 阶段 | Request `$defs` | Response `$defs` |
|---|---|---|
| Session | `syncSessionRequest` | `syncSessionResult` |
| Snapshot | `syncSnapshotQuery` | `snapshot`，`mode=sync` |
| Push | `syncPush` | `syncPushResult` |
| Pull | `syncPullQuery` | `syncPull` |
| Ack | `syncAckRequest` | `syncAckResult` |
| Conflict Resolve | `conflictResolutionRequest` | `conflictResolutionResult` |
| Conversion Preview | Adapter-specific input | `conversionPreview` |

浏览器 Replica 必须提供 `replica.binding`，明确 `whole-profile` 或 `mounted-folder` 边界。没有 Binding、Generation 或持久化 Sidecar 时不得启用双向 Sync。

<a id="colp-section-5"></a>

## 5. 安全与 MCP 合同索引

- Access：`accessPolicy`、`accessPolicyPatch`
- API Key：`apiKeyMetadata`、`apiKeyCreateRequest`、`apiKeyCreateResult`、`apiKeyRotateRequest`、`apiKeyRotateResult`、`apiKeyDirectory`
- Rate Limit：`rateLimitPolicy`、`rateLimitPolicyPatch`、`rateLimitDirectory`
- Audit：`auditEvent`、`auditDirectory`
- 高风险计划：`changePlanRequest`、`changePlan`、`changeCommitRequest`、`changeCommitResult`
- MCP Tool Discovery：`mcpToolsList`
- MCP 请求上下文：每请求 `_meta.io.modelcontextprotocol/protocolVersion`、`clientCapabilities` 与 clientInfo；结果 `_meta` 携带 serverInfo。
- MCP 发现：`server/discover` 返回 `supportedVersions` 与 `capabilities`，结果声明 `resultType`。
- MCP 结果与缓存：结果声明 `resultType: complete | input_required`；可缓存 list / read 结果携带 `ttlMs` 与 `cacheScope: public | private`。
- MCP 订阅：`subscriptions/listen` 长连接，`notifications/subscriptions/acknowledged` 携带 subscription ID。

MCP Tool 的 Input / Output Schema SHOULD 直接引用上述 `$defs`，不得复制出含义不同的第二套 DTO。

## 6. Snapshot 组装算法

<!-- COLP-REQ PUB-0005 -->

客户端处理完整分页 Snapshot：

1. 请求第一页并记录 `snapshotId`、`revision`、`mode` 和查询参数。
2. Schema 与当前页语义校验通过后持久化到临时区。
3. 只跟随服务器返回的 `rel=next` URL。
4. 验证后续页的固定字段完全一致，`page.sequence` 连续且对象 ID 不重复。
5. 收到 `page.hasMore=false` 后对组合图执行一次完整语义校验。
6. 仅当所有页 `complete=true` 时原子替换本地状态。

任何失败都丢弃临时组装，不把未出现对象解释为删除。

## 7. Publication Projection

`mode=publication` 表示已经过发布脱敏的表示，不等于匿名可见：

- Public / Unlisted 可以匿名读取。
- Protected / Private 可以在授权后返回 publication 投影。
- SourceRef、Tombstone、内部 Principal 和未 Allowlist 的 Extension 始终移除。
- `redacted=true` 的 Bookmark 是安全占位：保留标题、树位置、Revision 和可选 `accessUrl`，必须移除目标 URL。
- 未 Redact 的 Bookmark 只保留 Authority 不含 Userinfo 的 HTTP(S) `url`；授权不能使含 Userinfo 或非 HTTP(S) 的目标进入 publication 投影。

这样公共页面可以安全展示受限条目的存在，而不会泄漏实际资源地址。

## 8. 推荐 Node 包形态

首个包不需要拆成十个发布物。先发布一个包，并只 Export 已完成的第一阶段入口：

```text
@collection-protocol/node
├── schema            JSON Schema 与按 $defs 编译的 Validator
├── types             从 Schema 生成的 TypeScript 类型
├── semantic          Snapshot、Manifest、URI Template 与图校验
├── client            Manifest 驱动的 Publication / Publisher Fetch Client
├── server            框架无关的 DTO、错误和 Header 辅助函数
└── conformance       运行仓库示例与负例
```

`Node`、`NodeCreate`、`Operation`、`FeedEvent` 必须是严格判别联合；Schema 条件经通用生成器丢失时，生成链必须注入受测试的严格 TypeScript Override。空的 `publisher`、`sync`、`mcp`、`nestjs` 等 Subpath 不得提前发布。NestJS 使用可选 Peer Dependency；浏览器 Adapter 后续独立发布。

确认 API 稳定后再评估拆包。首版过早拆包会增加版本协商和循环依赖成本。

## 9. 最小验收条件

一个可用的 Node 实现至少必须：

- 使用 Draft 2020-12 Format Assertion 校验日期、URI 和 URI Template。
- 使用同一个 RFC 6570 Parser 验证和展开 Endpoint，并检查 Endpoint Key 的精确变量集合。
- 使用严格 I-JSON Parser，在对象构造阶段拒绝重复成员、危险键、不安全协议整数，并执行确定的嵌套深度与成员/数组项预算。
- 提供按 `$defs` 名称取得 Validator 的 API。
- 提供机器可读 Endpoint Contract Registry 与统一 Query Codec；数组使用重复参数，未知参数与重复标量失败。
- Manifest 驱动 URL，不拼接对象路径。
- 对 Snapshot 执行结构校验、分页组装和完整图语义校验。
- 自动处理 ETag / If-None-Match，并要求写入方提供 If-Match。
- 自动生成或接收 Idempotency Key，但不在失败后更换同一逻辑操作的 Key。
- 按 RFC 8785 和规范化 Endpoint / Query / Media Type 计算 Canonical Request Digest。
- 将 `application/problem+json` 解码为稳定 `code`，不解析错误文案。
- 默认移除未 Allowlist 的 publication Extension。
- 运行 `scripts/validate_examples.py` 并通过全部正例与负例。

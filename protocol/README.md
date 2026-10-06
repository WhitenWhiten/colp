# The Collection Protocol

The Collection Protocol 是一个面向收藏夹、公共知识集合和 AI 管理工具的开放协议草案。

协议目标：

1. 标准化浏览器收藏夹、知识集合、层级、顺序、元信息和附加信息。
2. 标准化浏览器、客户端、个人服务器和托管服务之间的双向同步。
3. 提供类似 RSS、Atom、JSON Feed 的公共传播能力。
4. 支持公开、非公开链接、密钥访问、OAuth、权限、限流、签名和审计。
5. 原生映射为 MCP Resources 与 Tools，让 AI 在用户控制下管理收藏夹及其开放策略。

## 状态

- 规范版本：`0.1-draft`
- 文档日期：2026-07-16
- MCP 对齐版本：`2026-07-28`（无状态、POST-only）
- JSON Schema：2020-12
- 兼容目标：Chromium Bookmarks API、Firefox WebExtensions Bookmarks API、Netscape Bookmark HTML，以及可通过适配器读取的 Safari 书签数据。
- Wire Contract 状态：0.1 Draft 已收口；Publication、Publisher、Feed、Sync、安全管理和 MCP 所引用的核心 DTO 均有稳定 `$defs` 名称。
- 实现状态：仓库提供 Schema、26 个正例、机器可读 Requirement Registry、语义校验和负例；`../packages/node` 是尚未声明一致性 Profile 的 Node 包实现工作区。

不建议使用缩写 `TCP`，以免与 Transmission Control Protocol 冲突。推荐使用：

- 人类简称：`Collection Protocol`
- 技术简称：`COLP`
- URL / 包名标识：`collection-protocol`
- API Key 前缀：`colp_`

## 文档

- [docs/00-practical-profile.md](docs/00-practical-profile.md)：建议首先实现的最小互操作面、Profile 依赖和兼容边界。
- [SPECIFICATION.md](SPECIFICATION.md)：协议总体架构、版本、对象与端点总表。
- [docs/01-core-data-model.md](docs/01-core-data-model.md)：核心数据模型与扩展机制。
- [docs/02-http-publication-feed.md](docs/02-http-publication-feed.md)：发现、HTTP API、公共 Feed 与缓存。
- [docs/03-sync.md](docs/03-sync.md)：副本、操作日志、游标、冲突与转换语义。
- [docs/04-auth-security-rate-limit.md](docs/04-auth-security-rate-limit.md)：密钥、OAuth、ACL、限流、签名与审计。
- [docs/05-mcp-profile.md](docs/05-mcp-profile.md)：MCP Resources、Tools 与高风险操作确认。
- [docs/06-browser-mapping.md](docs/06-browser-mapping.md)：浏览器收藏夹字段映射与有损转换。
- [docs/07-nestjs-integration.md](docs/07-nestjs-integration.md)：NestJS 模组形态与部署建议。
- [docs/08-write-api.md](docs/08-write-api.md)：Publisher HTTP 写入请求、响应、状态码与幂等合同。
- [docs/09-problem-registry.md](docs/09-problem-registry.md)：稳定错误码、HTTP 状态与客户端恢复动作。
- [docs/10-implementation-contract.md](docs/10-implementation-contract.md)：机器合同索引、分页组装和 Node 包落地指南。
- [schemas/collection-protocol.schema.json](schemas/collection-protocol.schema.json)：首版核心 JSON Schema。
- [requirements.yaml](requirements.yaml)：稳定 Requirement ID、Profile、实现模块与测试证据索引。
- [examples/public-manifest.json](examples/public-manifest.json)：协议发现文档示例。
- [examples/collection-directory.json](examples/collection-directory.json)：Collection Directory 响应示例。
- [examples/collection-metadata.json](examples/collection-metadata.json)：Collection Metadata 与 Link 示例。
- [examples/collection-snapshot.json](examples/collection-snapshot.json)：Collection Snapshot 示例。
- [examples/protected-publication-snapshot.json](examples/protected-publication-snapshot.json)：受保护 Collection 与 redacted 受限条目示例。
- [examples/node-detail.json](examples/node-detail.json)：带 Included Sidecar 的 Node Detail 示例。
- [examples/publisher-collection-create.json](examples/publisher-collection-create.json)：Collection + Root 原子创建 DTO。
- [examples/publisher-collection-create-result.json](examples/publisher-collection-create-result.json)：Collection + Root 原子创建结果。
- [examples/publisher-annotation-create.json](examples/publisher-annotation-create.json)：Annotation Create DTO。
- [examples/publisher-node-move.json](examples/publisher-node-move.json)：带双 Parent Revision 的 Move DTO。
- [examples/release-directory.json](examples/release-directory.json)：不可变 Release 历史示例。
- [examples/release-result.json](examples/release-result.json)：Release 元数据与 Link 示例。
- [examples/sync-snapshot.json](examples/sync-snapshot.json)：带私有映射与 Sync Cursor 的授权 Snapshot 示例。
- [examples/sync-session-request.json](examples/sync-session-request.json) / [sync-session-result.json](examples/sync-session-result.json)：Sync Session 协商示例。
- [examples/sync-push.json](examples/sync-push.json)：同步 Push 示例。
- [examples/sync-push-result.json](examples/sync-push-result.json)：同步 Push Result 示例。
- [examples/sync-pull.json](examples/sync-pull.json)：Operation / Conflict 统一 Pull 流示例。
- [examples/public-feed.json](examples/public-feed.json)：公共 Feed Event 示例。
- [examples/problem.json](examples/problem.json)：可恢复 Problem Details 示例。
- [examples/access-policy.json](examples/access-policy.json)：Access Policy 示例。
- [examples/change-plan.json](examples/change-plan.json)：高风险 Change Plan 示例。
- [examples/change-plan-request.json](examples/change-plan-request.json)：严格判别的高风险 Change Plan 请求示例。
- [examples/local-bookmark-node.json](examples/local-bookmark-node.json)：保留 `file:` URL 的权威 Bookmark 示例。
- [examples/sync-update-operation.json](examples/sync-update-operation.json)：带 Base / Incoming Value 的字段级同步更新示例。
- [examples/mcp-tools-list.json](examples/mcp-tools-list.json)：MCP Tool 定义示例。

## 建议从哪里开始

首个可互操作实现只需要完成 `core + publication`：

1. 在 Manifest 中声明绝对端点或 URI Template，客户端不得猜路径；声明某个 Profile 时必须同时声明该 Profile 的全部必需端点。
2. 提供 Collection Directory、Collection Metadata 和完整单页 Snapshot。
3. 对每个实际 HTTP 表示返回独立 `ETag`，并使用可校验的 Problem Details 报错。
4. 使用核心 Schema 做结构校验，再执行树、引用、唯一性和可见性的语义校验。

Feed、写入、Sync 和 MCP 都是可组合 Profile，不是首个实现的前置条件。推荐实现顺序见 [docs/00-practical-profile.md](docs/00-practical-profile.md)，机器合同索引与 Node 包实现顺序见 [docs/10-implementation-contract.md](docs/10-implementation-contract.md)。

本仓库的示例可执行校验：

```bash
python -m pip install -r requirements-dev.txt
python scripts/validate_examples.py
```

## 设计原则

- 浏览器优先：核心模型必须能无损表达浏览器真实书签树。
- 扩展而不污染：浏览器不能表达的能力进入标准附加字段或命名空间扩展。
- 默认不公开：同步进入服务器不等于对公网发布。
- Feed 不等于 Sync：Feed 是公开投影，Sync 是可信副本的一致性协议。
- 离线优先：所有写操作可进入本地队列，网络恢复后幂等重放。
- 不静默丢失：任何有损转换必须返回机器可读警告。
- 最小权限：令牌、密钥和 AI 授权必须限定作用域、对象和有效期。
- AI 可操作但不可越权：MCP 复用同一权限模型，高风险操作使用预览和二阶段确认。
- HTTP 原生：缓存、ETag、条件请求、状态码和 Problem Details 都是协议的一部分。
- 可独立部署：个人博客、Web 应用或静态托管均可只实现需要的 Profile。

## 可组合一致性 Profile

| Profile | 必须实现 |
|---|---|
| `core` | 核心对象、严格 Schema、语义校验、完整 Snapshot |
| `publication` | Discovery、Directory、Metadata、Snapshot、链接、ETag、Problem Details |
| `feed` | 公共事件流、Cursor、缓存与脱敏；依赖 `publication` |
| `publisher` | Collection、Node、Annotation、Attachment、Relation 与 Release 写入、条件请求、幂等；依赖 `publication` |
| `sync` | 单 Collection Session、Push、Pull、Ack、Conflict、Tombstone；依赖 `core` |
| `mcp-read` | 只读 Resources / Tools；依赖 `core` |
| `mcp-write` | 写 Tools、Scope、审计和高风险 Plan / Commit；依赖 `mcp-read` + `publisher` |

实现只声明自己完整通过的 Profile。`reader`、`sync-server`、`mcp-server` 等旧草案 Bundle 名称不再用于新 Manifest。

## 示例部署

```text
https://alice.example/
├── .well-known/collection-protocol
└── collections/
    ├──                       GET Collection 列表
    ├── c/{collectionId}      GET Collection 元信息
    ├── c/{collectionId}/snapshot
    ├── c/{collectionId}/feed
    └── -/
        ├── feed              GET 实例公共变更流
        ├── sync/*            双向同步
        ├── admin/*           密钥、权限、限流与审计
        └── mcp               MCP Streamable HTTP 端点
```

`c/` 和 `-/` 是保留路由段，避免不透明 Collection ID 与 `feed`、`sync`、`admin`、`mcp` 冲突。真实路径仍由 Manifest 的 `endpoints` 声明，客户端不得按上图硬编码。

用户可以只实现公开读取，也可以逐步增加 Feed、写入、同步和 MCP，不要求一次实现全部功能。

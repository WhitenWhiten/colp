# The Collection Protocol

[English](README.md) | [简体中文](README.zh-CN.md)

> 规范正文（`SPECIFICATION.md` 与 `docs/`）以英文为准。本页是中文导读。

The Collection Protocol（COLP）是一个面向收藏夹、公共知识集合和 AI 管理工具的开放协议草案。

协议目标：

1. 标准化浏览器收藏夹与知识集合的层级、顺序、元信息和附加信息。
2. 标准化浏览器、客户端、个人服务器和托管服务之间的双向同步。
3. 提供类似 RSS、Atom、JSON Feed 的公共传播能力。
4. 支持公开与非公开链接、密钥访问、OAuth、权限、限流、签名和审计。
5. 原生映射为 MCP Resources 与 Tools，让 AI 在用户控制下管理收藏夹及其开放策略。

## 状态

| | |
|---|---|
| 规范版本 | `0.1-draft`，以及 `0.2` 权威 Pull Effect 增补 |
| 文档日期 | 2026-07-16 |
| MCP 基线 | `2026-07-28`（无状态、仅 POST） |
| JSON Schema | Draft 2020-12 |
| 兼容目标 | Chromium Bookmarks API、Firefox WebExtensions Bookmarks API、Netscape Bookmark HTML，以及可通过适配器读取的 Safari 书签数据 |
| Wire Contract | 0.1 已收口：Publication、Publisher、Feed、Sync、安全管理和 MCP 引用的核心 DTO 均有稳定的 `$defs` 名称 |
| 参考实现 | [`../packages/node`](../packages/node)（`@collection-protocol/node`），需求到测试的追踪见 [`TRACEABILITY.md`](../packages/node/docs/TRACEABILITY.md) |

仓库提供 Schema、28 个可执行示例、机器可读的 Requirement Registry、语义校验和负例断言。

不建议使用缩写 `TCP`，以免与 Transmission Control Protocol 冲突。推荐使用：

- 人类简称：`Collection Protocol`
- 技术简称：`COLP`
- URL / 包名标识：`collection-protocol`
- API Key 前缀：`colp_`

## 文档

| 文档 | 内容 |
|---|---|
| [SPECIFICATION.md](SPECIFICATION.md) | 总体架构、版本、对象与端点总表 |
| [00 实用 Profile](docs/00-practical-profile.md) | 建议首先实现的最小互操作面、Profile 依赖和兼容边界 |
| [01 核心数据模型](docs/01-core-data-model.md) | 核心数据模型与扩展机制 |
| [02 HTTP、发布与 Feed](docs/02-http-publication-feed.md) | 发现、HTTP API、公共 Feed 与缓存 |
| [03 同步](docs/03-sync.md) | 副本、操作日志、游标、冲突与转换语义 |
| [04 认证、安全与限流](docs/04-auth-security-rate-limit.md) | 密钥、OAuth、ACL、限流、签名与审计 |
| [05 MCP Profile](docs/05-mcp-profile.md) | MCP Resources、Tools 与高风险操作确认 |
| [06 浏览器映射](docs/06-browser-mapping.md) | 浏览器书签字段映射与有损转换 |
| [07 NestJS 集成](docs/07-nestjs-integration.md) | 示意性的 NestJS 模块形态与部署建议 |
| [08 写入 API](docs/08-write-api.md) | Publisher HTTP 写入请求、响应、状态码与幂等合同 |
| [09 错误码注册表](docs/09-problem-registry.md) | 稳定错误码、HTTP 状态与客户端恢复动作 |
| [10 实现合同](docs/10-implementation-contract.md) | 机器合同索引、分页组装和 Node 包指南 |

机器可读合同：

- [schemas/collection-protocol.schema.json](schemas/collection-protocol.schema.json)：0.1 核心 JSON Schema。
- [schemas/collection-protocol-0.2.schema.json](schemas/collection-protocol-0.2.schema.json)：0.2 权威 Pull Effect 增补。
- [requirements.yaml](requirements.yaml) 与 [requirements-0.2.yaml](requirements-0.2.yaml)：稳定的 Requirement ID、Profile、实现模块与测试 ID。

## 示例

[`examples/`](examples) 中的每个文件都由 `scripts/validate_examples.py` 按指定的 `$defs` 合同校验。

| 领域 | 示例 |
|---|---|
| 发现与读取 | [public-manifest](examples/public-manifest.json)、[collection-directory](examples/collection-directory.json)、[collection-metadata](examples/collection-metadata.json)、[collection-snapshot](examples/collection-snapshot.json)、[protected-publication-snapshot](examples/protected-publication-snapshot.json)、[node-detail](examples/node-detail.json)、[local-bookmark-node](examples/local-bookmark-node.json)、[global-resource-identity](examples/global-resource-identity.json) |
| Publisher 写入 | [publisher-collection-create](examples/publisher-collection-create.json)、[publisher-collection-create-result](examples/publisher-collection-create-result.json)、[publisher-annotation-create](examples/publisher-annotation-create.json)、[publisher-node-move](examples/publisher-node-move.json) |
| Release 与 Feed | [release-directory](examples/release-directory.json)、[release-result](examples/release-result.json)、[public-feed](examples/public-feed.json) |
| 同步 | [sync-session-request](examples/sync-session-request.json)、[sync-session-result](examples/sync-session-result.json)、[sync-snapshot](examples/sync-snapshot.json)、[sync-push](examples/sync-push.json)、[sync-push-result](examples/sync-push-result.json)、[sync-pull](examples/sync-pull.json)、[sync-pull-v02](examples/sync-pull-v02.json)、[sync-update-operation](examples/sync-update-operation.json) |
| 安全与 MCP | [access-policy](examples/access-policy.json)、[change-plan-request](examples/change-plan-request.json)、[change-plan](examples/change-plan.json)、[mcp-tools-list](examples/mcp-tools-list.json)、[problem](examples/problem.json) |

运行校验：

```bash
python -m venv .venv && . .venv/bin/activate
python -m pip install -r requirements-dev.txt
python scripts/validate_examples.py
```

## 从哪里开始

首个可互操作实现只需要完成 `core + publication`：

1. 在 Manifest 中声明绝对端点或 URI Template，客户端不得猜测路径；声明某个 Profile 时必须同时声明该 Profile 的全部必需端点。
2. 提供 Collection Directory、Collection Metadata 和完整的单页 Snapshot。
3. 为每个实际 HTTP 表示返回独立的 `ETag`，并使用可校验的 Problem Details 报错。
4. 先用核心 Schema 做结构校验，再执行树、引用、唯一性和可见性的语义校验。

Feed、写入、Sync 和 MCP 都是可组合的 Profile，不是首个实现的前置条件。推荐的实现顺序见 [00 实用 Profile](docs/00-practical-profile.md)，机器合同索引与 Node 包交付顺序见 [10 实现合同](docs/10-implementation-contract.md)。

## 设计原则

- **浏览器优先**：核心模型必须能无损表达真实的浏览器书签树。
- **扩展而不污染**：浏览器无法表达的能力进入标准附加字段或命名空间扩展。
- **默认不公开**：同步到服务器不等于向公网发布。
- **Feed 不等于 Sync**：Feed 是公开投影，Sync 是可信副本之间的一致性协议。
- **离线优先**：所有写操作都可进入本地队列，网络恢复后幂等重放。
- **不静默丢失**：任何有损转换都返回机器可读的警告。
- **最小权限**：令牌、密钥和 AI 授权都按作用域、对象和有效期限定。
- **AI 可操作但不可越权**：MCP 复用同一权限模型，高风险操作使用预览和两阶段确认。
- **HTTP 原生**：缓存、ETag、条件请求、状态码和 Problem Details 都是协议的一部分。
- **可独立部署**：个人博客、Web 应用或静态托管都可以只实现需要的 Profile。

## 可组合的一致性 Profile

| Profile | 必须实现 |
|---|---|
| `core` | 核心对象、严格 Schema、语义校验、完整 Snapshot |
| `publication` | Discovery、Directory、Metadata、Snapshot、链接、ETag、Problem Details |
| `feed` | 公共事件流、Cursor、缓存与脱敏；依赖 `publication` |
| `publisher` | Collection、Node、Annotation、Attachment、Relation 与 Release 写入，条件请求与幂等；依赖 `publication` |
| `sync` | 单 Collection Session、Push、Pull、Ack、Conflict、Tombstone；依赖 `core` |
| `mcp-read` | 只读 Resources / Tools；依赖 `core` |
| `mcp-write` | 写入 Tools、Scope、审计与高风险 Plan / Commit；依赖 `mcp-read` + `publisher` |

实现只声明自己完整通过的 Profile。`reader`、`sync-server`、`mcp-server` 等旧草案中的 Bundle 名称不再用于新的 Manifest。

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

`c/` 和 `-/` 是保留路由段，避免不透明的 Collection ID 与 `feed`、`sync`、`admin`、`mcp` 冲突。真实路径仍由 Manifest 的 `endpoints` 声明，客户端不得按上图硬编码。

部署可以只实现公开读取，再逐步增加 Feed、写入、同步和 MCP，不要求一次实现全部功能。

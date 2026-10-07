# The Collection Protocol

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

> 规范正文（`SPECIFICATION.md` 与 `docs/`）以英文为准。本页是中文导读。

The Collection Protocol（COLP）是一个面向书签与人工整理的知识集合的开放协议，原生基于 HTTP。它说明了三件事：如何像发布博客一样发布一个集合，如何在浏览器与服务器之间同步书签树，以及如何让 AI 助手帮忙而不让它拿到超出你本意的权限。

本目录就是规范本身。[`SPECIFICATION.md`](SPECIFICATION.md) 与 [`docs/`](docs) 中的正文是规范性文本；[JSON Schema](schemas)、[示例](examples) 与 [Requirement Registry](requirements.yaml) 是它机器可读的另一半，CI 会保证它们彼此一致。参考实现是 [`@collection-protocol/node`](../packages/node)。

**第一次接触 COLP？** 先读 [五分钟了解 COLP](#五分钟了解-colp)，再按 [从哪里开始](#从哪里开始) 找到与你要做的事对应的阅读路线。不熟悉的术语可以查 [术语表（英文）](GLOSSARY.md)。

## 目录

- [五分钟了解 COLP](#五分钟了解-colp)
- [从哪里开始](#从哪里开始)
- [文档](#文档)
- [Schema、示例与 Requirement](#schema示例与-requirement)
- [设计原则](#设计原则)
- [状态](#状态)
- [命名](#命名)

## 五分钟了解 COLP

**1. 一切从 Manifest 开始。** 服务器在 `/.well-known/collection-protocol` 发布一个 JSON 文档。它列出一个或多个 *mount*，每个 mount 说明自己支持哪些 [Profile](#profile)，并给出每个端点的 URL。客户端沿着这些 URL 以及响应里的链接走，从不自己拼路径。

```text
GET /.well-known/collection-protocol     → Manifest
  mounts[0].endpoints.directory          → Collection 列表
    collections[0].links.snapshot        → 一个 Collection 的整棵树
```

**2. Collection 是一棵树，外加附加数据。** 每个 Collection 有且只有一个根节点，下面是文件夹、书签、分隔线和别名，按不透明的 `position` 排序，因此这棵树可以与浏览器书签一一对应。笔记、摘要、文件和书签之间的关联，作为 Annotation、Attachment 和 Relation 放在树的旁边。

**3. Snapshot 是某个修订号下的完整 Collection。** 节点以扁平数组的形式出现，靠 `parentId` 和 `position` 表达层级与顺序；每种附加数据各有一个顶层数组。大的 Snapshot 会分页，客户端只有在拿到全部分页之后才替换本地状态。

**4. 读取就是普通的、对缓存友好的 HTTP。** 每个响应都带 `ETag`，已经有数据的客户端会得到开销很小的 `304 Not Modified`。错误使用 Problem Details，并带有程序可以据此处理的稳定 `code`。Feed 告诉关注者有哪些变化，也可以同时提供 JSON Feed 或 Atom 形式。

**5. 写入依靠 HTTP 前置条件。** 修改资源时，客户端带上自己最后看到的 `If-Match` ETag；如果别人先改了，服务器返回 `412`，而不是悄悄覆盖对方的修改。可重试的 POST 带 `Idempotency-Key`，重试永远不会产生重复数据。

**6. 同步交换的是操作，而不是整棵树。** 每台设备是一个 *副本*。它先打开会话，然后推送带编号的操作（例如“把节点 9 移到节点 7 后面”），拉取其他副本已经提交的操作，并确认自己应用了什么。服务器对每个操作直接应用、变基，或者记录一个显式冲突。删除会留下墓碑，避免旧设备把书签“复活”。

**7. AI 通过 MCP 遵守同样的规则。** Collection 是 MCP Resource，修改是 MCP Tool，检查的作用域与 HTTP API 完全相同。删除 Collection、改为公开这类高风险操作，必须经过“计划、人工批准、提交”三步。

**8. 默认不公开。** 同步到服务器不等于公开发布。Collection 的可见性分为 `public`、`unlisted`、`protected`、`private`；公开投影会去掉来源映射、私人笔记，以及任何没有明确公开的内容。

### Profile

COLP 拆分为可组合的 Profile。一个 mount 只声明自己完整通过的 Profile；第一个服务器只需要 `core + publication`。

| Profile | 提供的能力 | 依赖 | 章节 |
|---|---|---|---|
| `core` | 核心对象、严格 Schema、语义校验、完整 Snapshot | — | [01](docs/01-core-data-model.md) |
| `publication` | 发现、目录、元信息、Snapshot、链接、ETag、Problem Details | `core` | [02](docs/02-http-publication-feed.md) |
| `feed` | 带游标、缓存与脱敏的公开变更流 | `publication` | [02](docs/02-http-publication-feed.md#colp-section-6) |
| `publisher` | 对所有资源的条件写入与幂等写入，以及 Release | `publication` | [08](docs/08-write-api.md) |
| `sync` | 单个 Collection 的会话、推送、拉取、确认、冲突与墓碑 | `core` | [03](docs/03-sync.md) |
| `mcp-read` | 只读的 MCP Resources 与 Tools | `core` | [05](docs/05-mcp-profile.md) |
| `mcp-write` | MCP 写入 Tools、作用域、审计，以及高风险变更的计划 / 提交 | `mcp-read`、`publisher` | [05](docs/05-mcp-profile.md#colp-section-11) |

`reader`、`sync-server`、`mcp-server` 等旧草案中的 Bundle 名称不再用于新的 Manifest。

### 一个部署大致长什么样

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

`c/` 和 `-/` 是保留路由段，避免不透明的 Collection ID 与 `feed`、`sync`、`admin`、`mcp` 冲突。这个布局只是建议：真实路径以 Manifest 的 `endpoints` 为准，客户端不得按上图硬编码。部署可以先只实现公开读取，再逐个加入 Feed、写入、同步和 MCP。

## 从哪里开始

| 如果你想…… | 按顺序阅读 |
|---|---|
| 了解整体思路 | 本页，然后是 [SPECIFICATION 第 1–4 节](SPECIFICATION.md) 和 [术语表](GLOSSARY.md) |
| 只读发布集合，也就是最小可用的服务器 | [00](docs/00-practical-profile.md)、[01](docs/01-core-data-model.md)、[02 第 1–5 节](docs/02-http-publication-feed.md)、[09](docs/09-problem-registry.md) |
| 在应用或脚本中读取集合 | [00 第 4–7 节](docs/00-practical-profile.md#colp-section-4)、[02 第 2–5 节](docs/02-http-publication-feed.md#colp-section-2)、[10 第 6 节](docs/10-implementation-contract.md#colp-section-6)、[09](docs/09-problem-registry.md) |
| 发布变更 Feed | [02 第 6–11 节](docs/02-http-publication-feed.md#colp-section-6) |
| 接受来自应用的写入 | [08](docs/08-write-api.md)、[04](docs/04-auth-security-rate-limit.md)、[09](docs/09-problem-registry.md) |
| 同步浏览器书签 | [03](docs/03-sync.md)、[06](docs/06-browser-mapping.md)、[04](docs/04-auth-security-rate-limit.md) |
| 让 AI 助手管理集合 | [05](docs/05-mcp-profile.md)、[04](docs/04-auth-security-rate-limit.md) |
| 用另一种语言实现 COLP | [00](docs/00-practical-profile.md)、[10](docs/10-implementation-contract.md)，然后是 [Schema](schemas) 与 [示例](examples)，最后用 [`colp-conformance`](../packages/conformance) 测试 |

使用 TypeScript 或 Node.js？参考包已经实现了全部 Profile，从它的 [README](../packages/node/README.md) 开始即可。

## 文档

| # | 文档 | 内容 | Profile |
|---|---|---|---|
| | [规范总览](SPECIFICATION.md) | 范围、三类数据、ID 与版本、URL、发现、端点总表、HTTP 规则、可见性与版本协商 | 全部 |
| 00 | [实用 Profile](docs/00-practical-profile.md) | 先做什么、Profile 之间的依赖，以及最小可互操作的服务器与客户端 | 全部 |
| 01 | [核心数据模型](docs/01-core-data-model.md) | Collection、Node、Annotation、Attachment、Relation、墓碑、Snapshot 与校验规则 | `core` |
| 02 | [HTTP、发布与 Feed](docs/02-http-publication-feed.md) | Manifest、目录、元信息、Snapshot 分页与缓存、Feed、JSON Feed、Atom 与静态托管 | `publication`、`feed` |
| 03 | [同步](docs/03-sync.md) | 副本、会话、初始化、推送、拉取、确认、冲突、移动、删除与离线队列 | `sync` |
| 04 | [认证、安全与限流](docs/04-auth-security-rate-limit.md) | 主体、作用域、API Key、OAuth 2.1、访问策略、限流、审计与威胁矩阵 | 全部 |
| 05 | [MCP Profile](docs/05-mcp-profile.md) | MCP 传输、Resources、Tools、变更计划，以及让 AI 不越权的规则 | `mcp-read`、`mcp-write` |
| 06 | [浏览器映射](docs/06-browser-mapping.md) | Chromium、Firefox、Netscape 书签 HTML 与 Safari 的字段映射，以及有损转换如何上报 | `sync` |
| 07 | [NestJS 集成](docs/07-nestjs-integration.md) | 在现有 NestJS 应用中嵌入 COLP 的示意方式 | — |
| 08 | [写入 API](docs/08-write-api.md) | Publisher 的 HTTP 请求与响应、状态码、Release 与幂等重放 | `publisher` |
| 09 | [错误码注册表](docs/09-problem-registry.md) | 每个错误 `code`、对应的 HTTP 状态，以及客户端应如何恢复 | 全部 |
| 10 | [实现合同](docs/10-implementation-contract.md) | 每个端点用哪个 Schema 校验、Snapshot 分页组装算法，以及 Node 包的结构 | 全部 |
| | [术语表](GLOSSARY.md)（英文） | 用通俗语言解释上述文档中的术语 | — |

每一章开头都有一段简短摘要，结尾有指向上一章和下一章的链接。

## Schema、示例与 Requirement

| 文件 | 说明 |
|---|---|
| [`schemas/collection-protocol.schema.json`](schemas/collection-protocol.schema.json) | 0.1 全部 Wire 文档的 JSON Schema（Draft 2020-12），每个都有稳定的 `$defs` 名称 |
| [`schemas/collection-protocol-0.2.schema.json`](schemas/collection-protocol-0.2.schema.json) | 0.2 增补：同步的权威 Pull Effect |
| [`requirements.yaml`](requirements.yaml)、[`requirements-0.2.yaml`](requirements-0.2.yaml) | 每条规范性陈述一条记录：稳定 ID、级别、Profile、出处章节、实现模块，以及证明它的测试 |
| [`examples/`](examples) | 28 个示例文档，CI 按各自的 `$defs` 合同校验 |
| [`scripts/validate_examples.py`](scripts/validate_examples.py) | 对所有示例执行结构校验与语义校验 |

| 领域 | 示例 |
|---|---|
| 发现与读取 | [public-manifest](examples/public-manifest.json)、[collection-directory](examples/collection-directory.json)、[collection-metadata](examples/collection-metadata.json)、[collection-snapshot](examples/collection-snapshot.json)、[protected-publication-snapshot](examples/protected-publication-snapshot.json)、[node-detail](examples/node-detail.json)、[local-bookmark-node](examples/local-bookmark-node.json)、[global-resource-identity](examples/global-resource-identity.json) |
| Publisher 写入 | [publisher-collection-create](examples/publisher-collection-create.json)、[publisher-collection-create-result](examples/publisher-collection-create-result.json)、[publisher-annotation-create](examples/publisher-annotation-create.json)、[publisher-node-move](examples/publisher-node-move.json) |
| Release 与 Feed | [release-directory](examples/release-directory.json)、[release-result](examples/release-result.json)、[public-feed](examples/public-feed.json) |
| 同步 | [sync-session-request](examples/sync-session-request.json)、[sync-session-result](examples/sync-session-result.json)、[sync-snapshot](examples/sync-snapshot.json)、[sync-push](examples/sync-push.json)、[sync-push-result](examples/sync-push-result.json)、[sync-pull](examples/sync-pull.json)、[sync-pull-v02](examples/sync-pull-v02.json)、[sync-update-operation](examples/sync-update-operation.json) |
| 安全与 MCP | [access-policy](examples/access-policy.json)、[change-plan-request](examples/change-plan-request.json)、[change-plan](examples/change-plan.json)、[mcp-tools-list](examples/mcp-tools-list.json)、[problem](examples/problem.json) |

自己运行校验（需要 Python 3）：

```bash
python -m venv .venv && . .venv/bin/activate
python -m pip install -r requirements-dev.txt
python scripts/validate_examples.py
```

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

规范处于草案阶段时，正文与 Schema 之间的不一致按缺陷修正；这对兼容性意味着什么，见 [规范第 1 节](SPECIFICATION.md#colp-section-1)。

## 命名

不建议使用缩写 `TCP`，以免与 Transmission Control Protocol 冲突。推荐使用：

- 人类简称：`Collection Protocol`
- 技术简称：`COLP`
- URL / 包名标识：`collection-protocol`
- API Key 前缀：`colp_`

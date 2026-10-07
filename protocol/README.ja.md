# The Collection Protocol

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

> 仕様本文（`SPECIFICATION.md` と `docs/`）は英語版が正です。このページは日本語の案内です。

The Collection Protocol（COLP）は、ブックマークとキュレーションされた知識コレクションのための、HTTP ネイティブなオープンプロトコルです。ブログのようにコレクションを公開する方法、ブラウザーとサーバーの間でブックマークツリーを同期する方法、そして意図した以上の権限を与えずに AI アシスタントの手を借りる方法を定めています。

このフォルダーが仕様そのものです。[`SPECIFICATION.md`](SPECIFICATION.md) と [`docs/`](docs) の本文が規範であり、[JSON Schema](schemas)、[例](examples)、[要件レジストリ](requirements.yaml) が機械可読なもう半分です。CI がこれらすべての整合性を保っています。リファレンス実装は [`@know-n/colp`](../packages/node) です。

**COLP は初めてですか？** まず [5 分でわかる COLP](#5-分でわかる-colp) を読み、次に作りたいものに合わせて [どこから読むか](#どこから読むか) の順路をたどってください。わからない用語は [用語集（英語）](GLOSSARY.md) で説明しています。

## 目次

- [5 分でわかる COLP](#5-分でわかる-colp)
- [どこから読むか](#どこから読むか)
- [ドキュメント](#ドキュメント)
- [スキーマ、例、要件](#スキーマ例要件)
- [設計原則](#設計原則)
- [ステータス](#ステータス)
- [名前について](#名前について)

## 5 分でわかる COLP

**1. すべては Manifest から始まります。** サーバーは `/.well-known/collection-protocol` に JSON ドキュメントを 1 つ公開します。そこには 1 つ以上の *マウント* が並び、各マウントは対応する [プロファイル](#プロファイル) と、すべてのエンドポイントの URL を示します。クライアントは自分でパスを組み立てず、これらの URL とレスポンス内のリンクをたどります。

```text
GET /.well-known/collection-protocol     → Manifest
  mounts[0].endpoints.directory          → Collection の一覧
    collections[0].links.snapshot        → 1 つの Collection のツリー全体
```

**2. Collection はサイドカー付きのツリーです。** どの Collection にもルート Node が 1 つあります。その下にフォルダー、ブックマーク、区切り線、エイリアスが不透明な `position` の順に並ぶため、ツリーはブラウザーのブックマークと 1 対 1 に対応します。メモ、要約、ファイル、ブックマーク同士のリンクは、Annotation、Attachment、Relation としてツリーの横に置かれます。

**3. Snapshot は、1 つのリビジョンにおける Collection 全体です。** Node は `parentId` と `position` を持つフラットな配列で届き、サイドカーは種類ごとにトップレベルの配列を持ちます。大きな Snapshot はページに分割され、クライアントはすべてのページがそろってから新しい状態に切り替えます。

**4. 読み取りは、キャッシュしやすい素の HTTP です。** すべてのレスポンスに `ETag` が付くため、すでにデータを持っているクライアントは軽い `304 Not Modified` を受け取るだけで済みます。エラーは Problem Details で返り、プログラムが判断に使える安定した `code` を持ちます。Feed は何が変わったかをフォロワーに伝え、JSON Feed や Atom としても提供できます。

**5. 書き込みには HTTP の事前条件を使います。** リソースを変更するとき、クライアントは最後に見た ETag を `If-Match` で送ります。先に誰かが変更していれば、サーバーはその変更を黙って上書きせずに `412` を返します。再試行できる POST には `Idempotency-Key` を付けるため、再試行で重複が作られることはありません。

**6. 同期でやり取りするのはツリーではなく操作です。** 各デバイスは *レプリカ* です。レプリカはセッションを開き、「ノード 9 をノード 7 の後ろに移動」のような番号付きの操作をプッシュし、ほかのレプリカがコミットした操作をプルし、適用したものを確認応答します。サーバーは各操作を適用するか、リベースするか、明示的な競合として記録します。削除はトゥームストーンを残すため、古いデバイスが消したはずのブックマークを復活させることはありません。

**7. AI も MCP を通じて同じルールに従います。** Collection は MCP のリソース、変更は MCP のツールであり、HTTP API と同じスコープでチェックされます。Collection の削除や公開のようなリスクの高い操作は、計画、人による承認、コミットの順に進みます。

**8. デフォルトで非公開です。** サーバーへの同期は公開ではありません。Collection は `public`、`unlisted`、`protected`、`private` のいずれかで、公開用の投影からはソースへの参照、非公開のメモ、明示的に公開されていないものがすべて取り除かれます。

### プロファイル

COLP は組み合わせ可能なプロファイルに分かれています。マウントは完全に満たすプロファイルだけを宣言し、最初のサーバーに必要なのは `core + publication` だけです。

| プロファイル | 追加されるもの | 依存先 | 章 |
|---|---|---|---|
| `core` | オブジェクト、厳格なスキーマ、セマンティック検証、完全な Snapshot | — | [01](docs/01-core-data-model.md) |
| `publication` | ディスカバリー、ディレクトリ、メタデータ、Snapshot、リンク、ETag、Problem Details | `core` | [02](docs/02-http-publication-feed.md) |
| `feed` | カーソル、キャッシュ、秘匿化を備えた公開変更ストリーム | `publication` | [02](docs/02-http-publication-feed.md#colp-section-6) |
| `publisher` | すべてのリソースに対する条件付きで冪等な書き込みと、リリース | `publication` | [08](docs/08-write-api.md) |
| `sync` | 1 つの Collection のためのセッション、プッシュ、プル、確認応答、競合、トゥームストーン | `core` | [03](docs/03-sync.md) |
| `mcp-read` | 読み取り専用の MCP リソースとツール | `core` | [05](docs/05-mcp-profile.md) |
| `mcp-write` | MCP の書き込みツール、スコープ、監査、リスクの高い変更のための計画 / コミット | `mcp-read`、`publisher` | [05](docs/05-mcp-profile.md#colp-section-11) |

以前のドラフトにあった `reader`、`sync-server`、`mcp-server` などのバンドル名は、新しい Manifest では使いません。

### デプロイ構成の例

```text
https://alice.example/
├── .well-known/collection-protocol
└── collections/
    ├──                       GET Collection の一覧
    ├── c/{collectionId}      GET Collection のメタデータ
    ├── c/{collectionId}/snapshot
    ├── c/{collectionId}/feed
    └── -/
        ├── feed              GET インスタンス全体の公開変更ストリーム
        ├── sync/*            双方向同期
        ├── admin/*           キー、権限、レート制限、監査
        └── mcp               MCP Streamable HTTP エンドポイント
```

`c/` と `-/` は予約されたルートセグメントなので、不透明な Collection ID が `feed`、`sync`、`admin`、`mcp` と衝突することはありません。この構成はあくまで推奨です。実際のパスは Manifest の `endpoints` が示すとおりなので、クライアントはこの構成をハードコードしてはいけません。デプロイは公開読み取りから始めて、Feed、書き込み、Sync、MCP を 1 つずつ追加できます。

## どこから読むか

| やりたいこと | 読む順番 |
|---|---|
| 全体像をつかむ | このページ、次に [SPECIFICATION §1–4](SPECIFICATION.md) と [用語集](GLOSSARY.md) |
| コレクションを読み取り専用で公開する（いちばん小さな実用サーバー） | [00](docs/00-practical-profile.md)、[01](docs/01-core-data-model.md)、[02 §1–5](docs/02-http-publication-feed.md)、[09](docs/09-problem-registry.md) |
| アプリやスクリプトからコレクションを読む | [00 §4–7](docs/00-practical-profile.md#colp-section-4)、[02 §2–5](docs/02-http-publication-feed.md#colp-section-2)、[10 §6](docs/10-implementation-contract.md#colp-section-6)、[09](docs/09-problem-registry.md) |
| 変更のフィードを公開する | [02 §6–11](docs/02-http-publication-feed.md#colp-section-6) |
| アプリからの書き込みを受け付ける | [08](docs/08-write-api.md)、[04](docs/04-auth-security-rate-limit.md)、[09](docs/09-problem-registry.md) |
| ブラウザーのブックマークを同期する | [03](docs/03-sync.md)、[06](docs/06-browser-mapping.md)、[04](docs/04-auth-security-rate-limit.md) |
| AI アシスタントにコレクションを管理させる | [05](docs/05-mcp-profile.md)、[04](docs/04-auth-security-rate-limit.md) |
| 別の言語で実装する | [00](docs/00-practical-profile.md)、[10](docs/10-implementation-contract.md)、次に [スキーマ](schemas) と [例](examples)。テストには [`colp-conformance`](../packages/conformance) を使います |

TypeScript や Node.js を使っているなら、リファレンスパッケージがすべてのプロファイルをすでに実装しています。まずはその [README](../packages/node/README.md) からどうぞ。

## ドキュメント

| # | ドキュメント | 内容 | プロファイル |
|---|---|---|---|
| | [仕様の概要](SPECIFICATION.md) | 対象範囲、3 種類のデータ、ID とバージョン、URL、ディスカバリー、エンドポイント表、HTTP のルール、可視性、バージョニング | すべて |
| 00 | [実践プロファイル](docs/00-practical-profile.md) | 最初に作るもの、プロファイル間の依存関係、相互運用できる最小限のサーバーとクライアント | すべて |
| 01 | [コアデータモデル](docs/01-core-data-model.md) | Collection、Node、Annotation、Attachment、Relation、トゥームストーン、Snapshot、検証ルール | `core` |
| 02 | [HTTP、公開、フィード](docs/02-http-publication-feed.md) | Manifest、ディレクトリ、メタデータ、Snapshot のページングとキャッシュ、Feed、JSON Feed、Atom、静的ホスティング | `publication`、`feed` |
| 03 | [同期](docs/03-sync.md) | レプリカ、セッション、ブートストラップ、プッシュ、プル、確認応答、競合、移動、削除、オフラインキュー | `sync` |
| 04 | [認証、セキュリティ、レート制限](docs/04-auth-security-rate-limit.md) | プリンシパル、スコープ、API キー、OAuth 2.1、アクセスポリシー、レート制限、監査、脅威マトリクス | すべて |
| 05 | [MCP プロファイル](docs/05-mcp-profile.md) | MCP のトランスポート、リソース、ツール、変更計画、AI を権限の範囲内にとどめるルール | `mcp-read`、`mcp-write` |
| 06 | [ブラウザーマッピング](docs/06-browser-mapping.md) | Chromium、Firefox、Netscape ブックマーク HTML、Safari とのフィールド対応と、情報が失われる変換の報告方法 | `sync` |
| 07 | [NestJS との統合](docs/07-nestjs-integration.md) | 既存の NestJS アプリケーションに COLP を組み込む方法の一例 | — |
| 08 | [書き込み API](docs/08-write-api.md) | Publisher の HTTP リクエストとレスポンス、ステータスコード、リリース、冪等な再実行 | `publisher` |
| 09 | [Problem レジストリ](docs/09-problem-registry.md) | すべてのエラー `code`、その HTTP ステータス、クライアントの回復方法 | すべて |
| 10 | [実装契約](docs/10-implementation-contract.md) | 各エンドポイントを検証するスキーマ、Snapshot の組み立てアルゴリズム、Node パッケージの構成 | すべて |
| | [用語集](GLOSSARY.md) | ほかの文書で使う用語の平易な定義（英語） | — |

各章は短い要約で始まり、前後の章へのリンクで終わります。

## スキーマ、例、要件

| ファイル | 内容 |
|---|---|
| [`schemas/collection-protocol.schema.json`](schemas/collection-protocol.schema.json) | 0.1 のすべてのワイヤードキュメントに対する JSON Schema（Draft 2020-12）。それぞれ安定した `$defs` 名を持ちます |
| [`schemas/collection-protocol-0.2.schema.json`](schemas/collection-protocol-0.2.schema.json) | 0.2 での追加分：Sync のための authoritative pull effects |
| [`requirements.yaml`](requirements.yaml)、[`requirements-0.2.yaml`](requirements-0.2.yaml) | 規範的な記述 1 つにつき 1 レコード：安定した ID、レベル、プロファイル、出典セクション、実装しているモジュール、それを証明するテスト |
| [`examples/`](examples) | 28 個の例。それぞれ CI で `$defs` の契約に照らして検証します |
| [`scripts/validate_examples.py`](scripts/validate_examples.py) | すべての例に構造とセマンティックのチェックを実行します |

| 分野 | 例 |
|---|---|
| ディスカバリーと読み取り | [public-manifest](examples/public-manifest.json)、[collection-directory](examples/collection-directory.json)、[collection-metadata](examples/collection-metadata.json)、[collection-snapshot](examples/collection-snapshot.json)、[protected-publication-snapshot](examples/protected-publication-snapshot.json)、[node-detail](examples/node-detail.json)、[local-bookmark-node](examples/local-bookmark-node.json)、[global-resource-identity](examples/global-resource-identity.json) |
| Publisher による書き込み | [publisher-collection-create](examples/publisher-collection-create.json)、[publisher-collection-create-result](examples/publisher-collection-create-result.json)、[publisher-annotation-create](examples/publisher-annotation-create.json)、[publisher-node-move](examples/publisher-node-move.json) |
| リリースと Feed | [release-directory](examples/release-directory.json)、[release-result](examples/release-result.json)、[public-feed](examples/public-feed.json) |
| 同期 | [sync-session-request](examples/sync-session-request.json)、[sync-session-result](examples/sync-session-result.json)、[sync-snapshot](examples/sync-snapshot.json)、[sync-push](examples/sync-push.json)、[sync-push-result](examples/sync-push-result.json)、[sync-pull](examples/sync-pull.json)、[sync-pull-v02](examples/sync-pull-v02.json)、[sync-update-operation](examples/sync-update-operation.json) |
| セキュリティと MCP | [access-policy](examples/access-policy.json)、[change-plan-request](examples/change-plan-request.json)、[change-plan](examples/change-plan.json)、[mcp-tools-list](examples/mcp-tools-list.json)、[problem](examples/problem.json) |

検証ツールを自分で実行するには（Python 3）：

```bash
python -m venv .venv && . .venv/bin/activate
python -m pip install -r requirements-dev.txt
python scripts/validate_examples.py
```

## 設計原則

- **ブラウザーファースト。** コアモデルは、実際のブラウザーのブックマークツリーを情報を失わずに表現できなければなりません。
- **汚さずに拡張する。** ブラウザーが表現できないものは、標準のサイドカーフィールドか名前空間付きの拡張に入れます。
- **デフォルトで非公開。** サーバーへの同期は、インターネットへの公開ではありません。
- **Feed は Sync ではない。** Feed は公開用の投影であり、Sync は信頼できるレプリカ間の一貫性プロトコルです。
- **オフラインファースト。** どの書き込みもローカルのキューに入れられ、ネットワークが戻ったときに冪等に再実行できます。
- **黙って失わない。** 情報が失われる変換は、必ず機械可読な警告を返します。
- **最小権限。** トークン、キー、AI への権限付与は、スコープ、対象、有効期間で制限されます。
- **AI は行動できるが、権限は超えない。** MCP は同じ権限モデルを再利用し、リスクの高い操作にはプレビューと 2 段階の確認を使います。
- **HTTP ネイティブ。** キャッシュ、ETag、条件付きリクエスト、ステータスコード、Problem Details はプロトコルの一部です。
- **独立してデプロイできる。** 個人ブログ、Web アプリ、静的ホスティングは、必要なプロファイルだけを実装できます。

## ステータス

| | |
|---|---|
| 仕様のバージョン | `0.1-draft` と、`0.2` の authoritative pull effects |
| 文書の日付 | 2026-07-16 |
| MCP のベースライン | `2026-07-28`（ステートレス、POST のみ） |
| JSON Schema | Draft 2020-12 |
| 互換性の対象 | Chromium Bookmarks API、Firefox WebExtensions Bookmarks API、Netscape Bookmark HTML、アダプター経由で読み取る Safari のブックマークデータ |
| ワイヤー契約 | 0.1 は確定済み：Publication、Publisher、Feed、Sync、セキュリティ管理、MCP が参照するすべてのコア DTO に、安定した `$defs` 名があります |
| リファレンス実装 | [`../packages/node`](../packages/node)（`@know-n/colp`）。要件とテストの対応は [`TRACEABILITY.md`](../packages/node/docs/TRACEABILITY.md) にあります |

仕様がドラフトの間は、本文とスキーマの食い違いをバグとして修正します。互換性にとっての意味は [Specification §1](SPECIFICATION.md#colp-section-1) を参照してください。

## 名前について

略称 `TCP` は Transmission Control Protocol と衝突するので使わないでください。代わりに次を使います。

- 人が読む名前：`Collection Protocol`
- 技術的な略称：`COLP`
- URL / パッケージ識別子：`collection-protocol`
- API キーのプレフィックス：`colp_`

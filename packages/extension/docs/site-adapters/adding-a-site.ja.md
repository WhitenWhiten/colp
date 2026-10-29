# サイトアダプターに Web サイトを追加する

[English](adding-a-site.md) | [简体中文](adding-a-site.zh-CN.md) | [日本語](adding-a-site.ja.md)

> 内容は英語版と同じです。食い違いがある場合は英語版が正です。コードとコード内コメントは英語のままにしています。

このガイドは、コーディングエージェントと、その作業をレビューする人に向けたものです。拡張機能が対応する Web サイトを 1 つ増やし、そのサイトで保存したものをブラウザーのブックマークにする方法を説明します。上から順に進めてください。作例の架空サイト **Shelf** は、2026-10-28 にビルド、単体テスト、バンドル、xvfb 上の Chromium での実行を済ませ、本番リリース検証にも通っています。同じコードを [`tests/fixtures/site-adapters/shelf/`](../../tests/fixtures/site-adapters/shelf) に置いてあり、[`tests/site-adapter-shelf-example.test.ts`](../../tests/site-adapter-shelf-example.test.ts) が検証し続けるので、契約が変わればテストが失敗します。下のコードとの違いはホストモジュールの import パスだけです。

パスはすべて `packages/extension/` からの相対パスです。

拡張機能をビルドし直さずにサイトを追加するなら、同じアダプターをパッケージとして書き、設定からインストールします。[サイトアダプターパッケージ](community-packages.md)を参照してください。以下の手順は同梱サイト向けです。

## エージェントに作業を渡す

山かっこを埋めて貼り付けてください。

```text
packages/extension に <サイト名>（<https://正確なオリジン>）の同梱サイトアダプターを追加してください。
docs/site-adapters/adding-a-site.md を上から順に実行してください。
サイト情報：<「コードを書く前に確認すること」への回答。または「先に調べて、コードを書く前に見せて」>。
必要な機能：<ライブ保存 | 保存リストのインポート | 両方>。
サニタイズ済みのフィクスチャだけを使い、実サイトへのサインインや実サイトでのテストはしないでください。
最後にガイド末尾の「最終報告」チェックリストで報告してください。
```

## アダプターがすること、してはいけないこと

アダプターは 1 つのサイト用のページコードで、することは次の 3 つだけです。後の 2 つは任意です。

1. `detectSource`：ページでどのアカウントがサインインしているかをホストに伝えます。
2. `start`：ページを監視し、保存されたものを `context.emit` で報告します。
3. `readItemsPage` などの読み取りメソッド：ホストに求められたときに、保存リストを上限のある 1 ページずつ読みます。

それ以外はすべてホストの担当です。権限、コンテンツスクリプトの登録、ドキュメントのリース、毎回の読み取り前後のアカウント確認、ペース制御、期限、再試行、永続台帳（ledger）、フォルダー配置、ネイティブブックマークの書き込み、同期、設定画面がこれにあたります。サイトの追加に manifest の変更は**不要**です。`optional_host_permissions` が HTTPS サイトを既に含んでおり、利用者が Settings → Site adapters でサイトをオンにすると、worker が `matches` に対してコンテンツスクリプトを登録します。

## コードを書く前に確認すること

フィクスチャか許可されたテストアカウントを使い、ページのソースやネットワークパネルで各項目の答えを確かめてください。答えられない項目があれば、推測せずに作業を止めて質問してください。

| # | 質問 | 使う場所 |
| --- | --- | --- |
| 1 | 正確な HTTPS オリジンと、アダプターを動かすパス | `origin`、`matches` |
| 2 | サインイン中のアカウント ID がページのどこにあるか。サインアウト時のページはどうなるか | `detectSource`、`validateAccount` |
| 3 | アイテムの安定したサイト ID と正規 URL。その ID はどの閲覧者にとっても同じアイテムを指すか | ID のコーデック、`contentIdentity`、`itemUrl`、`contentIdScope` |
| 4 | コレクションの構造：リスト 1 つ、フラットな複数リスト、入れ子のフォルダーのどれか | `defaultCollection` または `enumerateCollections`。入れ子のフォルダーには対応していません。 |
| 5 | 保存が本当に成功したとき、ページに何が表示されるか | `start`（落ち着いた DOM の証拠） |
| 6 | リスト API：URL、ページサイズ、カーソル、エラーの形、レート制限とチャレンジがどう見えるか | `readItemsPage`、失敗の対応付け |

## ルール

**しなければならないこと**

- ID はすべてサイトのデータ（サイト ID と正規 URL）から作ります。タイトルは表示専用なので、`siteDisplayTitle` を通します。
- 正規の `SiteItem` の形を 1 つだけ作り、`validateItem` がその形だけを受け付けるようにします。URL は完全一致で比べます。
- `validateMessage` は、宣言したケイパビリティが生むメッセージ（`failed` のページ結果を含む）だけを受け付け、それ以外には `false` を返すようにします。
- ホストから渡された `document`、`signal`、`deadlineAt` を使い、signal が中断されたらすぐに止めます。リスナーは `context.dom.*` で登録します。そうすればリースが終わったときに外されます。
- `interactionId` は最初の `await` より前に決めます。
- `favorite.confirmed` は、ページに保存済みの状態が表示されてから送ります。
- すべてのリクエストを `services.readPolicy` に従ってペース制御し、上限を設けます。HTTP の問題は `fail(code)` で報告します。
- ページ内で何かを飛ばしたら、そのページを `coverage: 'partial'` にします。
- ケイパビリティは、実装してテストしたものだけを宣言します。

**してはいけないこと**

- ブックマークを書くこと、`chrome.*` を呼ぶこと、worker、ブックマーク、同期、分類のコードを import すること。
- 失敗した読み取り、不完全な読み取り、サインアウト、チャレンジ、レート制限を空のリストとして扱うこと。
- ページがまだ描画されていないだけなのに `signedOut` を返すこと。この場合は `unknown` を返します。
- `start()` の本体で emit すること。ホストはリースの更新ごと（タブあたり約 1 分に 1 回）とルート変更ごとに `start` を呼び直します。
- 保存の取り消しを削除として報告すること。サイト側で消えてもホストはブックマークを削除しないので、無視してください。
- タイトルや URL で重複を除くこと。表示名を直すために `siteKey` や `identityVersion` を変えること。
- cookie、トークン、リクエストボディをどこかへ送ること。
- 新しいサイトのために `scripts/build.mjs`、`src/site-adapters/worker.ts`、`manifest.base.json`、設定画面のコードを編集すること。どうしても変更が必要に見えたら、それはホスト側の変更なので、作業を止めて報告してください。

## ステップ 1：ケイパビリティを選ぶ

| やりたいこと | 宣言 | 実装 | 定義で設定 |
| --- | --- | --- | --- |
| ライブ保存：サイトの保存ボタンを押すとブックマークができる | `observeFavorites` | `start` | — |
| 保存リスト 1 つのインポート | `enumerateItems` | `readItemsPage` | `defaultCollection` |
| フラットな複数リストのインポート | `enumerateCollections`、`enumerateItems` | `readCollectionsPage`、`readItemsPage` | `defaultCollection` は設定しない |

目的を満たす最小の組み合わせから始めてください。`defaultCollection` には `enumerateItems` が必要で、`enumerateCollections` とは併用できません。どちらもない場合、利用者が選べるのは、現在のソースセッション中にアダプターが `catalog.upsert` で知らせたコレクションだけです。入れ子のコレクション、繰り返しのエントリ、差し込み型の保存ボタン（`mountCaptureControl`）、ホストの名前付き読み取りレシピは使えず、レジストリ検証で拒否されます。`resolveItem` と `readMemberships` を使うヒント確認型のお気に入りは「さらに進む」で扱います。

## ステップ 2：ファイル

| 操作 | パス | 内容 |
| --- | --- | --- |
| 作成 | `src/site-adapters/<site>/definition.ts` | 監査済みの `SiteDefinition` と ID のコーデック |
| 作成 | `src/site-adapters/<site>/adapter.ts` | `SiteAdapterFactory` |
| 作成 | `src/site-adapters/<site>/content.ts` | ページのエントリ（4 行） |
| 編集 | `src/site-adapters/registry.ts` | 定義を `bundledSites` に加える |
| 編集 | `tests/site-adapter-build.test.ts` | 登録済みサイトとバンドル名を固定しているテスト |
| 作成 | `tests/site-adapter-<site>.test.ts` | 適格性の検証とサイト固有のケース |
| 作成 | `e2e/mv3-site-adapter-<site>.spec.ts` | ルーティングした偽サイトに対するブラウザーチェック |
| 編集 | `CHANGELOG.md` | `[Unreleased]` に `Added` の項目を 1 つ加える |

## ステップ 3：作例 Shelf

Shelf は架空のサイトです（`.example` は予約ドメイン）。アダプターはサイトが次のように振る舞うことを前提にしています。

- 記事ページは `https://shelf.example/a/<slug>` にあり、slug は `[a-z0-9]{1,64}` に一致します。
- どのページにも `<meta name="shelf:user" content="<10 進の ID>">` があります。誰もサインインしていないとき、content は空です。
- 記事は `<article data-shelf-id="<slug>"><h1>タイトル</h1><button data-shelf-save aria-pressed="false">Save</button></article>` として描画されます。保存に成功すると、サイトがボタンを `aria-pressed="true"` にします。
- 各アカウントには Saved というリストが 1 つだけあります。`GET /api/saved?limit=50&cursor=<c>` は `{ "items": [{ "slug": "…", "title": "…" }], "next": "<カーソル>" | null }` を返し、サインアウト時は 401 または 403、レート制限時は 429 を返します。

作例では、ライブ保存とこのリストのインポートを宣言しています。

### `src/site-adapters/shelf/definition.ts`

```ts
import type { AdapterMessage, SiteCollection, SiteItem, SiteObservation } from '../contracts.js';
import type { SiteDefinition } from '../registry-types.js';
export const ORIGIN = 'https://shelf.example';
/** Shelf keeps one reading list per account. Its ID comes from the site, never from a title. */
export const SAVED: SiteCollection = { id: 'saved', identity: 'siteId', title: 'Saved', parentId: null };
const slug = (value: unknown) => typeof value === 'string' && /^[a-z0-9]{1,64}$/u.test(value) ? value : null;
export const validAccount = (id: unknown): id is string => typeof id === 'string' && /^[1-9]\d{0,19}$/u.test(id);
const articleId = (s: string) => `article:${s}`, articleUrl = (s: string) => `${ORIGIN}/a/${s}`;
const slugFromId = (id: string) => id.startsWith('article:') ? slug(id.slice(8)) : null;
function slugFromUrl(value: string): string | null {
  try { const u = new URL(value); return u.origin === ORIGIN && !u.username && !u.password ? slug(/^\/a\/([^/]+)\/?$/u.exec(u.pathname)?.[1]) : null; }
  catch { return null; }
}
/** The one canonical item shape. Validation accepts nothing else. */
export function article(s: unknown, title: string | null): SiteItem | null {
  const value = slug(s); return value && title ? { id: articleId(value), identity: 'siteId', kind: 'article', url: articleUrl(value), title } : null;
}
const validItem = (item: SiteItem) => { const s = slugFromId(item.id); return !!s && item.identity === 'siteId' && item.kind === 'article' && item.url === articleUrl(s); };
const validCollection = (id: unknown) => id === SAVED.id;
function validObservation(o: SiteObservation): boolean {
  if (o.type === 'catalog.upsert') return !o.items && !!o.collections?.every(c => validCollection(c.id) && c.parentId === null);
  if (o.type === 'favorite.uncertain') return !!slugFromId(o.itemId);
  const ids = o.memberships.mode === 'delta' ? [...o.memberships.added, ...o.memberships.removed] : o.memberships.collectionIds;
  return validItem(o.item) && ids.every(validCollection);
}
/** Semantic checks on top of the closed v1 schema, for exactly the messages these capabilities produce. */
function validMessage(m: AdapterMessage): boolean {
  if (m.operation === 'connect') return true;
  if (m.operation === 'emit') return validObservation(m.data);
  if (m.operation === 'page.result') return m.result.status === 'failed'
    || m.result.kind === 'items' && validCollection(m.result.collectionId) && m.result.page.items.every(row => validItem(row.item));
  return false;
}
export const shelfDefinition: SiteDefinition = Object.freeze<SiteDefinition>({
  adapterId: 'bundled.shelf', version: '1.0.0', siteKey: 'shelf', identityVersion: 1, label: 'Shelf',
  origin: ORIGIN, matches: [`${ORIGIN}/*`],
  capabilities: ['observeFavorites', 'enumerateItems'], defaultCollection: SAVED,
  collectionHierarchy: 'flat', membershipModel: 'set', collectionSnapshot: 'positiveOnly',
  readScope: 'document', contentIdScope: 'site', negativeReadback: false, importResume: 'restartAndDeduplicate',
  scripts: { adapter: 'site-adapter-shelf.js' }, build: { adapter: 'site-adapters/shelf/content.ts' },
  validateAccount: validAccount, validateCollection: validCollection, validateItem: validItem, validateMessage: validMessage,
  contentIdentity(url) { const s = slugFromUrl(url); return s ? { siteKey: 'shelf', identityVersion: 1, itemId: articleId(s) } : null; },
  itemUrl(id) { const s = slugFromId(id); return s ? articleUrl(s) : null; },
  sameResolutionTarget: (a, b) => { const s = slugFromUrl(a); return !!s && s === slugFromUrl(b); },
});
```

### `src/site-adapters/shelf/adapter.ts`

```ts
import { abortableSleep, fail } from '../read-errors.js';
import { siteDisplayTitle } from '../title.js';
import type { AdapterServices, CollectionItem, SiteAdapter, SourcePage } from '../contracts.js';
import { ORIGIN, SAVED, article, validAccount } from './definition.js';
const PAGE = 50;
/** Site extraction only. Leases, account fences, command retries and cleanup belong to page-runtime.ts. */
export function createShelfAdapter(services: AdapterServices): SiteAdapter {
  const policy = services.readPolicy;
  let nextAt = 0;
  /** One paced same-origin GET. HTTP failures stay visible; they never read as an empty list. */
  async function getJson(path: string, ctx: { signal: AbortSignal; deadlineAt: number }): Promise<unknown> {
    const wait = Math.max(0, nextAt - Date.now());
    if (Date.now() + wait >= ctx.deadlineAt) fail('timeout');
    if (wait) await abortableSleep(wait, ctx.signal);
    nextAt = Date.now() + policy.requestSpacingMs;
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(Math.max(1, Math.min(policy.requestMs, ctx.deadlineAt - Date.now())))]);
    const response = await fetch(`${ORIGIN}${path}`, { credentials: 'include', redirect: 'error', signal })
      .catch(() => fail(ctx.signal.aborted ? 'cancelled' : signal.aborted ? 'timeout' : 'network'));
    if (response.status === 401 || response.status === 403) fail('signedOut', undefined, { httpStatus: response.status });
    if (response.status === 429) fail('rateLimited', policy.backoffMs, { httpStatus: 429 });
    if (!response.ok) fail(response.status >= 500 ? 'network' : 'invalidData', undefined, { httpStatus: response.status });
    // Checked after download; stream with a running count (bilibili/http.ts boundedJson) when responses can be large.
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > policy.responseBytes) fail('capacity');
    try { return JSON.parse(text); } catch { return fail('invalidData'); }
  }
  return {
    async detectSource({ document, signal }) {
      if (document.readyState === 'loading') await new Promise<void>(resolve => {
        document.addEventListener('DOMContentLoaded', () => resolve(), { once: true }); signal.addEventListener('abort', () => resolve(), { once: true });
      });
      const meta = document.querySelector<HTMLMetaElement>('meta[name="shelf:user"]');
      if (!meta) return { state: 'unknown' }; // Not rendered: proves neither a sign-out nor an account switch.
      return validAccount(meta.content) ? { state: 'signedIn', accountId: meta.content } : { state: 'signedOut' };
    },
    async start(context) {
      return context.dom.on(context.document, 'click', 'article[data-shelf-id] [data-shelf-save]', button => {
        if (button.getAttribute('aria-pressed') === 'true') return; // Un-saving never deletes a bookmark.
        const node = button.closest<HTMLElement>('article[data-shelf-id]')!;
        const item = article(node.dataset.shelfId, siteDisplayTitle(node.querySelector('h1')?.textContent));
        if (!item) return;
        const interactionId = crypto.randomUUID(); // Fixed before any await, per the favorite.confirmed contract.
        void (async () => {
          const saved = await context.dom.waitFor(() => button.getAttribute('aria-pressed') === 'true' || null,
            { timeoutMs: 5000, signal: context.signal }).then(() => true, () => false);
          if (context.signal.aborted) return;
          if (!saved) { await context.emit({ type: 'favorite.uncertain', interactionId, itemId: item.id, reason: 'timeout' }); return; }
          await context.emit({ type: 'favorite.confirmed', interactionId, item, memberships: { mode: 'delta', added: [SAVED.id], removed: [] },
            confirmation: { kind: 'settledDom', detector: 'shelf.savePressed' } });
        })().catch(() => undefined);
      });
    },
    async readItemsPage(ctx, collectionId, cursor): Promise<SourcePage<CollectionItem>> {
      if (collectionId !== SAVED.id) fail('invalidData');
      const body = await getJson(`/api/saved?limit=${PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, ctx);
      const { items, next } = (body && typeof body === 'object' ? body : {}) as { items?: unknown; next?: unknown };
      if (!Array.isArray(items) || items.length > PAGE || !(next === null || typeof next === 'string' && next.length > 0 && next.length <= 512)) fail('invalidData');
      const rows: CollectionItem[] = []; let skipped = false;
      for (const raw of items as { slug?: unknown; title?: unknown }[]) {
        const item = article(raw?.slug, siteDisplayTitle(raw?.title));
        if (!item) skipped = true; else if (!rows.some(row => row.item.id === item.id)) rows.push({ item });
      }
      // A skipped row makes this page partial, so nothing can treat the list as complete.
      return { items: rows, nextCursor: next as string | null, coverage: skipped ? 'partial' : 'complete', consistency: 'bestEffort' };
    },
    importResume: 'restartAndDeduplicate',
  };
}
```

### `src/site-adapters/shelf/content.ts`

```ts
import { startAdapterRuntime } from '../page-runtime.js';
import { shelfDefinition } from './definition.js';
import { createShelfAdapter } from './adapter.js';
startAdapterRuntime(shelfDefinition, createShelfAdapter);
```

### 登録する

```diff
 // src/site-adapters/registry.ts
 import { bilibiliDefinition } from './bilibili/definition.js';
+import { shelfDefinition } from './shelf/definition.js';
-export const bundledSites: readonly SiteDefinition[] = validateSiteDefinitions([bilibiliDefinition]);
+export const bundledSites: readonly SiteDefinition[] = validateSiteDefinitions([bilibiliDefinition, shelfDefinition]);
```

```diff
 // tests/site-adapter-build.test.ts
-  expect(sites.map(s => s.adapterId)).toEqual(['bundled.bilibili']);
-  expect(result.bundles).toEqual([{ adapterId: 'bundled.bilibili', adapter: 'site-adapter.js', probe: 'site-probe.js' }]);
-  expect(Object.keys(result.entries).sort()).toEqual(['site-adapter', 'site-probe']);
+  expect(sites.map(s => s.adapterId)).toEqual(['bundled.bilibili', 'bundled.shelf']);
+  expect(result.bundles).toEqual([{ adapterId: 'bundled.bilibili', adapter: 'site-adapter.js', probe: 'site-probe.js' }, { adapterId: 'bundled.shelf', adapter: 'site-adapter-shelf.js' }]);
+  expect(Object.keys(result.entries).sort()).toEqual(['site-adapter', 'site-adapter-shelf', 'site-probe']);
```

ビルドはレジストリから `scripts` と `build` を読み、`site-adapter-shelf.js` と `site-adapter-bundles.json` を出力します。リリース検証は、そこに載っているバンドルをすべて確認します。設定画面のサイドバーには登録済みのサイトがすべて並び、Shelf のページは `site-adapters.html?adapterId=bundled.shelf` で開きます。

### わかりにくい行の理由

- **`catalog.upsert` は不要。** ブックマークの計画には、コレクションの事実が台帳にあることが必要です。`defaultCollection` を使う場合はホストが自分で記録します。インポートのときと、そのリストを含む最初のライブ保存のときです。`defaultCollection` も `enumerateCollections` もないサイトは、`start` の本体ではなくイベントハンドラーから、見えたコレクションを `catalog.upsert` で知らせる必要があります。そうしないと、ライブ保存は `sourceFactsUnresolved` で確定します。
- **`detectSource` は `DOMContentLoaded` を待ち、meta タグがなければ `unknown` を返す。** スクリプトは `document_start` で動きます。`signedOut` の申告は接続を遮断（fence）しますが、`unknown` は「後でもう一度」を意味するだけです。
- **`start` の本体では emit しない。** `start` はリースの更新ごとに呼ばれるので、そこで emit するとタブごとに約 1 分に 1 行、台帳の行が増えます。
- **`importResume`** は定義とアダプターの両方で宣言し、値を一致させる必要があります。`stableCursor` を使えるのは、同じカーソルが常に同じページを返す場合だけです。
- **`contentIdScope: 'site'`**：Shelf の記事 ID はどのアカウントでも同じ記事を指すためです。非公開の ID やアカウント内でだけ有効な ID では設定しないでください。そうすればホストがアカウントをコンテンツ ID に含めます。
- **ホストの上限**：1 ページ最大 100 件、カーソル最大 512 文字、ID 最大 128 文字、タイトル最大 512 UTF-16 単位、ページ結果 1 件あたり 512 KiB、観測 1 件あたり 256 KiB。超える場合は切り詰めず、`capacity` か `invalidData` で失敗させます。

## ステップ 4：テスト

`qualifySiteAdapter` は、定義をレジストリ検証にかけ、宣言したケイパビリティと実装済みメソッドが一致するかを確かめ、ID を往復させ、宣言した読み取りメソッドをすべて閉じたワイヤースキーマに通します（続きカーソルの再生を含む）。その隣にサイト固有のケースを足してください。

```ts
// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest';
import { qualifySiteAdapter } from './fixtures/site-adapters/qualification.js';
import { createPageContext } from '../src/site-adapters/page-context.js';
import { readLimits } from '../src/site-adapters/read-policy.js';
import { shelfDefinition, SAVED, article } from '../src/site-adapters/shelf/definition.js';
import { createShelfAdapter } from '../src/site-adapters/shelf/adapter.js';
const item = article('alpha', 'Alpha')!;
const services = { readPolicy: readLimits({ readPolicy: { spacingMs: 1, requestSpacingMs: 1 } }) };
const signIn = () => { document.head.innerHTML = '<meta name="shelf:user" content="42">'; };
afterEach(() => { vi.unstubAllGlobals(); document.head.replaceChildren(); document.body.replaceChildren(); });
qualifySiteAdapter({ definition: shelfDefinition, accountId: '42', item, collection: SAVED, setup() {
  signIn(); vi.stubGlobal('fetch', async () => Response.json({ items: [{ slug: 'alpha', title: 'Alpha' }], next: null }));
  return createShelfAdapter(services);
} });
test('a Save click is reported only after the page shows it saved', async () => {
  signIn(); document.body.innerHTML = '<article data-shelf-id="alpha"><h1>Alpha</h1><button data-shelf-save aria-pressed="false">Save</button></article>';
  const emitted: unknown[] = [], controller = new AbortController();
  const context = createPageContext({ document, signal: controller.signal, accountId: '42', routeEpoch: 0, deadlineAt: Date.now() + 10000, routeEvent: 'shelf-route', controls: false,
    emit: async data => { emitted.push(data); return { status: 'accepted', receiptId: String(emitted.length) }; },
    hint: async () => { throw Error('unexpectedHint'); }, requestCapture: async () => { throw Error('unexpectedCapture'); } });
  const cleanup = await createShelfAdapter(services).start(context);
  const button = document.querySelector('button')!;
  button.click(); expect(emitted).toEqual([]);
  button.setAttribute('aria-pressed', 'true');
  await vi.waitFor(() => expect(emitted).toHaveLength(1));
  expect(emitted).toEqual([expect.objectContaining({ type: 'favorite.confirmed', item, memberships: { mode: 'delta', added: [SAVED.id], removed: [] } })]);
  controller.abort(); await cleanup?.();
});
test('an expired session fails visibly instead of reading as an empty list', async () => {
  vi.stubGlobal('fetch', async () => new Response('', { status: 401 }));
  const context = { accountId: '42', document, signal: new AbortController().signal, deadlineAt: Date.now() + 5000, readSessionId: 'session' };
  await expect(createShelfAdapter(services).readItemsPage!(context, SAVED.id, null)).rejects.toMatchObject({ failure: { code: 'signedOut' } });
});
```

さらに、実際のレスポンスから作ったサニタイズ済みフィクスチャで、次のケースも確認してください。

- カーソルで 2 ページ目に進むこと、無効になったカーソル（`staleCursor`）
- 不正な行（`coverage: 'partial'` になる）と重複した行
- 読み取りの途中でのサインアウト、レート制限（`retryAfterMs` 付きの `rateLimited`）、チャレンジページ（`challenge`）
- 保存を取り消すクリックでは何も送らないこと、いつまでも落ち着かない保存では `favorite.uncertain` を送ること
- 観測が依存する正確なページ構造やレスポンス

## ステップ 5：検証

`packages/extension` で実行し、変更に関係するものだけを実行してください。`npm run test:site-adapters` は、ホストの共有コードを変更したときだけ実行します。ブラウザーテストは必ず xvfb で動かします。

```sh
npx vitest run tests/site-adapter-<site>.test.ts tests/site-adapter-build.test.ts tests/site-adapter-qualification.test.ts
npm run typecheck
npx eslint src/site-adapters/<site> src/site-adapters/registry.ts tests/site-adapter-<site>.test.ts tests/site-adapter-build.test.ts e2e/mv3-site-adapter-<site>.spec.ts
npm run build:development
KNOWN_E2E_HEADED=0 node scripts/with-xvfb.mjs npx playwright test --project=core e2e/mv3-site-adapter-<site>.spec.ts
npm run build && node scripts/verify-release-artifact.mjs dist/production
```

### ブラウザーチェック

この spec は `context.route` で偽サイトを配信し、共有の X11 ヘルパーで権限を付与します。サイトをオンにし、アカウントを確認し、リストをフォルダーに割り当て、Save を押して、ネイティブブックマークができるまで待ちます。その後のインポートプレビューでは、そのブックマークを再利用し、2 つ目を作らないことが求められます。

```ts
import { test, expect, chromium } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { openExtensionOptions } from './extension-auth.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';
const extensionId = 'pplpnpegpnghcddhmpgkbfkdfadjiaen', extensionPath = resolve(import.meta.dirname, '../dist/development');
const page = `<!doctype html><meta name="shelf:user" content="42"><title>Alpha</title>
<article data-shelf-id="alpha"><h1>Alpha</h1><button data-shelf-save aria-pressed="false">Save</button></article>
<script>document.querySelector('button').onclick = e => setTimeout(() => e.target.setAttribute('aria-pressed', 'true'), 200);</script>`;
test('Shelf saves a live favorite natively and previews an import without duplicating it', async () => {
  test.setTimeout(120000);
  const profile = await mkdtemp(resolve(tmpdir(), 'site-shelf-'));
  const context = await chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium', args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
  try {
    await context.route('https://shelf.example/a/**', r => r.fulfill({ contentType: 'text/html', body: page }));
    await context.route('https://shelf.example/api/saved*', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [{ slug: 'alpha', title: 'Alpha' }, { slug: 'beta', title: 'Beta' }], next: null }) }));
    const { page: options } = await openExtensionOptions(context);
    const grants = { permissions: ['bookmarks', 'scripting', 'webNavigation'], origins: ['https://shelf.example/*'] };
    await options.evaluate(g => { const b = document.createElement('button'); b.id = 'grant-shelf'; b.textContent = 'Grant'; b.onclick = () => { void chrome.permissions.request(g); }; document.body.prepend(b); }, grants);
    await grantOptionalBookmarks(options, options.locator('#grant-shelf'), 'Shelf source', grants);
    const site = await context.newPage(); await site.goto('https://shelf.example/a/alpha');
    await options.goto(`chrome-extension://${extensionId}/site-adapters.html?adapterId=bundled.shelf#sync`);
    await options.locator('#enable').click();
    const send = (message: Record<string, unknown>) => options.evaluate(m => chrome.runtime.sendMessage({ ...m, adapterId: 'bundled.shelf' }), message) as Promise<Record<string, any>>;
    await expect.poll(async () => (await send({ kind: 'known.siteAdapters.status' })).candidateAccount, { timeout: 20000 }).toBe('42');
    await options.locator('#refresh').click(); await options.locator('#confirm').click();
    await expect.poll(async () => (await send({ kind: 'known.siteAdapters.status' })).documents, { timeout: 20000 }).toBe(1);
    const root = await options.evaluate(async () => chrome.bookmarks.create({ parentId: (await chrome.bookmarks.getTree())[0]!.children![0]!.id, title: 'Shelf archive' }));
    expect(await send({ kind: 'known.siteAdapters.archive.configure', rootNativeId: root.id, collectionIds: ['saved'], live: true })).toMatchObject({ archiveResult: { configured: true }, writes: true });
    await expect.poll(() => options.evaluate(async () => {
      const state = (await chrome.storage.local.get('known.siteAdapters.runtime.v1:bundled.shelf'))['known.siteAdapters.runtime.v1:bundled.shelf'] as { leases?: { expiresAt: number }[] } | undefined;
      return state?.leases?.some(l => l.expiresAt > Date.now() + 1000) ?? false;
    }), { timeout: 20000 }).toBe(true);
    await site.locator('[data-shelf-save]').click();
    await expect.poll(() => options.evaluate(async () => (await chrome.bookmarks.search({ url: 'https://shelf.example/a/alpha' })).map(b => b.title)), { timeout: 15000 }).toEqual(['Alpha']);
    expect(await options.evaluate(async id => (await chrome.bookmarks.getChildren(id)).map(b => b.title), root.id)).toEqual(['Saved']);
    await send({ kind: 'known.siteAdapters.import.start' });
    await expect.poll(async () => (await send({ kind: 'known.siteAdapters.status' })).archive?.import?.preview?.counts, { timeout: 30000 })
      .toEqual({ createFolders: 0, createBookmarks: 1, reuseBookmarks: 1, review: 0 });
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});
```

## `SiteDefinition` のフィールド

| フィールド | Shelf での値 | 変更するとき |
| --- | --- | --- |
| `adapterId` | `bundled.shelf` | 公開後は変更しません。ストレージ、ポート、設定画面のキーになっています。 |
| `siteKey`、`identityVersion` | `shelf`、`1` | 表示名を直すために変えてはいけません。新しい ID バージョンにはレビュー済みの移行が必要です。 |
| `label`、`icon` | `Shelf`、サイトの favicon | `icon` には、パッケージ同梱のアセット、監査済みの HTTPS 画像、data URL を使えます |
| `origin`、`matches` | オリジン 1 つ、`/*` | アダプターを動かしてはいけない領域がサイトにあれば、パスを絞ります。HTTPS のみで、ワイルドカードのホストは使えません。 |
| `connectionKind` | `account`（既定） | `page` にすると、利用者にアカウントを確認させずにページの ID をそのまま採用します |
| `capabilities`、`defaultCollection` | ライブ保存とリスト 1 つ | ステップ 1 を参照 |
| `readScope` | `document` | 同じアカウントの別タブからの読み取りが検証済みの場合だけ `account` にします |
| `contentIdScope` | `site` | 非公開の ID やアカウント内でだけ有効な ID では設定しません |
| `collectionSnapshot` | `positiveOnly` | 検証済みの連続したスナップショットだけが `pointInTime` を使えます。これにより再チェック時に削除を推定できます。 |
| `negativeReadback` | `false` | `readMemberships` を宣言し、新しく範囲の限られた「存在しない」証拠を出せる場合だけ `true` にします |
| `importResume` | `restartAndDeduplicate` | カーソルを正確に再生できる場合だけ `stableCursor` にします |
| `readPolicy` | 既定値 | ホストが許す範囲で、間隔、タイムアウト、試行回数を調整します |
| `scripts`、`build` | `site-adapter-shelf.js`、`site-adapters/shelf/content.ts` | 監査済みの MAIN world プローブがある場合だけ `probe` を加えます |

## サイトの状況と失敗コードの対応

`src/site-adapters/read-errors.ts` の `fail(code, retryAfterMs?, { httpStatus, sourceCode })` で投げます。診断情報にはステータスの数値だけを含め、レスポンスボディ、URL、資格情報は決して含めません。

| サイトの状況 | コード |
| --- | --- |
| 401 または 403、ログインページ、別のアカウント | `signedOut` |
| 429 | `rateLimited`（`retryAfterMs` 付き） |
| CAPTCHA やボット対策のチャレンジ | `challenge` |
| 5xx レスポンスまたはネットワークエラー | `network` |
| 時間切れ（ホストも期限を強制します） | `timeout` |
| `signal` が中断された | `cancelled` |
| レスポンスや行数が予算を超えた | `capacity` |
| 想定外の形 | `invalidData` |
| カーソルがもう有効でない | `staleCursor` |
| その ID や URL には対応していない | `unsupported` |
| ドキュメントやタブがなくなった | `pageUnavailable` |

## ホスト側の既知の不足（2026-10-28 時点）

1. **パッケージ化していないビルドではタイミングが当てになりません。** `scheduleSourceWork`（`src/site-adapters/worker.ts`）は、復旧アラームも同じ時刻に設定します。Chrome が 30 秒のアラーム下限を強制するのはパッケージ化された拡張機能だけなので、開発ビルドや e2e ビルドでは、このアラームによってソース処理が約 60 ミリ秒ごとに再実行され続けることがあり、起こし忘れが隠れてしまいます。遅延についての主張を確かめるときは、worker が静かになるのを待ってから操作してください。
2. ポップアップの「Save as semantic」ボタンは、Bilibili の動画 URL でだけ表示されます（`src/capture/manual-existence.ts:45`）。
3. [パッケージ](community-packages.md)は MAIN world のプローブを同梱できません。保存済みの状態を表示しないサイトには、監査済みプローブを持つ同梱アダプターが必要です。
4. 旧来のクラウドアーカイブプロトコルには、サーバー側の ID コーデック（`packages/server/src/modules/source-archives/site-registry.ts`）が必要です。ローカルファーストの保存と同期には不要です。

## さらに進む

- **複数のリスト。** `enumerateCollections` と `readCollectionsPage` を加え、`parentId: null` のフラットな `SourcePage<SiteCollection>` を返します。`defaultCollection` は外してください。上限付きのカーソルバッファーとページの再生は `bilibili/reader.ts` が参考になります。
- **サイトが落ち着いた状態を表示しない場合。** ヒント経路を使います。監査済みの MAIN world プローブ（`scripts.probe`/`build.probe`）がページイベントを発行し、`start` がそれを `deliverMembershipHint` で転送し、ホストがペース制御された `readMemberships` と `resolveItem` で確認します。`observeFavorites`、`readMemberships`、`resolveItem` の 3 つすべてが必要です。`bilibili/probe.ts`、`bilibili/adapter.ts`、`hint-delivery.ts` を参照してください。プローブが送れるのは上限のある ID とコードだけです。
- **大きなレスポンス。** ストリームで読みながらバイト数を数えます（`bilibili/http.ts` の `boundedJson`）。ほかのサイトのディレクトリから import せず、共有モジュールへ移してください。
- **背景資料**（英語）：責任分担と証拠は [authoring.md](authoring.md)、ID・分離・復旧は [runtime-foundation.md](runtime-foundation.md)、再チェックは [reconciliation.md](reconciliation.md) にあります。正となる型は `src/site-adapters/contracts.ts` と `registry-types.ts` です。

## 最終報告

次のチェックリストを最終メッセージにコピーし、各項目を埋めてください。

```text
- 確認事項 1〜6 の回答と、それぞれの出典（ページ、API、フィクスチャ）：
- 宣言したケイパビリティ = 実装したメソッド = 書いたテスト：
- validateItem / validateMessage がそれ以外をすべて拒否すること：
- 単体テスト（ファイル、合格数）：
- typecheck / eslint：
- xvfb でのブラウザーチェック：
- 本番ビルド + verify-release-artifact：
- ステップ 2 の一覧以外で変更したファイルとその理由（想定：なし）：
- 実サイトでのテスト（なし、または許可されたテストアカウント + ブラウザーのバージョン）：
- このサイトに影響するホスト側の既知の不足：
```

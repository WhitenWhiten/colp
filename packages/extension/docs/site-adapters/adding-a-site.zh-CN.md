# 为站点适配器接入一个网站

[English](adding-a-site.md) | [简体中文](adding-a-site.zh-CN.md) | [日本語](adding-a-site.ja.md)

> 本页内容与英文版一致；如有出入，以英文版为准。代码与代码注释保持英文。

本指南写给编码 agent，也写给审阅其工作的人。它说明如何让扩展再支持一个网站，把用户在该网站上的收藏变成浏览器书签。请从头到尾按顺序完成。文中的完整示例是一个虚构网站 **Shelf**，已于 2026-10-28 完成构建、单元测试、打包、在 xvfb 下的 Chromium 中实际运行，并通过了生产发布校验。它的一份副本放在 [`tests/fixtures/site-adapters/shelf/`](../../tests/fixtures/site-adapters/shelf)，由 [`tests/site-adapter-shelf-example.test.ts`](../../tests/site-adapter-shelf-example.test.ts) 持续验证，契约变动时它会跟着报错。与下文代码相比，只有宿主模块的 import 路径不同。

下文所有路径都相对于 `packages/extension/`。

## 把任务交给 agent

填好尖括号后粘贴：

```text
在 packages/extension 中为 <网站名>（<https://确切的源>）添加一个内置站点适配器。
按 docs/site-adapters/adding-a-site.md 从头到尾执行。
网站信息：<“编码前需要确认的信息”各项答案，或写“先收集并给我确认，再写代码”>。
需求：<实时保存 | 导入收藏列表 | 两者都要>。
只使用脱敏 fixture；不要登录真实网站，也不要对真实网站做测试。
最后按指南末尾的“最终报告”清单汇报。
```

## 适配器做什么，不能做什么

适配器是针对单个网站的页面代码。它只做三件事，后两件可选：

1. `detectSource`：告诉宿主页面上登录的是哪个账号。
2. `start`：监视页面，通过 `context.emit` 报告用户收藏了什么。
3. `readItemsPage` 等读取方法：在宿主要求时，每次读取收藏列表中有界的一页。

其余一切都由宿主负责：权限、内容脚本注册、文档租约（lease）、每次读取前后的账号核对、节流、截止时间、重试、持久化账本（ledger）、文件夹布局、原生书签写入、同步以及设置页面。接入新网站**不需要**修改 manifest：`optional_host_permissions` 已覆盖 HTTPS 网站，用户在 设置 → 站点适配器 中开启该网站后，worker 会按 `matches` 注册内容脚本。

## 编码前需要确认的信息

借助 fixture 或经授权的测试账号，从页面源码或网络面板中找到每一项的答案。任何一项无法回答时，停下来提问，不要猜。

| # | 问题 | 用于 |
| --- | --- | --- |
| 1 | 确切的 HTTPS 源，以及适配器应运行的路径 | `origin`、`matches` |
| 2 | 页面在哪里显示已登录账号的 ID，未登录时页面是什么样 | `detectSource`、`validateAccount` |
| 3 | 条目在网站上的稳定 ID 与规范 URL。对每个访问者来说，这个 ID 都指向同一个条目吗？ | 身份编解码、`contentIdentity`、`itemUrl`、`contentIdScope` |
| 4 | 收藏夹的结构：单个列表、多个平级列表，还是嵌套文件夹 | `defaultCollection` 或 `enumerateCollections`。不支持嵌套文件夹。 |
| 5 | 收藏真正成功后，页面会显示什么 | `start`（已稳定的 DOM 证据） |
| 6 | 列表接口：URL、分页大小、游标、错误格式，以及限流和人机验证的表现 | `readItemsPage`、失败映射 |

## 规则

**必须**

- 所有 ID 都来自网站数据：站点 ID 和规范 URL。标题只用于显示，要经过 `siteDisplayTitle` 处理。
- 只产生一种规范的 `SiteItem` 形状，并让 `validateItem` 只接受这一种。URL 必须完全相等。
- 让 `validateMessage` 恰好接受你声明的能力会产生的消息（包括 `failed` 的分页结果），其余一律返回 `false`。
- 使用宿主传入的 `document`、`signal` 和 `deadlineAt`；signal 中止后立即停止。监听器要通过 `context.dom.*` 注册，租约结束时它们会被自动移除。
- 在第一个 `await` 之前确定 `interactionId`。
- 只有在页面显示出已收藏的状态之后，才发出 `favorite.confirmed`。
- 每个请求都按 `services.readPolicy` 节流并设上限；HTTP 问题用 `fail(code)` 报告。
- 某一页中有任何条目被跳过，就把这一页标为 `coverage: 'partial'`。
- 只声明已经实现并测试过的能力（capability）。

**禁止**

- 写书签、调用 `chrome.*`，或引入 worker、书签、同步、分类相关的代码。
- 把失败或不完整的读取、登出、人机验证或限流当成空列表。
- 页面只是还没渲染完时返回 `signedOut`。这种情况应返回 `unknown`。
- 在 `start()` 的函数体里直接 emit。每次租约续期（每个标签页大约每分钟一次）和每次路由变化时，宿主都会再次调用 `start`。
- 把取消收藏报告为删除。网站上的删除永远不会导致宿主删除书签，直接忽略即可。
- 按标题或 URL 去重，或为了修正显示名称而修改 `siteKey`、`identityVersion`。
- 把 cookie、token 或请求体发送到任何地方。
- 为新网站修改 `scripts/build.mjs`、`src/site-adapters/worker.ts`、`manifest.base.json` 或设置页代码。如果看起来必须改其中某个文件，停下来汇报，因为那属于宿主层面的改动。

## 第 1 步：选择能力

| 需求 | 声明 | 实现 | 定义中设置 |
| --- | --- | --- | --- |
| 实时保存：在网站上点“收藏”就生成书签 | `observeFavorites` | `start` | — |
| 导入单个收藏列表 | `enumerateItems` | `readItemsPage` | `defaultCollection` |
| 导入多个平级列表 | `enumerateCollections`、`enumerateItems` | `readCollectionsPage`、`readItemsPage` | 不设 `defaultCollection` |

从能满足需求的最小集合开始。`defaultCollection` 要求声明 `enumerateItems`，且不能与 `enumerateCollections` 同时使用。两者都没有时，用户只能选择适配器在当前来源会话中通过 `catalog.upsert` 公布过的收藏夹。嵌套收藏夹、可重复条目、注入的保存按钮（`mountCaptureControl`）和宿主命名读取配方均不可用，注册校验会直接拒绝。需要 `resolveItem` 与 `readMemberships` 的“提示确认式收藏”见“进一步扩展”。

## 第 2 步：文件

| 操作 | 路径 | 内容 |
| --- | --- | --- |
| 新建 | `src/site-adapters/<site>/definition.ts` | 经审计的 `SiteDefinition` 与身份编解码 |
| 新建 | `src/site-adapters/<site>/adapter.ts` | `SiteAdapterFactory` |
| 新建 | `src/site-adapters/<site>/content.ts` | 页面入口（四行） |
| 修改 | `src/site-adapters/registry.ts` | 把定义加入 `bundledSites` |
| 修改 | `tests/site-adapter-build.test.ts` | 该测试固定了已注册的网站及打包文件名 |
| 新建 | `tests/site-adapter-<site>.test.ts` | 资格验证与该网站特有的用例 |
| 新建 | `e2e/mv3-site-adapter-<site>.spec.ts` | 针对路由模拟网站的浏览器检查 |
| 修改 | `CHANGELOG.md` | 在 `[Unreleased]` 下加一条 `Added` |

## 第 3 步：完整示例 Shelf

Shelf 是虚构网站（`.example` 是保留域名）。适配器假设该网站的行为如下：

- 文章页面位于 `https://shelf.example/a/<slug>`，slug 匹配 `[a-z0-9]{1,64}`。
- 每个页面都有 `<meta name="shelf:user" content="<十进制 ID>">`；未登录时 content 为空。
- 文章渲染为 `<article data-shelf-id="<slug>"><h1>标题</h1><button data-shelf-save aria-pressed="false">Save</button></article>`；收藏成功后，网站会把按钮设为 `aria-pressed="true"`。
- 每个账号只有一个名为 Saved 的列表。`GET /api/saved?limit=50&cursor=<c>` 返回 `{ "items": [{ "slug": "…", "title": "…" }], "next": "<游标>" | null }`；未登录时返回 401 或 403，被限流时返回 429。

示例声明了实时保存和导入这个列表两项能力。

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

### 注册

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

构建过程从注册表读取 `scripts` 和 `build`，输出 `site-adapter-shelf.js` 和 `site-adapter-bundles.json`；发布校验会检查其中列出的每一个打包文件。设置页侧栏列出所有已注册的网站，Shelf 的页面地址是 `site-adapters.html?adapterId=bundled.shelf`。

### 不那么显而易见的几处代码

- **不需要 `catalog.upsert`。** 规划一个书签需要账本中已有收藏夹的事实记录。设了 `defaultCollection` 时，宿主会自己写入：导入时写入，第一次提到该列表的实时保存也会写入。既没有 `defaultCollection` 也没有 `enumerateCollections` 的网站，必须在事件处理函数中（而不是在 `start` 函数体中）用 `catalog.upsert` 公布它看到的收藏夹，否则它的实时保存会以 `sourceFactsUnresolved` 结束。
- **`detectSource` 会等待 `DOMContentLoaded`，找不到 meta 标签时返回 `unknown`。** 脚本在 `document_start` 运行。`signedOut` 声明会隔离（fence）当前连接，而 `unknown` 只表示“稍后再试”。
- **不在 `start` 函数体中 emit。** 每次租约续期都会调用 `start`，在那里 emit 会让每个标签页大约每分钟多出一条账本记录。
- **`importResume`** 要同时在定义和适配器上声明，且两者必须一致。只有同一个游标总是返回同一页时，才可以用 `stableCursor`。
- **`contentIdScope: 'site'`**：因为同一个 Shelf 文章 ID 对所有账号都指向同一篇文章。私有或账号内才有效的 ID 不要设置这一项，宿主会把账号加入内容身份。
- **宿主限制**：每页最多 100 条，游标最长 512 个字符，ID 最长 128 个字符，标题最长 512 个 UTF-16 单位，每个分页结果最大 512 KiB，每条观察最大 256 KiB。超出时用 `capacity` 或 `invalidData` 失败，不要截断。

## 第 4 步：测试

`qualifySiteAdapter` 会用注册校验检查定义，确认声明的能力与已实现的方法一致，往返验证身份，并让每个已声明的读取方法通过封闭的传输 schema，包括续读游标的重放。在它旁边加上该网站特有的用例。

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

还要针对你的网站覆盖下列情况，fixture 取自真实响应并脱敏：

- 通过游标读到第二页；游标失效（`staleCursor`）
- 格式错误的行（得到 `coverage: 'partial'`）和重复行
- 读取中途登出、限流（带 `retryAfterMs` 的 `rateLimited`）、人机验证页面（`challenge`）
- 取消收藏的点击不发出任何内容；一直没有稳定下来的收藏发出 `favorite.uncertain`
- 观察逻辑所依赖的确切页面结构或响应

## 第 5 步：验证

在 `packages/extension` 下运行，只运行本次改动涉及的部分。只有改了宿主共享代码时，才运行 `npm run test:site-adapters`。浏览器测试必须在 xvfb 下运行。

```sh
npx vitest run tests/site-adapter-<site>.test.ts tests/site-adapter-build.test.ts tests/site-adapter-qualification.test.ts
npm run typecheck
npx eslint src/site-adapters/<site> src/site-adapters/registry.ts tests/site-adapter-<site>.test.ts tests/site-adapter-build.test.ts e2e/mv3-site-adapter-<site>.spec.ts
npm run build:development
KNOWN_E2E_HEADED=0 node scripts/with-xvfb.mjs npx playwright test --project=core e2e/mv3-site-adapter-<site>.spec.ts
npm run build && node scripts/verify-release-artifact.mjs dist/production
```

### 浏览器检查

这个 spec 用 `context.route` 模拟网站，通过共享的 X11 辅助函数授予权限。它开启该网站、确认账号、把列表映射到一个文件夹、点击 Save，然后等待原生书签出现。之后导入预览必须复用这个书签，而不是再建一个。

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

## `SiteDefinition` 字段

| 字段 | Shelf 的取值 | 何时修改 |
| --- | --- | --- |
| `adapterId` | `bundled.shelf` | 发布后不再修改。它是存储、端口和设置页的键。 |
| `siteKey`、`identityVersion` | `shelf`、`1` | 不要为了修正显示名称而改。新的身份版本需要经过审查的迁移。 |
| `label`、`icon` | `Shelf`、网站 favicon | `icon` 可以是打包的资源、经审计的 HTTPS 图片或 data URL |
| `origin`、`matches` | 一个源，`/*` | 网站上有适配器不应运行的区域时，收窄路径。只允许 HTTPS，不允许通配主机名。 |
| `connectionKind` | `account`（默认） | `page` 直接采用页面身份，不需要用户确认账号 |
| `capabilities`、`defaultCollection` | 实时保存加单个列表 | 见第 1 步 |
| `readScope` | `document` | 只有经过验证、可以从同一账号的其他标签页读取时，才用 `account` |
| `contentIdScope` | `site` | 私有或账号内 ID 不设置 |
| `collectionSnapshot` | `positiveOnly` | 只有经过验证的连续快照才用 `pointInTime`，它允许重新检查时推断移除 |
| `negativeReadback` | `false` | 只有声明了 `readMemberships`，并且能提供新鲜、限定范围的“不存在”证据时，才设为 `true` |
| `importResume` | `restartAndDeduplicate` | 只有游标能精确重放时，才用 `stableCursor` |
| `readPolicy` | 默认值 | 在宿主允许的范围内调整间隔、超时和重试次数 |
| `scripts`、`build` | `site-adapter-shelf.js`、`site-adapters/shelf/content.ts` | 只有经审计的 MAIN world 探针才需要加 `probe` |

## 网站状况与失败码的对应

使用 `src/site-adapters/read-errors.ts` 中的 `fail(code, retryAfterMs?, { httpStatus, sourceCode })` 抛出。诊断信息只包含状态数字，绝不包含响应体、URL 或凭据。

| 网站状况 | 失败码 |
| --- | --- |
| 401 或 403、登录页、账号不一致 | `signedOut` |
| 429 | `rateLimited`，附带 `retryAfterMs` |
| 验证码或机器人检测 | `challenge` |
| 5xx 响应或网络错误 | `network` |
| 超时（宿主也会强制截止时间） | `timeout` |
| `signal` 已中止 | `cancelled` |
| 响应或行数超出预算 | `capacity` |
| 结构与预期不符 | `invalidData` |
| 游标已失效 | `staleCursor` |
| 该 ID 或 URL 不受支持 | `unsupported` |
| 文档或标签页已不存在 | `pageUnavailable` |

## 已知的宿主缺口（2026-10-28）

1. **未打包构建中的时序不可靠。** `scheduleSourceWork`（`src/site-adapters/worker.ts`）同时会把恢复闹钟设在同一时刻。Chrome 只对打包后的扩展强制 30 秒的闹钟下限，所以在开发和 e2e 构建中，这个闹钟可能让来源任务大约每 60 毫秒重新运行一次，从而掩盖缺失的唤醒。要证明某个延迟结论，先等 worker 安静下来再操作。
2. 弹窗中的 “Save as semantic” 按钮只对 Bilibili 视频 URL 显示（`src/capture/manual-existence.ts:45`）。
3. 单独安装的社区包只接受 Bilibili 身份 v1，所以新网站只能作为内置适配器提供。
4. 旧版云端归档协议需要服务器端的身份编解码（`packages/server/src/modules/source-archives/site-registry.ts`），本地优先保存和同步则不需要。

## 进一步扩展

- **多个列表。** 加上 `enumerateCollections` 和 `readCollectionsPage`，返回平级的 `SourcePage<SiteCollection>`（`parentId: null`），并去掉 `defaultCollection`。有界游标缓冲与分页重放可参考 `bilibili/reader.ts`。
- **网站从不显示稳定状态。** 改走提示路径：经审计的 MAIN world 探针（`scripts.probe`/`build.probe`）派发页面事件，`start` 用 `deliverMembershipHint` 转发，宿主再通过节流后的 `readMemberships` 和 `resolveItem` 确认。这需要同时声明 `observeFavorites`、`readMemberships` 和 `resolveItem`。参见 `bilibili/probe.ts`、`bilibili/adapter.ts`、`hint-delivery.ts`。探针只能发送有界的 ID 和状态码。
- **大响应。** 在流式读取时累计字节数（`bilibili/http.ts` 中的 `boundedJson`）。把它移到共享模块，不要从别的网站目录引入。
- **背景阅读**（英文）：[authoring.md](authoring.md) 讲职责与证据，[runtime-foundation.md](runtime-foundation.md) 讲身份、隔离与恢复，[reconciliation.md](reconciliation.md) 讲重新检查；权威的类型定义在 `src/site-adapters/contracts.ts` 和 `registry-types.ts`。

## 最终报告

把下面的清单复制到最终回复中并逐项填写：

```text
- 第 1–6 项信息的答案及各自来源（页面、接口、fixture）：
- 声明的能力 = 已实现的方法 = 已写的测试：
- validateItem / validateMessage 拒绝其他一切：
- 单元测试（文件、通过数）：
- typecheck / eslint：
- xvfb 下的浏览器检查：
- 生产构建 + verify-release-artifact：
- 第 2 步列表以外改动的文件及理由（预期：无）：
- 真实网站测试（无，或经授权的测试账号 + 浏览器版本）：
- 影响该网站的已知宿主缺口：
```

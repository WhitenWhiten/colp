#!/usr/bin/env node
// Generates the README banner and diagrams in this folder, in English,
// Simplified Chinese, and Japanese, for GitHub's light and dark themes:
//
//   node docs/assets/generate.mjs
//
// Edit the copy and layouts here rather than the SVG files, then commit the
// regenerated files. Text widths are estimated from Inter, the first font in
// the stack, and every constrained label is checked against the space it has,
// so a translation that would overflow its box fails the run instead.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const latinFonts = "Inter, 'Segoe UI', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial";
const chineseFonts = "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC'";
const japaneseFonts = "'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Yu Gothic', Meiryo, 'Noto Sans CJK JP'";
const sansFonts = {
  en: `${latinFonts}, ${chineseFonts}, sans-serif`,
  'zh-CN': `${latinFonts}, ${chineseFonts}, sans-serif`,
  ja: `${latinFonts}, ${japaneseFonts}, sans-serif`,
};
const mono = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";

// Inter advance widths for U+0020 to U+007E, in hundredths of an em.
const regularWidths = [28, 29, 47, 63, 64, 98, 64, 30, 36, 36, 50, 66, 29, 46, 29, 36, 63, 41, 61, 62, 65, 61, 62, 57, 62, 62, 29, 30, 66, 66, 66, 51, 97, 69, 65, 73, 72, 60, 59, 75, 74, 27, 57, 67, 57, 90, 75, 76, 64, 76, 64, 64, 65, 74, 69, 99, 68, 68, 63, 36, 36, 36, 47, 46, 32, 56, 61, 57, 61, 58, 37, 61, 59, 24, 24, 55, 24, 88, 59, 60, 61, 61, 38, 53, 33, 59, 56, 82, 55, 56, 55, 43, 33, 43, 66];
const boldWidths = [28, 34, 55, 65, 65, 102, 67, 34, 38, 38, 56, 68, 33, 47, 33, 39, 67, 43, 63, 65, 68, 64, 65, 58, 65, 65, 33, 34, 68, 68, 68, 56, 102, 75, 66, 74, 72, 61, 59, 75, 75, 28, 58, 72, 57, 93, 76, 77, 65, 78, 66, 65, 67, 73, 75, 104, 74, 73, 66, 38, 39, 38, 49, 48, 37, 58, 63, 59, 63, 60, 40, 63, 62, 27, 27, 58, 27, 91, 62, 61, 63, 63, 41, 56, 37, 62, 60, 85, 58, 60, 57, 47, 37, 47, 68];

function measure(value, size, { weight = 400, monospace = false } = {}) {
  let ems = 0;
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code >= 0x2e80) ems += 1;
    else if (monospace) ems += 0.6;
    else if (code >= 0x20 && code <= 0x7e) ems += (weight >= 600 ? boldWidths : regularWidths)[code - 0x20] / 100;
    else ems += character === '·' ? 0.29 : 1;
  }
  return ems * size;
}

function fit(value, size, maxWidth, options) {
  const width = measure(value, size, options);
  if (width > maxWidth) {
    throw new Error(`"${value}" is ${Math.ceil(width)}px wide at ${size}px but has ${maxWidth}px.`);
  }
  return value;
}

// Light values are Primer's light theme; dark values are Primer's dark theme.
const neutrals = {
  light: {
    frame: '#ffffff', frameStroke: '#d1d9e0', card: '#f6f8fa', cardStroke: '#d1d9e0', raised: '#ffffff',
    ink: '#1f2328', muted: '#59636e', line: '#818b98', tint: 0.1, tintStroke: 0.4, highlight: 0.07,
  },
  dark: {
    frame: '#0d1117', frameStroke: '#3d444d', card: '#151b23', cardStroke: '#3d444d', raised: '#0d1117',
    ink: '#f0f6fc', muted: '#9198a1', line: '#656c76', tint: 0.14, tintStroke: 0.5, highlight: 0.1,
  },
};

// Each tone is [solid, ink]: solid for bars, dots, and lines; ink for text,
// chosen for at least 4.5:1 contrast on the card colors above.
const tones = {
  indigo: { light: ['#6366f1', '#4338ca'], dark: ['#818cf8', '#a5b4fc'] },
  sky: { light: ['#0ea5e9', '#0369a1'], dark: ['#38bdf8', '#7dd3fc'] },
  amber: { light: ['#f59e0b', '#b45309'], dark: ['#fbbf24', '#fcd34d'] },
  emerald: { light: ['#10b981', '#047857'], dark: ['#34d399', '#6ee7b7'] },
  pink: { light: ['#ec4899', '#be185d'], dark: ['#f472b6', '#f9a8d4'] },
  violet: { light: ['#8b5cf6', '#6d28d9'], dark: ['#a78bfa', '#c4b5fd'] },
  purple: { light: ['#a855f7', '#7e22ce'], dark: ['#c084fc', '#d8b4fe'] },
};

const profileTones = {
  core: 'indigo', publication: 'sky', feed: 'amber', publisher: 'emerald', sync: 'pink', 'mcp-read': 'violet', 'mcp-write': 'purple',
};

function themeFor(mode) {
  return {
    ...neutrals[mode],
    tone(name) {
      const [solid, ink] = tones[name][mode];
      return { solid, ink };
    },
  };
}

const copy = {
  en: {
    banner: {
      title: 'The Collection Protocol (COLP)',
      desc: 'An open protocol for bookmarks and knowledge collections. Publish them, sync them, and let AI curate them, under your control.',
      meta: 'Open specification · v0.1 draft',
      tagline: ['An open protocol for bookmarks and knowledge collections.', 'Publish them, sync them, and let AI curate them, under your control.'],
      tree: ['Interface Systems', 'Design Tokens', 'Motion Guide', 'Typography', 'Type Scale'],
      targets: [['Publish', 'Websites and feeds'], ['Sync', 'Across browsers'], ['Curate with AI', 'Through MCP']],
    },
    architecture: {
      title: 'How COLP fits together',
      desc: 'Four kinds of clients connect to one COLP server, each through its own profile. Browser bookmarks sync with it; apps and scripts write to it through publisher; readers and websites read snapshots and feeds through publication and feed; AI assistants use it through mcp-read and mcp-write. The server exposes a Manifest, the data model, a change log, and security.',
      subtitle: 'One server, four kinds of clients. Each connection is a profile you can implement on its own.',
      clients: [
        ['Browser bookmarks', 'Chromium · Firefox · Safari'],
        ['Apps and scripts', 'Create, edit, release'],
        ['Readers and websites', 'Pages · JSON Feed · Atom'],
        ['AI assistants', 'Any MCP client'],
      ],
      server: ['COLP server', 'Any conforming implementation'],
      discovery: 'GET /.well-known/collection-protocol',
      layers: [['Manifest', 'Profiles and endpoints'], ['Data model', 'Nodes and sidecars'], ['Change log', 'Operations, tombstones'], ['Security', 'Scopes, ACL, audit']],
      footer: 'Implement only what you need: a static site serving core + publication is already a complete COLP server.',
    },
    dataModel: {
      title: 'COLP data model',
      desc: 'A Collection contains a root node, folders, bookmarks, separators, and aliases. Annotations, attachments, and relations attach to nodes as sidecar data.',
      tree: {
        collection: 'Interface Systems', bar: 'Bookmarks bar', tokens: 'Design Tokens', alias: '→ Motion Guide', other: 'Other bookmarks', motion: 'Motion Guide',
      },
      sidecars: [
        ['Annotation', 'note · summary · highlight · rating', 'Notes, with provenance for AI-written ones'],
        ['Attachment', 'rel · url · mimeType · digest', 'Metadata for files and page captures'],
        ['Relation', 'related · supports · derived_from · …', 'Typed links between two nodes'],
      ],
      footer: ['Order uses opaque position keys, so concurrent inserts never renumber siblings.', 'Deletes leave tombstones, so every replica learns about them before they are purged.'],
    },
    syncFlow: {
      title: 'COLP two-way sync',
      desc: 'A browser replica opens a session, bootstraps from a snapshot, pushes queued operations, pulls changes after its cursor, and acknowledges progress.',
      actors: [['Browser replica', 'Adapter + local sidecar'], ['COLP server', 'Authoritative state + operation log']],
      steps: [
        ['Open a session', 'Replica binding, scopes, protocol version'],
        ['Bootstrap', 'One complete Sync Snapshot'],
        ['Push operations', 'Each result: applied · rebased · conflicted'],
        ['Pull changes', 'Operations and conflicts after the cursor'],
        ['Acknowledge', 'Lets the server purge old tombstones'],
      ],
      note: 'User edits bookmarks → queued operations (seq 1, 2, 3)',
    },
    profiles: {
      title: 'COLP conformance profiles',
      desc: 'Profile dependency graph: publication, sync, and mcp-read build on core; feed and publisher build on publication; mcp-write builds on mcp-read and publisher. Core and publication together are a complete static server.',
      descriptions: {
        core: 'Data model and Snapshot', publication: 'Discovery and read API', feed: 'Public change feed', publisher: 'Authenticated writes',
        sync: 'Two-way replica sync', 'mcp-read': 'AI read access', 'mcp-write': 'AI writes with approval',
      },
      start: 'Start here: a static site can serve both',
      footer: 'Each profile builds on the ones that point to it. A server declares only the profiles it fully passes.',
    },
  },
  'zh-CN': {
    banner: {
      title: 'The Collection Protocol (COLP)',
      desc: '面向书签与知识集合的开放协议。发布、同步，并让 AI 在你的掌控下整理收藏。',
      meta: '开放规范 · v0.1 草案',
      tagline: ['面向书签与知识集合的开放协议。', '发布、同步，并让 AI 在你的掌控下整理收藏。'],
      tree: ['界面系统', '设计令牌', '动效指南', '排版', '字号阶梯'],
      targets: [['发布', '网站与订阅'], ['同步', '跨浏览器'], ['AI 整理', '通过 MCP']],
    },
    architecture: {
      title: 'COLP 的整体结构',
      desc: '四类客户端通过各自的 Profile 连接到同一个 COLP 服务器：浏览器书签与它同步；应用与脚本通过 publisher 写入；阅读器与网站通过 publication 和 feed 读取快照与订阅；AI 助手通过 mcp-read 和 mcp-write 使用它。服务器提供 Manifest、数据模型、变更日志与安全层。',
      subtitle: '一个服务器，四类客户端。每种连接都是可以单独实现的 Profile。',
      clients: [
        ['浏览器书签', 'Chromium · Firefox · Safari'],
        ['应用与脚本', '创建、编辑、发布版本'],
        ['阅读器与网站', '页面 · JSON Feed · Atom'],
        ['AI 助手', '任意 MCP 客户端'],
      ],
      server: ['COLP 服务器', '任何符合规范的实现'],
      discovery: 'GET /.well-known/collection-protocol',
      layers: [['Manifest', 'Profile 与端点'], ['数据模型', 'Node 与附加数据'], ['变更日志', '操作与墓碑'], ['安全', '作用域、ACL、审计']],
      footer: '只实现你需要的部分：只提供 core + publication 的静态站点，就已经是完整的 COLP 服务器。',
    },
    dataModel: {
      title: 'COLP 数据模型',
      desc: '一个 Collection 包含根节点、文件夹、书签、分隔线与别名；批注、附件与关系作为附加数据挂在节点上。',
      tree: {
        collection: '界面系统', bar: '书签栏', tokens: '设计令牌', alias: '→ 动效指南', other: '其他书签', motion: '动效指南',
      },
      sidecars: [
        ['Annotation 批注', 'note · summary · highlight · rating', '可附在任意节点上；AI 生成的批注带有来源信息'],
        ['Attachment 附件', 'rel · url · mimeType · digest', '文件与网页存档的元数据'],
        ['Relation 关系', 'related · supports · derived_from · …', '两个节点之间的类型化链接'],
      ],
      footer: ['顺序使用不透明的 position 键，并发插入不会让兄弟节点重新编号。', '删除会留下墓碑，确保每个副本在清理前都能得知删除。'],
    },
    syncFlow: {
      title: 'COLP 双向同步',
      desc: '浏览器副本打开会话，从快照初始化，推送本地队列中的操作，拉取游标之后的变更，并确认进度。',
      actors: [['浏览器副本', '适配器 + 本地 Sidecar'], ['COLP 服务器', '权威状态 + 操作日志']],
      steps: [
        ['打开会话', '副本绑定、作用域、协议版本'],
        ['初始化', '一份完整的 Sync Snapshot'],
        ['推送操作', '逐条结果：applied · rebased · conflicted'],
        ['拉取变更', '游标之后的操作与冲突'],
        ['确认进度', '服务器据此清理旧墓碑'],
      ],
      note: '用户编辑书签 → 本地队列中的操作（seq 1, 2, 3）',
    },
    profiles: {
      title: 'COLP 一致性 Profile',
      desc: 'Profile 依赖图：publication、sync、mcp-read 建立在 core 之上；feed 与 publisher 建立在 publication 之上；mcp-write 建立在 mcp-read 与 publisher 之上。core 与 publication 合起来就是完整的静态服务器。',
      descriptions: {
        core: '数据模型与 Snapshot', publication: '发现与只读 API', feed: '公开变更订阅', publisher: '认证写入',
        sync: '双向副本同步', 'mcp-read': 'AI 只读访问', 'mcp-write': '经用户批准的 AI 写入',
      },
      start: '从这里开始：静态站点即可提供这两项',
      footer: '每个 Profile 建立在指向它的 Profile 之上。服务器只声明自己完整通过的 Profile。',
    },
  },
  ja: {
    banner: {
      title: 'The Collection Protocol (COLP)',
      desc: 'ブックマークと知識コレクションのためのオープンなプロトコル。公開も、同期も、AI による整理も、あなたの管理下で。',
      meta: 'オープン仕様 · v0.1 ドラフト',
      tagline: ['ブックマークと知識コレクションのためのオープンなプロトコル。', '公開も、同期も、AI による整理も、あなたの管理下で。'],
      tree: ['デザインシステム', 'デザイントークン', 'モーションガイド', 'タイポグラフィ', '文字サイズ'],
      targets: [['公開', 'サイトとフィード'], ['同期', 'ブラウザー間で'], ['AI で整理', 'MCP 経由']],
    },
    architecture: {
      title: 'COLP の全体像',
      desc: '4 種類のクライアントが、それぞれのプロファイルを通じて 1 つの COLP サーバーにつながります。ブラウザーのブックマークは sync で同期し、アプリとスクリプトは publisher で書き込み、リーダーと Web サイトは publication と feed でスナップショットとフィードを読み、AI アシスタントは mcp-read と mcp-write で利用します。サーバーは Manifest、データモデル、変更ログ、セキュリティを提供します。',
      subtitle: '1 つのサーバーに 4 種類のクライアント。接続ごとに、個別に実装できるプロファイルがあります。',
      clients: [
        ['ブラウザーブックマーク', 'Chromium · Firefox · Safari'],
        ['アプリとスクリプト', '作成・編集・リリース'],
        ['リーダーと Web サイト', 'ページ · JSON Feed · Atom'],
        ['AI アシスタント', '任意の MCP クライアント'],
      ],
      server: ['COLP サーバー', '仕様に準拠した任意の実装'],
      discovery: 'GET /.well-known/collection-protocol',
      layers: [['Manifest', 'プロファイルと URL'], ['データモデル', 'Node とサイドカー'], ['変更ログ', '操作とトゥームストーン'], ['セキュリティ', 'スコープ・ACL・監査']],
      footer: '必要な部分だけ実装すれば十分です。core + publication を提供する静的サイトだけでも、完全な COLP サーバーになります。',
    },
    dataModel: {
      title: 'COLP のデータモデル',
      desc: '1 つの Collection は、ルートノード、フォルダー、ブックマーク、区切り線、エイリアスを含みます。注釈、添付、関係はサイドカーデータとしてノードに付きます。',
      tree: {
        collection: 'デザインシステム', bar: 'ブックマークバー', tokens: 'デザイントークン', alias: '→ モーションガイド', other: 'その他のブックマーク', motion: 'モーションガイド',
      },
      sidecars: [
        ['Annotation 注釈', 'note · summary · highlight · rating', 'ノードへのメモ。AI が書いたものは出所付き'],
        ['Attachment 添付', 'rel · url · mimeType · digest', 'ファイルや保存したページのメタデータ'],
        ['Relation 関係', 'related · supports · derived_from · …', '2 つのノードをつなぐ型付きリンク'],
      ],
      footer: ['並び順は不透明な position キーで表すため、同時に挿入しても兄弟ノードの番号は振り直されません。', '削除はトゥームストーンを残すため、どのレプリカも完全に消える前に削除を知ることができます。'],
    },
    syncFlow: {
      title: 'COLP の双方向同期',
      desc: 'ブラウザーのレプリカがセッションを開き、スナップショットからブートストラップし、キューに溜めた操作をプッシュし、カーソル以降の変更をプルして、進捗を確認応答します。',
      actors: [['ブラウザーのレプリカ', 'アダプター + ローカルのサイドカー'], ['COLP サーバー', '正となる状態 + 操作ログ']],
      steps: [
        ['セッションを開く', 'レプリカの紐付け、スコープ、プロトコルバージョン'],
        ['ブートストラップ', '1 つの完全な Sync Snapshot'],
        ['操作をプッシュ', '操作ごとの結果：applied · rebased · conflicted'],
        ['変更をプル', 'カーソル以降の操作と競合'],
        ['確認応答', 'サーバーが古いトゥームストーンを削除できる'],
      ],
      note: 'ブックマークを編集 → 操作がキューに入る（seq 1, 2, 3）',
    },
    profiles: {
      title: 'COLP の適合プロファイル',
      desc: 'プロファイルの依存関係：publication、sync、mcp-read は core の上に、feed と publisher は publication の上に、mcp-write は mcp-read と publisher の上に成り立ちます。core と publication だけで完全な静的サーバーになります。',
      descriptions: {
        core: 'データモデルと Snapshot', publication: '探索と読み取り API', feed: '公開の変更フィード', publisher: '認証付きの書き込み',
        sync: '双方向のレプリカ同期', 'mcp-read': 'AI による読み取り', 'mcp-write': '承認付きの AI 書き込み',
      },
      start: 'ここから始める：静的サイトでも両方を提供できます',
      footer: '各プロファイルは、矢印の出元にあるプロファイルの上に成り立ちます。サーバーは完全に満たすプロファイルだけを宣言します。',
    },
  },
};

// SVG building blocks.

function format(number) {
  return String(Math.round(number * 100) / 100);
}

function escape(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function tag(name, attributes, content) {
  const list = Object.entries(attributes)
    .filter(([, value]) => value !== undefined && value !== false)
    .map(([key, value]) => ` ${key}="${typeof value === 'number' ? format(value) : escape(value)}"`)
    .join('');
  return content === undefined ? `<${name}${list}/>` : `<${name}${list}>${content}</${name}>`;
}

function rect(x, y, width, height, rx, paint) {
  return tag('rect', { x, y, width, height, rx, ...paint });
}

function text(x, y, value, { size = 14, weight, fill, anchor, monospace, spacing } = {}) {
  return tag('text', {
    x, y, 'font-size': size, 'font-weight': weight, fill, 'text-anchor': anchor, 'letter-spacing': spacing, class: monospace ? 'mono' : undefined,
  }, escape(value));
}

function path(d, paint) {
  return tag('path', { d, ...paint });
}

/** A filled triangle whose tip is at (x, y), pointing along (dx, dy). */
function arrowHead(x, y, dx, dy, fill, size = 9) {
  const length = Math.hypot(dx, dy);
  const ux = dx / length;
  const uy = dy / length;
  const bx = x - ux * size;
  const by = y - uy * size;
  const px = -uy * size * 0.5;
  const py = ux * size * 0.5;
  return path(`M${format(x)} ${format(y)}L${format(bx + px)} ${format(by + py)}L${format(bx - px)} ${format(by - py)}Z`, { fill });
}

/** A rounded pill with centered text; `x` is its left edge, or its center with `center: true`. */
function pill(x, cy, label, tone, theme, { size = 13, height = 26, center = false, monospace = true, opaque } = {}) {
  const width = Math.ceil(measure(label, size, { weight: 600, monospace })) + 24;
  const left = center ? x - width / 2 : x;
  const top = cy - height / 2;
  const base = opaque === undefined ? '' : rect(left, top, width, height, height / 2, { fill: opaque });
  return {
    width,
    svg: base
      + rect(left, top, width, height, height / 2, { fill: tone.solid, 'fill-opacity': theme.tint, stroke: tone.solid, 'stroke-opacity': theme.tintStroke })
      + text(left + width / 2, cy + size * 0.35, label, { size, weight: 600, fill: tone.ink, anchor: 'middle', monospace }),
  };
}

function card(x, y, width, height, theme, fill = theme.card) {
  return rect(x, y, width, height, 12, { fill, stroke: theme.cardStroke });
}

function accentBar(x, y, height, tone) {
  return rect(x, y, 4, height, 2, { fill: tone.solid });
}

function mark(x, y, size) {
  return tag('g', { transform: `translate(${format(x)} ${format(y)}) scale(${format(size / 64)})` }, [
    rect(0, 0, 64, 64, 16, { fill: 'url(#mark)' }),
    path('M21 14h22a3 3 0 0 1 3 3v35.5a1.5 1.5 0 0 1-2.4 1.2L32 45l-11.6 8.7A1.5 1.5 0 0 1 18 52.5V17a3 3 0 0 1 3-3z', { fill: '#ffffff' }),
    rect(24, 22, 16, 3.2, 1.6, { fill: '#6366f1' }),
    rect(24, 29, 11, 3.2, 1.6, { fill: '#14b8a6' }),
    rect(24, 36, 14, 3.2, 1.6, { fill: '#8b5cf6' }),
  ].join(''));
}

const markGradient = '<linearGradient id="mark" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2dd4bf"/><stop offset="1" stop-color="#6366f1"/></linearGradient>';

function bookmarkIcon(x, y, fill) {
  return path(`M${x} ${y + 2}a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v17l-7-5-7 5z`, { fill });
}

function folderIcon(x, y, width, height, fill) {
  const tab = Math.round(width * 0.35);
  return path(`M${x} ${y + 3}a3 3 0 0 1 3-3h${tab}l4 4H${x + width - 3}a3 3 0 0 1 3 3V${y + height - 3}a3 3 0 0 1-3 3H${x + 3}a3 3 0 0 1-3-3z`, { fill });
}

function svgDocument({ width, height, lang, title, desc, defs = '', body }) {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc" xml:lang="${lang}">`,
    tag('title', { id: 'title' }, escape(title)),
    tag('desc', { id: 'desc' }, escape(desc)),
    `<style>text{font-family:${sansFonts[lang]}}.mono{font-family:${mono}}</style>`,
    ...(defs === '' ? [] : [`<defs>${defs}</defs>`]),
    ...body,
    '</svg>',
    '',
  ].join('\n');
}

function frame(width, height, theme) {
  return rect(0.5, 0.5, width - 1, height - 1, 16, { fill: theme.frame, stroke: theme.frameStroke });
}

// Banner.

const bannerPalettes = {
  light: {
    background: ['#ffffff', '#f5f7ff', '#eaeefe'], border: '#d1d9e0', dots: ['#0f172a', 0.07], glows: [['#2dd4bf', 0.22], ['#8b5cf6', 0.16]],
    title: '#0f172a', tagline: '#334155', meta: '#64748b', wordmark: '#0f766e',
    panel: ['#ffffff', 0.85, '#cbd5e1', 1], row: '#1e293b', skeleton: ['#0f172a', 0.08], target: ['#ffffff', 0.92], targetText: '#0f172a', targetMuted: '#475569', hub: '#64748b',
  },
  dark: {
    background: ['#0b1022', '#121a3a', '#1e1b4b'], border: undefined, dots: ['#ffffff', 0.07], glows: [['#2dd4bf', 0.3], ['#8b5cf6', 0.26]],
    title: '#f8fafc', tagline: '#cbd5e1', meta: '#94a3b8', wordmark: '#5eead4',
    panel: ['#ffffff', 0.06, '#ffffff', 0.16], row: '#e2e8f0', skeleton: ['#ffffff', 0.12], target: ['#0b1022', 0.55], targetText: '#f8fafc', targetMuted: '#94a3b8', hub: '#e2e8f0',
  },
};

function banner(lang, mode) {
  const words = copy[lang].banner;
  const palette = bannerPalettes[mode];
  const width = 1280;
  const height = 400;
  const [backgroundFrom, backgroundMiddle, backgroundTo] = palette.background;
  const targetTones = ['sky', 'pink', 'violet'].map((name) => themeFor(mode).tone(name));
  const defs = [
    `<linearGradient id="background" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${backgroundFrom}"/><stop offset="0.55" stop-color="${backgroundMiddle}"/><stop offset="1" stop-color="${backgroundTo}"/></linearGradient>`,
    ...palette.glows.map(([color, opacity], index) => `<radialGradient id="glow${index}" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="${color}" stop-opacity="${opacity}"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient>`),
    `<pattern id="dots" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1" fill="${palette.dots[0]}" fill-opacity="${palette.dots[1]}"/></pattern>`,
    `<clipPath id="clip"><rect width="${width}" height="${height}" rx="24"/></clipPath>`,
    markGradient,
    ...targetTones.map((tone, index) => `<linearGradient id="wire${index}" gradientUnits="userSpaceOnUse" x1="970" y1="0" x2="1020" y2="0"><stop offset="0" stop-color="${palette.hub}" stop-opacity="0.5"/><stop offset="1" stop-color="${tone.solid}"/></linearGradient>`),
  ].join('');

  const body = [
    tag('g', { 'clip-path': 'url(#clip)' }, [
      rect(0, 0, width, height, undefined, { fill: 'url(#background)' }),
      rect(0, 0, width, height, undefined, { fill: 'url(#dots)' }),
      tag('circle', { cx: 1130, cy: 60, r: 340, fill: 'url(#glow0)' }),
      tag('circle', { cx: 240, cy: 430, r: 380, fill: 'url(#glow1)' }),
    ].join('')),
  ];
  if (palette.border !== undefined) body.push(rect(0.5, 0.5, width - 1, height - 1, 24, { fill: 'none', stroke: palette.border }));

  body.push(
    mark(80, 84, 64),
    text(164, 112, 'COLP', { size: 20, weight: 700, fill: palette.wordmark, monospace: true, spacing: 5 }),
    text(164, 139, words.meta, { size: 15, fill: palette.meta }),
    text(78, 234, fit('The Collection Protocol', 56, 650, { weight: 700 }), { size: 56, weight: 800, fill: palette.title, spacing: -1 }),
    ...words.tagline.map((line, index) => text(80, 280 + index * 32, fit(line, 20, 670), { size: 20, fill: palette.tagline })),
  );

  // A collection on the left feeding the three things COLP does with it.
  const [panelFill, panelOpacity, panelStroke, panelStrokeOpacity] = palette.panel;
  body.push(rect(760, 96, 210, 208, 18, { fill: panelFill, 'fill-opacity': panelOpacity, stroke: panelStroke, 'stroke-opacity': panelStrokeOpacity }));
  const [collection, ...items] = words.tree;
  body.push(
    folderIcon(780, 117, 26, 20, '#f59e0b'),
    text(816, 133, fit(collection, 15, 140, { weight: 700 }), { size: 15, weight: 700, fill: palette.row }),
  );
  const rows = [
    { icon: 'bookmark', x: 794, label: items[0] },
    { icon: 'bookmark', x: 794, label: items[1] },
    { icon: 'folder', x: 792, label: items[2] },
    { icon: 'bookmark', x: 818, label: items[3] },
  ];
  rows.forEach((row, index) => {
    const y = 160 + index * 36;
    const labelX = row.x + 26;
    body.push(
      row.icon === 'bookmark' ? bookmarkIcon(row.x, y, '#38bdf8') : folderIcon(row.x - 2, y + 2, 20, 16, '#f59e0b'),
      text(labelX, y + 14, fit(row.label, 15, 955 - labelX), { size: 15, fill: palette.row }),
      rect(labelX, y + 21, 64, 4, 2, { fill: palette.skeleton[0], 'fill-opacity': palette.skeleton[1] }),
    );
  });

  words.targets.forEach(([title, detail], index) => {
    const tone = targetTones[index];
    const y = 88 + index * 80;
    body.push(
      path(`M970 200C995 200 995 ${y + 32} 1020 ${y + 32}`, { fill: 'none', stroke: `url(#wire${index})`, 'stroke-width': 2.5 }),
      rect(1020, y, 180, 64, 14, { fill: palette.target[0], 'fill-opacity': palette.target[1], stroke: tone.solid, 'stroke-opacity': 0.8 }),
      tag('circle', { cx: 1040, cy: y + 25, r: 5, fill: tone.solid }),
      text(1054, y + 30, fit(title, 18, 132, { weight: 700 }), { size: 18, weight: 700, fill: palette.targetText }),
      text(1036, y + 51, fit(detail, 15, 152), { size: 15, fill: palette.targetMuted }),
    );
  });
  body.push(tag('circle', { cx: 970, cy: 200, r: 4.5, fill: palette.hub }));

  return svgDocument({ width, height, lang, title: words.title, desc: words.desc, defs, body });
}

// How COLP fits together: four kinds of clients above one server.

function architecture(lang, mode) {
  const words = copy[lang].architecture;
  const theme = themeFor(mode);
  const width = 1000;
  const height = 520;
  const body = [
    frame(width, height, theme),
    text(40, 52, words.title, { size: 22, weight: 700, fill: theme.ink }),
    text(40, 80, fit(words.subtitle, 15, 920), { size: 15, fill: theme.muted }),
  ];

  const connections = [
    { profiles: ['sync'], up: true, down: true },
    { profiles: ['publisher'], up: false, down: true },
    { profiles: ['publication', 'feed'], up: true, down: false },
    { profiles: ['mcp-read', 'mcp-write'], up: true, down: true },
  ];
  const cardTop = 108;
  const cardHeight = 84;
  const serverTop = 290;
  words.clients.forEach(([name, detail], index) => {
    const x = 40 + index * 235;
    const center = x + 107.5;
    const connection = connections[index];
    body.push(
      card(x, cardTop, 215, cardHeight, theme),
      text(x + 18, cardTop + 35, fit(name, 16, 180, { weight: 700 }), { size: 16, weight: 700, fill: theme.ink }),
      text(x + 18, cardTop + 60, fit(detail, 14, 182), { size: 14, fill: theme.muted }),
    );
    const top = cardTop + cardHeight + (connection.up ? 10 : 0);
    const bottom = serverTop - (connection.down ? 10 : 0);
    body.push(tag('line', { x1: center, y1: top, x2: center, y2: bottom, stroke: theme.line, 'stroke-width': 2 }));
    if (connection.up) body.push(arrowHead(center, cardTop + cardHeight + 1, 0, -1, theme.line, 11));
    if (connection.down) body.push(arrowHead(center, serverTop - 1, 0, 1, theme.line, 11));
    const pills = connection.profiles.map((profile) => pill(0, 0, profile, theme.tone(profileTones[profile]), theme));
    const gap = 6;
    const total = pills.reduce((sum, item) => sum + item.width, 0) + gap * (pills.length - 1);
    if (total > 205) throw new Error(`Profiles for ${name} do not fit under its card.`);
    let left = center - total / 2;
    for (const profile of connection.profiles) {
      const placed = pill(left, (cardTop + cardHeight + serverTop) / 2, profile, theme.tone(profileTones[profile]), theme, { opaque: theme.frame });
      body.push(placed.svg);
      left += placed.width + gap;
    }
  });

  const serverHeight = 172;
  const [serverName, serverDetail] = words.server;
  body.push(
    card(40, serverTop, 920, serverHeight, theme),
    mark(60, serverTop + 20, 40),
    text(114, serverTop + 38, serverName, { size: 18, weight: 700, fill: theme.ink }),
    text(114, serverTop + 60, serverDetail, { size: 14, fill: theme.muted }),
    text(940, serverTop + 46, words.discovery, { size: 13, fill: theme.muted, anchor: 'end', monospace: true }),
  );
  const layerTones = ['sky', 'indigo', 'pink', 'emerald'];
  words.layers.forEach(([name, detail], index) => {
    const x = 60 + index * 224;
    const y = serverTop + 84;
    const tone = theme.tone(layerTones[index]);
    body.push(
      card(x, y, 208, 68, theme, theme.raised),
      accentBar(x + 14, y + 16, 36, tone),
      text(x + 30, y + 30, fit(name, 15, 166, { weight: 700 }), { size: 15, weight: 700, fill: theme.ink }),
      text(x + 30, y + 52, fit(detail, 14, 166), { size: 14, fill: theme.muted }),
    );
  });
  body.push(text(40, serverTop + serverHeight + 38, fit(words.footer, 14, 920), { size: 14, fill: theme.muted }));

  return svgDocument({ width, height, lang, title: words.title, desc: words.desc, defs: markGradient, body });
}

// Data model: the Node tree on the left, sidecars attached to one bookmark on the right.

function dataModel(lang, mode) {
  const words = copy[lang].dataModel;
  const theme = themeFor(mode);
  const width = 1000;
  const height = 476;
  const kindTones = { collection: 'indigo', root: undefined, folder: 'amber', bookmark: 'sky', separator: undefined, alias: 'violet' };
  const neutral = { solid: theme.line, ink: theme.muted };
  const tree = words.tree;
  const rows = [
    { level: 0, kind: 'collection', label: tree.collection, meta: 'visibility: public' },
    { level: 1, kind: 'root' },
    { level: 2, kind: 'folder', label: tree.bar, meta: 'bookmarks-bar' },
    { level: 3, kind: 'bookmark', label: tree.tokens, meta: 'url · tags · position', highlight: true },
    { level: 3, kind: 'separator' },
    { level: 3, kind: 'alias', label: tree.alias },
    { level: 2, kind: 'folder', label: tree.other, meta: 'other-bookmarks' },
    { level: 3, kind: 'bookmark', label: tree.motion },
  ];
  const panel = { x: 28, y: 28, width: 532, rowHeight: 42, firstRow: 62 };
  const body = [frame(width, height, theme), card(panel.x, panel.y, panel.width, panel.firstRow - panel.y + (rows.length - 1) * panel.rowHeight + 34, theme)];
  const pillLeft = (level) => panel.x + 24 + level * 28;
  const highlightRow = rows.findIndex((row) => row.highlight);
  const highlightY = panel.firstRow + highlightRow * panel.rowHeight;
  const highlightRight = panel.x + panel.width - 14;
  const sky = theme.tone('sky');
  body.push(rect(pillLeft(3) - 8, highlightY - 17, highlightRight - pillLeft(3) + 8, 34, 9, { fill: sky.solid, 'fill-opacity': theme.highlight }));

  // Tree guides: from each parent's pill down to its children.
  rows.forEach((row, index) => {
    if (row.level === 0) return;
    const parent = rows.slice(0, index).findLastIndex((candidate) => candidate.level === row.level - 1);
    const x = pillLeft(row.level - 1) + 12;
    const top = panel.firstRow + parent * panel.rowHeight + 13;
    const y = panel.firstRow + index * panel.rowHeight;
    body.push(path(`M${x} ${top}V${y - 8}Q${x} ${y} ${x + 8} ${y}H${pillLeft(row.level) - 4}`, { fill: 'none', stroke: theme.cardStroke, 'stroke-width': 1.5 }));
  });
  rows.forEach((row, index) => {
    const y = panel.firstRow + index * panel.rowHeight;
    const tone = kindTones[row.kind] === undefined ? neutral : theme.tone(kindTones[row.kind]);
    const kind = pill(pillLeft(row.level), y, row.kind, tone, theme, { opaque: theme.card });
    body.push(kind.svg);
    let x = pillLeft(row.level) + kind.width + 12;
    if (row.label !== undefined) {
      const weight = row.level === 0 ? 700 : 400;
      body.push(text(x, y + 5.5, row.label, { size: 15, weight, fill: theme.ink }));
      x += measure(row.label, 15, { weight }) + 16;
    }
    if (row.meta !== undefined) {
      if (x + measure(row.meta, 13, { monospace: true }) > highlightRight - 8) throw new Error(`Row ${row.label} overflows the tree panel.`);
      body.push(text(x, y + 5, row.meta, { size: 13, fill: theme.muted, monospace: true }));
    }
  });

  // Sidecars, connected to the highlighted bookmark.
  const sidecarTones = ['pink', 'emerald', 'violet'];
  const sidecarX = 612;
  const sidecarWidth = 360;
  const sidecarHeight = 98;
  const panelBottom = panel.firstRow + (rows.length - 1) * panel.rowHeight + 34;
  const stackTop = (panel.y + panelBottom) / 2 - (3 * sidecarHeight + 2 * 16) / 2;
  words.sidecars.forEach(([name, kinds, detail], index) => {
    const y = stackTop + index * (sidecarHeight + 16);
    const tone = theme.tone(sidecarTones[index]);
    const middle = y + sidecarHeight / 2;
    body.push(
      path(`M${highlightRight} ${highlightY}C${highlightRight + 30} ${highlightY} ${sidecarX - 30} ${middle} ${sidecarX} ${middle}`, { fill: 'none', stroke: theme.line, 'stroke-width': 1.5, 'stroke-dasharray': '4 4' }),
      card(sidecarX, y, sidecarWidth, sidecarHeight, theme),
      accentBar(sidecarX + 14, y + 16, sidecarHeight - 32, tone),
      text(sidecarX + 30, y + 30, fit(name, 16, 314, { weight: 700 }), { size: 16, weight: 700, fill: theme.ink }),
      text(sidecarX + 30, y + 54, fit(kinds, 13, 314, { monospace: true }), { size: 13, fill: tone.ink, monospace: true }),
      text(sidecarX + 30, y + 78, fit(detail, 14, 314), { size: 14, fill: theme.muted }),
    );
  });
  body.push(tag('circle', { cx: highlightRight, cy: highlightY, r: 4, fill: theme.line }));
  words.footer.forEach((line, index) => {
    body.push(text(28, panelBottom + 34 + index * 22, fit(line, 14, 936), { size: 14, fill: theme.muted }));
  });

  return svgDocument({ width, height, lang, title: words.title, desc: words.desc, body });
}

// Two-way sync as a sequence diagram.

function syncFlow(lang, mode) {
  const words = copy[lang].syncFlow;
  const theme = themeFor(mode);
  const width = 1000;
  const height = 584;
  const replicaX = 230;
  const serverX = 740;
  const replica = theme.tone('pink');
  const server = theme.tone('indigo');
  const body = [frame(width, height, theme)];

  words.actors.forEach(([name, detail], index) => {
    const center = index === 0 ? replicaX : serverX;
    const tone = index === 0 ? replica : server;
    body.push(
      card(center - 140, 28, 280, 70, theme),
      rect(center - 140, 28, 280, 4, 2, { fill: tone.solid }),
      text(center, 60, name, { size: 17, weight: 700, fill: theme.ink, anchor: 'middle' }),
      text(center, 82, fit(detail, 14, 256), { size: 14, fill: theme.muted, anchor: 'middle' }),
    );
  });
  const lifelineBottom = height - 28;
  for (const x of [replicaX, serverX]) {
    body.push(tag('line', { x1: x, y1: 98, x2: x, y2: lifelineBottom, stroke: theme.line, 'stroke-width': 1.5, 'stroke-dasharray': '5 5' }));
  }

  const endpoints = ['syncSessions', 'syncSnapshot', 'syncPush', 'syncPull', 'syncAck'];
  const towardServer = [true, false, true, false, true];
  const blockTops = [126, 206, 344, 424, 504];
  words.steps.forEach(([title, detail], index) => {
    const top = blockTops[index];
    const tone = towardServer[index] ? replica : server;
    const titleWidth = measure(title, 16, { weight: 700 });
    const groupLeft = (replicaX + serverX) / 2 - (titleWidth + 32) / 2;
    const arrowY = top + 20;
    const [from, to] = towardServer[index] ? [replicaX, serverX] : [serverX, replicaX];
    const direction = Math.sign(to - from);
    body.push(
      tag('circle', { cx: groupLeft + 12, cy: top - 6, r: 12, fill: tone.solid }),
      text(groupLeft + 12, top - 1.5, String(index + 1), { size: 13, weight: 700, fill: '#ffffff', anchor: 'middle' }),
      text(groupLeft + 32, top, title, { size: 16, weight: 700, fill: theme.ink }),
      tag('line', { x1: from, y1: arrowY, x2: to - direction * 10, y2: arrowY, stroke: tone.solid, 'stroke-width': 2 }),
      arrowHead(to, arrowY, direction, 0, tone.solid, 11),
      text((replicaX + serverX) / 2, arrowY + 26, fit(detail, 14, 480), { size: 14, fill: theme.muted, anchor: 'middle' }),
      text(serverX + 16, arrowY + 4.5, endpoints[index], { size: 13, fill: theme.muted, monospace: true }),
    );
  });

  const noteWidth = Math.ceil(measure(words.note, 14)) + 40;
  const noteLeft = Math.max(28, replicaX - noteWidth / 2);
  body.push(
    rect(noteLeft, 284, noteWidth, 36, 10, { fill: theme.card, stroke: theme.cardStroke, 'stroke-dasharray': '4 4' }),
    text(noteLeft + noteWidth / 2, 307, words.note, { size: 14, fill: theme.ink, anchor: 'middle' }),
  );

  return svgDocument({ width, height, lang, title: words.title, desc: words.desc, body });
}

// Conformance profiles as a layered dependency graph.

function profiles(lang, mode) {
  const words = copy[lang].profiles;
  const theme = themeFor(mode);
  const width = 1000;
  const height = 430;
  const columns = [32, 274, 516, 758];
  const boxWidth = 210;
  const boxHeight = 60;
  const rowCenters = [100, 180, 260, 340];
  const boxes = {
    core: { column: 0, center: rowCenters[0] },
    publication: { column: 1, center: rowCenters[0] },
    feed: { column: 2, center: rowCenters[0] },
    publisher: { column: 2, center: rowCenters[1] },
    'mcp-read': { column: 1, center: rowCenters[2] },
    sync: { column: 1, center: rowCenters[3] },
    'mcp-write': { column: 3, center: (rowCenters[1] + rowCenters[2]) / 2, height: 108 },
  };
  const box = (name) => {
    const { column, center, height: tall = boxHeight } = boxes[name];
    return { left: columns[column], right: columns[column] + boxWidth, top: center - tall / 2, bottom: center + tall / 2, center, middle: columns[column] + boxWidth / 2 };
  };
  const indigo = theme.tone('indigo');
  const start = { left: columns[0] - 14, right: columns[1] + boxWidth + 14, top: rowCenters[0] - 44, bottom: rowCenters[0] + 44 };
  const body = [
    frame(width, height, theme),
    rect(start.left, start.top, start.right - start.left, start.bottom - start.top, 16, { fill: indigo.solid, 'fill-opacity': theme.highlight, stroke: indigo.solid, 'stroke-opacity': 0.55, 'stroke-dasharray': '6 5' }),
    text(start.left + 2, start.top - 12, fit(words.start, 14, start.right - start.left), { size: 14, weight: 600, fill: indigo.ink }),
  ];

  // Edges run from a profile to the profiles that build on it.
  const edges = [];
  const arrowSize = 9;
  const straight = (from, to) => {
    const a = box(from);
    const b = box(to);
    edges.push(path(`M${a.right} ${a.center}H${b.left - arrowSize}`, { fill: 'none', stroke: theme.line, 'stroke-width': 2 }), arrowHead(b.left, a.center, 1, 0, theme.line, arrowSize));
  };
  const branch = (from, to, y = box(to).center) => {
    const a = box(from);
    const b = box(to);
    edges.push(path(`M${a.middle} ${a.bottom}V${y - 12}Q${a.middle} ${y} ${a.middle + 12} ${y}H${b.left - arrowSize}`, { fill: 'none', stroke: theme.line, 'stroke-width': 2 }), arrowHead(b.left, y, 1, 0, theme.line, arrowSize));
  };
  straight('core', 'publication');
  straight('publication', 'feed');
  branch('core', 'mcp-read');
  branch('core', 'sync');
  branch('publication', 'publisher');
  straight('publisher', 'mcp-write');
  straight('mcp-read', 'mcp-write');
  body.push(...edges);

  for (const name of Object.keys(boxes)) {
    const b = box(name);
    const tone = theme.tone(profileTones[name]);
    body.push(
      card(b.left, b.top, boxWidth, b.bottom - b.top, theme),
      accentBar(b.left + 12, b.center - 18, 36, tone),
      text(b.left + 26, b.center - 4, name, { size: 16, weight: 700, fill: tone.ink, monospace: true }),
      text(b.left + 26, b.center + 18, fit(words.descriptions[name], 14, boxWidth - 36), { size: 14, fill: theme.muted }),
    );
  }
  body.push(text(32, height - 26, fit(words.footer, 14, 936), { size: 14, fill: theme.muted }));

  return svgDocument({ width, height, lang, title: words.title, desc: words.desc, body });
}

const pieces = { banner, architecture, 'data-model': dataModel, 'sync-flow': syncFlow, profiles };

for (const [name, render] of Object.entries(pieces)) {
  for (const lang of ['en', 'zh-CN', 'ja']) {
    for (const mode of ['light', 'dark']) {
      const file = `${name}${lang === 'en' ? '' : `.${lang}`}${mode === 'light' ? '' : '.dark'}.svg`;
      writeFileSync(join(here, file), render(lang, mode));
    }
  }
}

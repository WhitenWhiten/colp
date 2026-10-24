// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, test, vi } from 'vitest';
import type { NormalizedBookmarkNode, NormalizedBookmarkRoot } from '../src/chrome-bookmark-tree.js';
import { describeIngressDiagnostics, ingressDiagnosticExample, ingressDiagnosticItem,
  ingressDiagnosticRows } from '../src/ingress-diagnostics-ui.js';
import { handleIngressDiagnosticsRequest, INGRESS_EXAMPLES_BUDGET_MS } from '../src/sw/ingress-diagnostics.js';
import { EXAMPLE_TEXT_LIMIT, ingressExamples, readIngressExamples } from '../src/sw/ingress-examples.js';
import type { IngressDiagnosticRecord } from '../src/sync-state/bookmark-event-repository.js';
import type { PublicIngressDiagnostic, PublicIngressExample } from '../src/types.js';
import { fixture, scope } from './bookmark-event-queue-harness.js';

/**
 * C-20 / D2: the "not included in sync" list names a bookmark for the three "cannot be synced" rows. The ledger has no
 * bookmark in it; the worker finds one in the live tree when the list is read. The title (or host) is shown on the options
 * list only: never stored, never in the copied details, the Help diagnostic or a health report.
 */
afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });

const bookmark = (nativeId: string, title: string, url: string, managed = false): NormalizedBookmarkNode =>
  ({ nativeId, title, kind: 'bookmark', managed, url, children: [] });
const folder = (nativeId: string, title: string, children: readonly NormalizedBookmarkNode[] = []): NormalizedBookmarkNode =>
  ({ nativeId, title, kind: 'folder', managed: false, children });
const separator = (nativeId: string): NormalizedBookmarkNode => ({ nativeId, title: '', kind: 'separator', managed: false, children: [] });
const root = (nativeId: string, rootKind: NormalizedBookmarkRoot['rootKind'], children: readonly NormalizedBookmarkNode[],
  title: string = rootKind): NormalizedBookmarkRoot => ({ ...folder(nativeId, title, children), rootKind });
const boundary = (selected: readonly string[], privateIds: readonly string[] = []) =>
  ({ selectedNative: new Set(selected), privateNative: new Set(privateIds) });

describe('the live scan names one bookmark per reason, inside the synced range only', () => {
  const tree = [root('1', 'bookmarks_bar', [
    bookmark('10', 'Browser settings', 'chrome://settings'),
    bookmark('11', 'A local file', 'file:///home/me/notes.html'),
    bookmark('12', 'Fine', 'https://ok.example/'),
    bookmark('13', 'Has a password', 'https://me:secret@host.example/path'),
    bookmark('14', '', 'https://blank.example/some/path?token=abc'),
    folder('20', 'Reading', [bookmark('21', 'Deep one', 'javascript:alert(1)'), bookmark('22', 'Fine too', 'https://deep.example/')]),
  ]), root('2', 'other', [bookmark('30', 'Elsewhere', 'data:text/html,hi')])];

  test('the first refused item per reason, with how many others are refused the same way', () => {
    const found = ingressExamples(tree, boundary(['1']));
    assert.deepEqual(found.get('unsupported_url_scheme'), { text: 'Browser settings', others: 1 });
    // A script address is "not a valid address" to the codec, like one with a password in it.
    assert.deepEqual(found.get('invalid_url'), { text: 'Has a password', others: 1 });
    // A bookmark without a title is named by its host.
    assert.deepEqual(found.get('invalid_title'), { text: 'blank.example', others: 0 });
    assert.deepEqual([...found.keys()].sort(), ['invalid_title', 'invalid_url', 'unsupported_url_scheme']);
  });

  test('only the synced range: a folder outside it, an excluded folder and a managed bookmark name nothing', () => {
    assert.deepEqual([...ingressExamples(tree, boundary([])).keys()], []);
    assert.deepEqual([...ingressExamples(tree, boundary(['20']))], [['invalid_url', { text: 'Deep one', others: 0 }]]);
    const excluded = ingressExamples(tree, boundary(['1'], ['20']));
    assert.deepEqual(excluded.get('invalid_url'), { text: 'Has a password', others: 0 },
      'the excluded folder still excludes its bookmarks when it lies inside a synced one');
    assert.deepEqual(excluded.get('unsupported_url_scheme'), { text: 'Browser settings', others: 1 });
    const managed = [root('1', 'bookmarks_bar', [bookmark('10', 'Policy page', 'chrome://policy', true)])];
    assert.deepEqual([...ingressExamples(managed, boundary(['1'])).keys()], []);
  });

  test('the built-in roots and separators are never refused for their names', () => {
    const quiet = [root('1', 'bookmarks_bar', [separator('10'), bookmark('11', 'Fine', 'https://ok.example/')], ''),
      root('2', 'other', [], ' ')];
    assert.deepEqual([...ingressExamples(quiet, boundary(['1', '2'])).keys()], []);
  });

  test('the address is never the example: a host at most, never a user name, a password or a token', () => {
    const found = ingressExamples([root('1', 'bookmarks_bar', [bookmark('10', '', 'https://me:secret@host.example/path?token=abc')])],
      boundary(['1']));
    assert.deepEqual(found.get('invalid_title'), { text: 'host.example', others: 0 });
    assert.doesNotMatch(JSON.stringify([...found]), /secret|token|me:|path/u);
    // No title and no host (an address that is only a script): nothing to show, and still no address.
    const script = ingressExamples([root('1', 'bookmarks_bar', [bookmark('10', '', 'javascript:alert(document.cookie)')])], boundary(['1']));
    assert.deepEqual([...script], []);
    // A bookmark that has a title is named by it, never by an address that holds a password.
    const titled = ingressExamples([root('1', 'bookmarks_bar', [bookmark('10', 'My bank', 'https://me:secret@bank.example/')])], boundary(['1']));
    assert.deepEqual([...titled], [['invalid_url', { text: 'My bank', others: 0 }]]);
  });

  test('an item with no text is skipped for the example but still counted', () => {
    const found = ingressExamples([root('1', 'bookmarks_bar', [folder('10', '  '), bookmark('11', 'Named', 'https://a.example/'),
      bookmark('12', '\n', 'https://named.example/x'), bookmark('13', '', 'https://b.example/')])], boundary(['1']));
    assert.deepEqual(found.get('invalid_title'), { text: 'named.example', others: 2 }, 'the blank folder has no text; the first item with text is shown');
  });

  test('a long title is cut at 80 characters without splitting a character, and whitespace is one space', () => {
    const long = `${'😀'.repeat(5000)}`;
    const cut = ingressExamples([root('1', 'bookmarks_bar', [bookmark('10', long, 'https://a.example/')])], boundary(['1']))
      .get('invalid_title')!.text;
    const points = Array.from(cut);
    assert.equal(points.length, EXAMPLE_TEXT_LIMIT + 1);
    assert.equal(points.at(-1), '…');
    assert.ok(points.slice(0, EXAMPLE_TEXT_LIMIT).every(point => point === '😀'));
    const spaced = ingressExamples([root('1', 'bookmarks_bar', [bookmark('10', 'a\n\n b\tc', 'ftp://a.example/')])], boundary(['1']))
      .get('unsupported_url_scheme')!.text;
    assert.equal(spaced, 'a b c');
  });
});

describe('the worker reads the ingress boundary and the live tree when the list is read', () => {
  test('the real boundary: the synced folder names its bookmark; the excluded and the unselected folders do not', async () => {
    const { store } = await fixture(new IDBFactory());
    const tree = [root('root-selected', 'bookmarks_bar', [bookmark('a', 'Settings', 'chrome://settings')]),
      root('root-private', 'other', [bookmark('b', 'Private one', 'chrome://private')]),
      root('root-unselected', 'mobile', [bookmark('c', 'Unselected one', 'chrome://unselected'), bookmark('d', 'Bad', 'file:///x')])];
    const found = await readIngressExamples(store, scope, async () => ({ roots: tree }));
    assert.deepEqual([...found], [['unsupported_url_scheme', { text: 'Settings', others: 0 }]]);
  });

  test('nothing synced means no tree read at all', async () => {
    const { store } = await fixture(new IDBFactory());
    await store.configureBrowserRoots(scope, { discovered: [{ nativeId: 'root-selected', ancestorNativeIds: [] }],
      selectedNativeIds: [], privateNativeIds: [], status: 'ready' });
    const read = vi.fn(async () => ({ roots: [] as NormalizedBookmarkRoot[] }));
    assert.deepEqual([...await readIngressExamples(store, scope, read)], []);
    assert.equal(read.mock.calls.length, 0);
  });
});

function ledgerRow(code: string, count = 1): IngressDiagnosticRecord {
  return { id: `id-${code}`, scopeKey: 'scope-key', kind: 'ingress', code, count, firstAt: 1_000, lastAt: 2_000 };
}

describe('the list handler attaches the example, and only that', () => {
  const rows = [ledgerRow('unselected_range', 4), ledgerRow('unsupported_url_scheme', 3), ledgerRow('invalid_title')];
  const store = (list: readonly IngressDiagnosticRecord[] = rows) => ({ listIngressDiagnostics: async () => list });
  const found = new Map<string, PublicIngressExample>([['unsupported_url_scheme', { text: 'Browser settings', others: 1 }],
    ['invalid_title', { text: 'blank.example', others: 0 }], ['managed', { text: 'never attached', others: 0 }]]);

  test('a refused-bookmark row gets its example; every other row is as it was', async () => {
    const response = await handleIngressDiagnosticsRequest({ scope: async () => scope, store: store(), examples: async () => found });
    assert.equal(response.ok, true);
    const list = response.ok ? response.diagnostics : [];
    assert.deepEqual(list.map(row => row.code), ['unselected_range', 'unsupported_url_scheme', 'invalid_title']);
    assert.deepEqual(list.map(row => row.example), [undefined, { text: 'Browser settings', others: 1 }, { text: 'blank.example', others: 0 }]);
    assert.deepEqual(Object.keys(list[0]!).sort(), ['code', 'count', 'firstAt', 'lastAt']);
    assert.equal(JSON.stringify(response).includes('never attached'), false, 'an example for a code the ledger has no row for goes nowhere');
    assert.equal(JSON.stringify(response).includes('scope-key'), false);
  });

  test('no refused-bookmark row means the tree is not read', async () => {
    const examples = vi.fn(async () => found);
    const response = await handleIngressDiagnosticsRequest({ scope: async () => scope,
      store: store([ledgerRow('unselected_range'), ledgerRow('managed')]), examples });
    assert.equal(response.ok && response.diagnostics.length, 2);
    assert.equal(examples.mock.calls.length, 0);
  });

  test('a scan that fails gives the list without examples, not an error', async () => {
    const response = await handleIngressDiagnosticsRequest({ scope: async () => scope, store: store(),
      examples: async () => { throw new Error('bookmark_tree_corrupt'); } });
    assert.equal(response.ok, true);
    assert.deepEqual(response.ok ? response.diagnostics.map(row => row.example) : null, [undefined, undefined, undefined]);
  });

  test('a scan that does not finish is given up after its budget, and the list still arrives', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const answer = handleIngressDiagnosticsRequest({ scope: async () => scope, store: store(), examples: () => new Promise(() => {}) });
    await vi.advanceTimersByTimeAsync(INGRESS_EXAMPLES_BUDGET_MS - 1);
    let settled = false;
    void answer.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(settled, false, 'it waits for the scan until the budget is spent');
    await vi.advanceTimersByTimeAsync(1);
    const response = await answer;
    assert.equal(response.ok && response.diagnostics.length, 3);
    assert.equal(response.ok && response.diagnostics.some(row => row.example), false);
    assert.equal(vi.getTimerCount(), 0, 'the budget timer is cleared');
  });

  test('a handler without the scan (the old shape) is unchanged', async () => {
    const response = await handleIngressDiagnosticsRequest({ scope: async () => scope, store: store() });
    assert.deepEqual(response.ok && response.diagnostics.map(row => Object.keys(row).sort().join()), Array(3).fill('code,count,firstAt,lastAt'));
  });
});

describe('the options list shows the example, and only as text', () => {
  const row = (example?: PublicIngressExample): PublicIngressDiagnostic =>
    ({ code: 'unsupported_url_scheme', count: 3, firstAt: 1_000, lastAt: 2_000, ...(example ? { example } : {}) });

  test('words: the title, with the others when there are some; nothing when there is nothing to show', () => {
    assert.equal(ingressDiagnosticExample(undefined), '');
    assert.equal(ingressDiagnosticExample({ text: '', others: 3 }), '');
    assert.equal(ingressDiagnosticExample({ text: 'Settings', others: 0 }), 'For example: “Settings”');
    assert.equal(ingressDiagnosticExample({ text: 'Settings', others: 2 }), 'For example: “Settings” (and 2 more)');
    assert.equal(ingressDiagnosticExample({ text: 'Settings', others: Number.NaN }), 'For example: “Settings”');
    assert.equal(ingressDiagnosticExample({ text: 'Settings', others: -4 }), 'For example: “Settings”');
  });

  test('a row carries the sentence; the list view and the summary are as before', () => {
    const rows = ingressDiagnosticRows([row({ text: 'Settings', others: 1 }), { ...row(), code: 'unselected_range' }]);
    assert.deepEqual(rows.map(item => item.example), ['For example: “Settings” (and 1 more)', '']);
    const view = describeIngressDiagnostics({ ok: true, diagnostics: [row({ text: 'Settings', others: 0 })] });
    assert.equal(view.ok && view.summary, 'Recorded 1 kind of issue · 3 bookmarks');
  });

  test('the item has a third line only when there is an example, and a title is never read as markup', () => {
    const plain = ingressDiagnosticItem(null, ingressDiagnosticRows([row()])[0]!);
    assert.equal(plain.children.length, 2);
    const hostile = '<img src=x onerror=alert(1)> & <b>bold</b>';
    const item = ingressDiagnosticItem(null, ingressDiagnosticRows([row({ text: hostile, others: 0 })])[0]!);
    assert.equal(item.children.length, 3);
    const line = item.querySelector('.ingress-diagnostics-example')!;
    assert.equal(line.textContent, `For example: “${hostile}”`);
    assert.equal(item.querySelector('img, b'), null);
    assert.equal(line.classList.contains('detail'), true);
  });
});

describe('the example reaches no copy and no report', () => {
  async function sources(dir: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      const path = resolve(entry.parentPath, entry.name);
      out.set(relative(dir, path), await readFile(path, 'utf8'));
    }
    return out;
  }

  test('only the list handler and its wiring import the scan; only the list and its types know the example', async () => {
    const files = await sources(resolve(import.meta.dirname, '../src'));
    const names = (needle: RegExp) => [...files].filter(([name, text]) => needle.test(text) && !name.endsWith('.d.ts')).map(([name]) => name).sort();
    assert.deepEqual(names(/ingress-examples/u), ['service-worker.ts', 'sw/ingress-diagnostics.ts', 'sw/ingress-examples.ts']);
    assert.deepEqual(names(/PublicIngressExample/u),
      ['ingress-diagnostics-ui.ts', 'sw/ingress-diagnostics.ts', 'sw/ingress-examples.ts', 'types.ts']);
    // The copied details, the Help diagnostic and the health report read none of the ledger.
    for (const name of ['sync-attention-ui.ts', 'sync-diagnostics.ts', 'sw/replica-health-report.ts', 'sw/replica-health.ts',
      'sync-issue-snapshot.ts', 'sync-attention-view.ts']) {
      assert.doesNotMatch(files.get(name)!, /ingress|PublicIngressDiagnostic/iu, name);
    }
    assert.doesNotMatch(files.get('ingress-diagnostics-ui.ts')!, /clipboard|writeText/u, 'the list has no copy of its own');
  });
});

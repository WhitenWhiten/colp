/**
 * SR-10 / A-08: the options-side "已过滤的本地书签" list.
 *
 * Behaviour first: the pure copy/format predicates are called directly, the
 * service-worker projection runs against a **real** store (`createSyncStateStore`
 * + `fake-indexeddb`) fed through the **real** ingress entry point
 * (`recordIngressDiagnostic`), and the read-only claim is checked by comparing
 * the ledger before and after a projection instead of grepping for a keyword.
 * Only the panel/worker wiring is pinned by `readFile`, because a DOM binder
 * cannot be exercised here (this package runs vitest in the node environment).
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { recordIngressDiagnostic } from '../src/bookmark-event-ingress.js';
import { PARK_MARKER_PREFIX } from '../src/bookmark-event-quarantine.js';
import {
  INGRESS_DIAGNOSTICS_EMPTY_COPY, INGRESS_DIAGNOSTICS_HOST, INGRESS_DIAGNOSTICS_INTRO_COPY,
  INGRESS_DIAGNOSTICS_PANE, INGRESS_DIAGNOSTICS_TAG_FILTERED, INGRESS_DIAGNOSTICS_TAG_LOCAL_ORDER,
  INGRESS_DIAGNOSTICS_TAG_UPLINKED,
  INGRESS_TIME_UNKNOWN_COPY, describeIngressDiagnostics, formatIngressCount, formatIngressTimestamp,
  ingressDiagnosticCategory, ingressDiagnosticLabel, ingressDiagnosticMeta, ingressDiagnosticRows,
  ingressDiagnosticsFailureCopy, ingressDiagnosticsRequest, ingressDiagnosticsSummary, isParkMarkerCode,
} from '../src/ingress-diagnostics-ui.js';
import { validIngressDiagnosticsRequest, validRequest, validSyncAttentionRequest,
  validSyncEngineRequest } from '../src/sw/messages.js';
import { handleIngressDiagnosticsRequest } from '../src/sw/ingress-diagnostics.js';
import { createSyncStateStore } from '../src/sync-state-store.js';
import type { BookmarkEventParkMarker } from '../src/sync-state/types.js';
import type { PublicIngressDiagnostic } from '../src/types.js';
import { scope } from './bookmark-event-queue-harness.js';

type Store = ReturnType<typeof createSyncStateStore>;

/** `2026-07-27 13:45 UTC` — the base clock every formatted expectation uses. */
const BASE = Date.UTC(2026, 6, 27, 13, 45);
const MINUTE = 60_000;

/**
 * The code set `recordIngressDiagnostic` can emit today plus the codec's
 * representability results (`src/bookmark-event-ingress.ts#IngressDiagnosticCode`,
 * `src/bookmark-event-codec.ts#BookmarkRepresentability`). Listed literally so a
 * renamed code shows up as a failing copy assertion rather than a silent gap.
 */
const KNOWN_CODES = ['unselected_range', 'private_local', 'managed', 'unsupported_url_scheme', 'invalid_url',
  'invalid_title', 'reorder_children_local_only', 'reorder_children_unmapped', 'reorder_children_excluded',
  'reorder_uplink_staged'] as const;

let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(BASE); });
afterEach(() => { vi.useRealTimers(); });

/** Same active-scope fixture `ingress-diagnostic-ledger.test.ts` writes through. */
async function activeStore(): Promise<Store> {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 10_000 },
    checkpoint: { serverRevision: 'collection-revision-3', cursor: 'cursor-3' }, selectedRoots: [], rootStatus: 'ready' });
  return store;
}

function parkMarker(overrides: Partial<BookmarkEventParkMarker> = {}): BookmarkEventParkMarker {
  return { eventId: 'event-parked', state: 'parked', code: 'dependency_rejected', attempts: 2,
    at: '2026-07-27T00:00:00Z', reason: 'dependency_rejected', dependencyNativeId: 'folder-new', ...overrides };
}

function diagnostic(overrides: Partial<PublicIngressDiagnostic> = {}): PublicIngressDiagnostic {
  return { code: 'unselected_range', count: 1, firstAt: BASE, lastAt: BASE, ...overrides };
}

describe('A-08 filtered-bookmark copy (pure)', () => {
  test('every known code has readable copy instead of its raw code', () => {
    for (const code of KNOWN_CODES) {
      const label = ingressDiagnosticLabel(code);
      assert.notEqual(label, code, code);
      assert.match(label, /[A-Za-z]/u, code);
      // A known code must never be described as unsupported: the list explains
      // *why* the bookmark is filtered, not that the code is unrecognized.
      assert.doesNotMatch(label, /不支持|未支持|未知原因|unrecognized|unsupported/u, code);
    }
    assert.match(ingressDiagnosticLabel('unselected_range'), /isn't synced/u);
    assert.match(ingressDiagnosticLabel('unsupported_url_scheme'), /http or https/u);
    assert.match(ingressDiagnosticLabel('reorder_children_local_only'), /this device/u);
  });

  test('an unknown code is shown as its raw code, never as "unsupported"', () => {
    assert.equal(ingressDiagnosticLabel('some_future_code'), 'some_future_code');
    assert.equal(ingressDiagnosticLabel('codec_v2_result'), 'codec_v2_result');
    assert.equal(ingressDiagnosticCategory('some_future_code'), 'other');
    assert.equal(ingressDiagnosticMeta(diagnostic({ code: 'some_future_code' })),
      `Count: 1 · Latest: 2026-07-27 13:45 UTC`);
  });

  test('the category tags distinguish filtered, local-order and uplinked codes', () => {
    assert.equal(ingressDiagnosticRows([diagnostic()])[0]!.tag, INGRESS_DIAGNOSTICS_TAG_FILTERED);
    assert.equal(ingressDiagnosticRows([diagnostic({ code: 'reorder_children_local_only' })])[0]!.tag,
      INGRESS_DIAGNOSTICS_TAG_LOCAL_ORDER);
    assert.equal(ingressDiagnosticRows([diagnostic({ code: 'reorder_uplink_staged' })])[0]!.tag,
      INGRESS_DIAGNOSTICS_TAG_UPLINKED);
    // An unknown code gets no claim attached at all.
    assert.equal(ingressDiagnosticRows([diagnostic({ code: 'some_future_code' })])[0]!.tag, '');
  });

  test('park: rows are quarantine bookkeeping and are excluded from the list', () => {
    assert.equal(isParkMarkerCode(`${PARK_MARKER_PREFIX}event-1`), true);
    assert.equal(isParkMarkerCode('unselected_range'), false);
    const rows = ingressDiagnosticRows([
      diagnostic({ code: `${PARK_MARKER_PREFIX}event-1`, count: 4, lastAt: BASE + MINUTE }),
      diagnostic({ code: 'unselected_range', count: 2 }),
    ]);
    assert.deepEqual(rows.map((row) => row.code), ['unselected_range'],
      'a park marker is a marker refresh count, not a filtered bookmark');
    assert.equal(ingressDiagnosticsSummary(rows), 'Recorded 1 kind of issue · 2 bookmarks');
  });

  test('count and most-recent-time formatting follows the storage contract', () => {
    assert.equal(formatIngressCount(1), 'Count: 1');
    assert.equal(formatIngressCount(37), 'Count: 37');
    // The ledger never stores 0; a corrupt row must not render as "Count: 0".
    assert.equal(formatIngressCount(0), 'Count: 1');
    assert.equal(formatIngressCount(Number.NaN), 'Count: 1');
    assert.equal(formatIngressTimestamp(BASE), '2026-07-27 13:45 UTC');
    assert.equal(formatIngressTimestamp(BASE + 17 * MINUTE), '2026-07-27 14:02 UTC');
    // One occurrence: a single time. Repeated: both ends, so the count and the
    // moving `lastAt` are visible together with the unchanged `firstAt`.
    assert.equal(ingressDiagnosticMeta(diagnostic()),
      'Count: 1 · Latest: 2026-07-27 13:45 UTC');
    assert.equal(ingressDiagnosticMeta(diagnostic({ count: 2, firstAt: BASE, lastAt: BASE + 17 * MINUTE })),
      'Count: 2 · First: 2026-07-27 13:45 UTC · Latest: 2026-07-27 14:02 UTC');
  });

  test('a pre-ledger row (firstAt === lastAt === 0) reads as unknown time, not 1970', () => {
    const meta = ingressDiagnosticMeta(diagnostic({ count: 3, firstAt: 0, lastAt: 0 }));
    assert.equal(meta, `Count: 3 · ${INGRESS_TIME_UNKNOWN_COPY}`);
    assert.doesNotMatch(meta, /1970|Invalid Date|NaN/u);
    assert.equal(formatIngressTimestamp(0), INGRESS_TIME_UNKNOWN_COPY);
    assert.equal(formatIngressTimestamp(-1), INGRESS_TIME_UNKNOWN_COPY);
    assert.equal(formatIngressTimestamp(Number.NaN), INGRESS_TIME_UNKNOWN_COPY);
    // `firstAt` unknown with a real `lastAt` still reports the recent time only.
    assert.equal(ingressDiagnosticMeta(diagnostic({ firstAt: 0, lastAt: BASE })),
      'Count: 1 · Latest: 2026-07-27 13:45 UTC');
  });

  test('a failed read says so and never claims the list is empty', () => {
    const idle = describeIngressDiagnostics(undefined);
    assert.equal(idle.ok, false);
    assert.equal(idle.ok === false && idle.message, ingressDiagnosticsFailureCopy('extension_unavailable'));
    const refused = describeIngressDiagnostics({ ok: false, error: 'not_connected' });
    assert.equal(refused.ok === false && refused.message, ingressDiagnosticsFailureCopy('not_connected'));
    assert.match(ingressDiagnosticsFailureCopy('not_connected'), /Nothing syncs here yet/u);
    assert.match(ingressDiagnosticsFailureCopy('state_unavailable'), /Could not read the exclusion list/u);
    // R13-109: an unknown code reads as a sentence; the raw code is not shown.
    assert.equal(ingressDiagnosticsFailureCopy('weird_code'), "Couldn't read the list of excluded items. Try again.");
    for (const view of [idle, refused]) {
      assert.doesNotMatch(view.ok === false ? view.message : '', new RegExp(INGRESS_DIAGNOSTICS_EMPTY_COPY, 'u'));
    }
    assert.equal(describeIngressDiagnostics({ ok: true, diagnostics: [] }).ok, true);
    const empty = describeIngressDiagnostics({ ok: true, diagnostics: [] });
    assert.equal(empty.ok === true && empty.empty, true);
    assert.equal(empty.ok === true && empty.summary, 'Recorded 0 kinds of issues · 0 bookmarks');
    assert.equal(ingressDiagnosticsRequest().kind, 'known.sync.ingressDiagnostics.get');
    assert.ok(INGRESS_DIAGNOSTICS_INTRO_COPY.includes('not included in sync'));
  });
});

describe('A-08 read-only projection over the real ledger', () => {
  test('a repeated code keeps one row: count accumulates, firstAt stays, lastAt moves', async () => {
    const store = await activeStore();
    await recordIngressDiagnostic(store, scope, 'unsupported_url_scheme');
    vi.setSystemTime(BASE + 17 * MINUTE);
    await recordIngressDiagnostic(store, scope, 'unsupported_url_scheme');
    vi.setSystemTime(BASE + 60 * MINUTE);
    await recordIngressDiagnostic(store, scope, 'unsupported_url_scheme');

    const response = await handleIngressDiagnosticsRequest({ scope: async () => scope, store });
    assert.equal(response.ok, true);
    const rows = response.ok ? response.diagnostics : [];
    assert.equal(rows.length, 1, 'three events of one code stay one row');
    assert.deepEqual(rows[0], { code: 'unsupported_url_scheme', count: 3,
      firstAt: BASE, lastAt: BASE + 60 * MINUTE });
    // The page view of the same response: the count grew and both ends are on
    // screen, so a later event cannot silently replace the earlier one.
    const view = describeIngressDiagnostics(response);
    assert.equal(view.ok, true);
    assert.equal(view.ok === true && view.rows[0]!.meta,
      'Count: 3 · First: 2026-07-27 13:45 UTC · Latest: 2026-07-27 14:45 UTC');
  });

  test('the projection keeps the store order (lastAt desc) and leaks no id or scopeKey', async () => {
    const store = await activeStore();
    await recordIngressDiagnostic(store, scope, 'managed');
    vi.setSystemTime(BASE + 5 * MINUTE);
    await recordIngressDiagnostic(store, scope, 'unselected_range');
    vi.setSystemTime(BASE + 9 * MINUTE);
    await recordIngressDiagnostic(store, scope, 'managed');
    vi.setSystemTime(BASE + 11 * MINUTE);
    await recordIngressDiagnostic(store, scope, 'unselected_range');

    const response = await handleIngressDiagnosticsRequest({ scope: async () => scope, store });
    assert.equal(response.ok, true);
    const rows = response.ok ? response.diagnostics : [];
    // `unselected_range` was touched last (11m), `managed` before it (9m) — the
    // handler must not re-sort, so the store's own order is what the page gets.
    assert.deepEqual(rows.map((row) => row.code), ['unselected_range', 'managed']);
    assert.deepEqual(rows.map((row) => row.lastAt), [BASE + 11 * MINUTE, BASE + 9 * MINUTE]);
    assert.deepEqual(rows.map((row) => row.count), [2, 2], 'each code keeps its own count');
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), ['code', 'count', 'firstAt', 'lastAt']);
    }
    const serialized = JSON.stringify(response);
    assert.equal(serialized.includes('scopeKey'), false);
    assert.equal(serialized.includes('"id"'), false);
    assert.equal(serialized.includes('replica-a'), false);
  });

  test('park: quarantine rows are dropped before they leave the worker', async () => {
    const store = await activeStore();
    await recordIngressDiagnostic(store, scope, 'private_local');
    vi.setSystemTime(BASE + 30 * MINUTE);
    await store.putIngressDiagnostic(scope,
      { code: `${PARK_MARKER_PREFIX}event-parked`, park: parkMarker() });

    const response = await handleIngressDiagnosticsRequest({ scope: async () => scope, store });
    const rows = response.ok ? response.diagnostics : [];
    assert.deepEqual(rows.map((row) => row.code), ['private_local']);
    // The code embeds an inbox event id; it must not cross the message boundary.
    assert.equal(JSON.stringify(response).includes('event-parked'), false);
    assert.equal(JSON.stringify(response).includes(PARK_MARKER_PREFIX), false);
  });

  test('the read is read-only: two projections leave every row untouched', async () => {
    const store = await activeStore();
    await recordIngressDiagnostic(store, scope, 'invalid_title');
    vi.setSystemTime(BASE + 3 * MINUTE);
    await recordIngressDiagnostic(store, scope, 'invalid_title');
    const before = await store.listIngressDiagnostics(scope);
    await handleIngressDiagnosticsRequest({ scope: async () => scope, store });
    await handleIngressDiagnosticsRequest({ scope: async () => scope, store });
    assert.deepEqual(await store.listIngressDiagnostics(scope), before,
      'a projection must not bump a count, a timestamp or a park marker');
  });

  test('a scope-less or broken read fails honestly', async () => {
    const store = await activeStore();
    const refused = await handleIngressDiagnosticsRequest({
      scope: async () => { throw new Error('not_connected'); }, store });
    assert.deepEqual(refused, { ok: false, error: 'not_connected' });
    const broken = await handleIngressDiagnosticsRequest({ scope: async () => scope,
      store: { listIngressDiagnostics: async () => { throw new Error('state_unavailable'); } } });
    assert.deepEqual(broken, { ok: false, error: 'state_unavailable' });
    // A failed read renders as a message, never as a successful empty list.
    const view = describeIngressDiagnostics(broken);
    assert.equal(view.ok, false);
    assert.equal(view.ok === false && view.message, ingressDiagnosticsFailureCopy('state_unavailable'));
  });
});

describe('A-08 message surface', () => {
  test('accepts only the parameterless read-only message', () => {
    assert.equal(validIngressDiagnosticsRequest({ kind: 'known.sync.ingressDiagnostics.get' }), true);
    assert.equal(validIngressDiagnosticsRequest(null), false);
    assert.equal(validIngressDiagnosticsRequest(undefined), false);
    assert.equal(validIngressDiagnosticsRequest('known.sync.ingressDiagnostics.get'), false);
    assert.equal(validIngressDiagnosticsRequest([{ kind: 'known.sync.ingressDiagnostics.get' }]), false);
    assert.equal(validIngressDiagnosticsRequest({}), false);
    assert.equal(validIngressDiagnosticsRequest({ kind: 'known.sync.ingressDiagnostics.get', extra: 1 }), false);
    assert.equal(validIngressDiagnosticsRequest({ kind: 'known.sync.ingressDiagnostics.get', userGesture: true }), false);
    assert.equal(validIngressDiagnosticsRequest({ kind: 'known.sync.ingressDiagnostics.get', scope: {} }), false);
    assert.equal(validIngressDiagnosticsRequest({ kind: 'known.sync.ingressDiagnostics.GET' }), false);
  });

  test('no existing validator is widened by the new kind', () => {
    assert.equal(validIngressDiagnosticsRequest({ kind: 'known.sync.attention.get' }), false);
    assert.equal(validSyncAttentionRequest({ kind: 'known.sync.attention.get' }), true);
    assert.equal(validSyncAttentionRequest({ kind: 'known.sync.attention.get', extra: 1 }), false);
    assert.equal(validSyncEngineRequest({ kind: 'known.sync.engine.status' }), true);
    assert.equal(validSyncEngineRequest({ kind: 'known.sync.engine.status', extra: 1 }), false);
    // The broad auth/request validator must not become a second door for it.
    assert.equal(validRequest({ kind: 'known.sync.ingressDiagnostics.get' }), false);
  });
});

describe('A-08 options/worker wiring', () => {
  test('the Diagnostics pane carries the card the binder expects, with a status feedback row', async () => {
    const root = resolve(import.meta.dirname, '..');
    const html = await readFile(resolve(root, 'options.html'), 'utf8');
    const css = await readFile(resolve(root, 'options.css'), 'utf8');
    const ui = await readFile(resolve(root, 'src/ingress-diagnostics-ui.ts'), 'utf8');

    for (const id of [INGRESS_DIAGNOSTICS_HOST, `${INGRESS_DIAGNOSTICS_HOST}-heading`, `${INGRESS_DIAGNOSTICS_HOST}-intro`,
      `${INGRESS_DIAGNOSTICS_HOST}-count`, `${INGRESS_DIAGNOSTICS_HOST}-empty`, `${INGRESS_DIAGNOSTICS_HOST}-list`,
      `${INGRESS_DIAGNOSTICS_HOST}-item`, `${INGRESS_DIAGNOSTICS_HOST}-feedback`]) {
      assert.ok(html.includes(`id="${id}"`), id);
    }
    assert.match(html, /id="ingress-diagnostics-settings-feedback"[^>]*role="status"[^>]*aria-live="polite"/u);
    assert.ok(html.includes('Bookmarks not included in sync'));
    assert.ok(html.includes(INGRESS_DIAGNOSTICS_INTRO_COPY));
    assert.ok(html.includes('These local bookmarks are not included in sync, for the reasons below.'));
    assert.ok(html.includes(INGRESS_DIAGNOSTICS_EMPTY_COPY));
    // The empty claim is not rendered before the first read answers.
    assert.match(html, /id="ingress-diagnostics-settings-empty"[^>]*hidden/u);
    // Inside the Help & diagnostics page, under its category nav (sync keeps its own cards).
    assert.ok(html.indexOf('id="help-card"') < html.indexOf(`id="${INGRESS_DIAGNOSTICS_HOST}"`));
    assert.ok(html.indexOf(`id="${INGRESS_DIAGNOSTICS_HOST}"`) < html.indexOf(`id="${INGRESS_DIAGNOSTICS_HOST}-list"`));
    // The binder and the markup agree on every child id, in both directions.
    for (const suffix of ['-intro', '-count', '-empty', '-list', '-item', '-feedback']) {
      assert.ok(ui.includes(`\`\${INGRESS_DIAGNOSTICS_HOST}${suffix}\``), suffix);
    }
    assert.match(css, /\.ingress-diagnostics-settings \{/u);
    assert.match(css, /\.ingress-diagnostics-item \{/u);
    assert.match(css, /\.ingress-diagnostics-tag \{/u);
    // Untrusted-ish codes are written with textContent only.
    assert.doesNotMatch(ui, /innerHTML|insertAdjacentHTML|document\.write/u);
  });

  test('the worker routes the kind next to the other read-only branches', async () => {
    const root = resolve(import.meta.dirname, '..');
    const worker = await readFile(resolve(root, 'src/service-worker.ts'), 'utf8');
    const messages = await readFile(resolve(root, 'src/sw/messages.ts'), 'utf8');
    const ui = await readFile(resolve(root, 'src/ingress-diagnostics-ui.ts'), 'utf8');
    const handler = await readFile(resolve(root, 'src/sw/ingress-diagnostics.ts'), 'utf8');

    assert.match(worker, /validIngressDiagnosticsRequest\(message\)/u);
    assert.match(worker, /handleIngressDiagnosticsRequest\(ingressDiagnosticsDeps\)/u);
    assert.match(worker, /const ingressDiagnosticsDeps: IngressDiagnosticsDeps = \{ scope: currentSyncScope, store: syncState \}/u);
    assert.match(worker, /IngressDiagnosticsResponse/u);
    assert.match(messages, /export function validIngressDiagnosticsRequest/u);
    assert.match(ui, /known\.sync\.ingressDiagnostics\.get/u);
    assert.match(handler, /listIngressDiagnostics/u);
    assert.match(handler, /isParkMarkerCode/u);
  });

  test('the options page composes the isolated read-on-entry diagnostics section', async () => {
    const root = resolve(import.meta.dirname, '..');
    const options = await readFile(resolve(root, 'src/options.ts'), 'utf8');
    const sections=await readFile(resolve(root,'src/options-secondary-settings.ts'),'utf8');
    assert.match(options,/bindSecondarySettings\(\)/u);
    const wiring = sections.split('\n').filter((line) => line.includes('IngressDiagnostics'));
    assert.deepEqual(wiring.map((line) => line.trim()), [
      "import { bindIngressDiagnosticsSettings } from './ingress-diagnostics-ui.js';",
      "initializeSettingsSection('ingress-diagnostics-settings', bindIngressDiagnosticsSettings);",
    ]);
    // Read-on-entry, not polling: the binder observes the pane switch and owns no timer.
    assert.match(sections, /initializeSettingsSection\('ingress-diagnostics-settings', bindIngressDiagnosticsSettings\)/u);
    assert.doesNotMatch(sections, /bindIngressDiagnostics\w*\(\)[\s\S]{0,80}setInterval/u);
    const sourceLines = options.endsWith('\n') ? options.split('\n').length - 1 : options.split('\n').length;
    // FO-04 raised the maintained-file cap 729 -> 735 for the server icon-policy
    // settings hint; optional sections now live in their small composition module.
    assert.ok(sourceLines <= 735, `options.ts must stay at or below its 735-line cap, found ${sourceLines}`);
  });

  test('the binder reads once per Sync-pane entry and never installs a timer', async () => {
    const root = resolve(import.meta.dirname, '..');
    const ui = await readFile(resolve(root, 'src/ingress-diagnostics-ui.ts'), 'utf8');
    assert.equal(INGRESS_DIAGNOSTICS_PANE, 'sync');
    assert.match(ui, /MutationObserver/u);
    assert.match(ui, /attributeFilter: \['data-pane'\]/u);
    assert.match(ui, /dataset\.pane === INGRESS_DIAGNOSTICS_PANE/u);
    assert.match(ui, /function inSyncPane/u);
    // No 8s-style poll for rows that change on the order of ingress decisions.
    assert.doesNotMatch(ui, /setInterval/u);
    assert.match(ui, /if \(reading\) return;/u);
  });
});

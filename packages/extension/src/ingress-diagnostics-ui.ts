import { localized, t, tn } from './i18n.js';
/**
 * SR-10 / A-08: the options-page face of the ingress diagnostic ledger — the
 * read-only "not included in sync" list (code + count + most recent time).
 *
 * The ledger already exists and is frozen (`listIngressDiagnostics`: one row per
 * `(scopeKey, code)`, `count` accumulates, `firstAt` is set once, `lastAt` is
 * monotone, rows come back `lastAt` desc). This module therefore holds only
 * presentation: code → readable Chinese copy, the count/time formatting, the
 * `park:` exclusion and the binder that reads the ledger over the read-only
 * `known.sync.ingressDiagnostics.get` channel.
 *
 * Three honesty rules drive the copy, all of them from the storage contract:
 *   - a `park:` code is quarantine bookkeeping (`PARK_MARKER_PREFIX`, one row per
 *     unready inbox event, `count` = marker refresh rounds) and is *not* a
 *     filtered local bookmark; those rows are dropped (defensively here, and in
 *     the worker before they cross the message boundary);
 *   - `firstAt === lastAt === 0` means "written before the ledger existed", so it
 *     renders as the time-unknown copy instead of 1970-01-01;
 *   - an unknown code is shown as its raw code — never as "unsupported", because this
 *     module cannot know whether a newer build supports it.
 *
 * The refresh strategy is a deliberate read-on-pane-entry: `bindIngressDiagnostics-
 * Settings` reads once when the Sync center pane becomes visible (and the page
 * opens on it) and never starts a timer. The ledger only changes when ingress makes a
 * local decision, so re-entering the pane is a cheap, honest refresh point and a
 * sleeping MV3 worker is never woken for rows that did not change.
 */
import { PARK_MARKER_PREFIX } from './bookmark-event-quarantine.js';
import type {
  IngressDiagnosticsGetRequest, IngressDiagnosticsResponse, PublicIngressDiagnostic,
} from './types.js';

export const INGRESS_DIAGNOSTICS_HOST = 'ingress-diagnostics-settings';
export let INGRESS_DIAGNOSTICS_INTRO_COPY: string, INGRESS_DIAGNOSTICS_EMPTY_COPY: string, INGRESS_TIME_UNKNOWN_COPY: string, INGRESS_DIAGNOSTICS_TAG_FILTERED: string, INGRESS_DIAGNOSTICS_TAG_LOCAL_ORDER: string, INGRESS_DIAGNOSTICS_TAG_UPLINKED: string;
localized(() => {
  INGRESS_DIAGNOSTICS_INTRO_COPY = t('sync_theseLocalBookmarksNot', 'These local bookmarks are not included in sync, for the reasons below.');
  INGRESS_DIAGNOSTICS_EMPTY_COPY = t('sync_noLocalBookmarksCurrently', 'No local bookmarks are currently excluded from sync.');
  INGRESS_TIME_UNKNOWN_COPY = t('sync_timeUnknownRecordedBefore', 'Time unknown (recorded before this list existed)');
  INGRESS_DIAGNOSTICS_TAG_FILTERED = t('common_notSynced', 'Not synced');
  INGRESS_DIAGNOSTICS_TAG_LOCAL_ORDER = t('sync_deviceOrderOnly', 'This device order only');
  INGRESS_DIAGNOSTICS_TAG_UPLINKED = t('common_uploadScheduled', 'Upload scheduled');
});
/** The pane whose visibility triggers the one read (`showPane` sets this). */
export const INGRESS_DIAGNOSTICS_PANE = 'sync';

export type IngressDiagnosticCategory = 'filtered' | 'local_order' | 'uplinked' | 'other';

/**
 * The code set `recordIngressDiagnostic` can write today (`IngressDiagnosticCode`
 * plus the codec's representability results, which are recorded through the same
 * entry point). Kept as a lookup rather than an exhaustive `Record<union, …>` on
 * purpose: `reorder_*` semantics are still moving (SR-08), and a new code must
 * degrade to its raw name instead of breaking this module's build.
 */
let LABELS: Readonly<Record<string, string>>;
localized(() => {
  LABELS = {
  unselected_range: t('sync_folderIsntSynced', "In a folder that isn't synced"),
  private_local: t('sync_insideNoKnowNSyncFolder', 'Inside a folder excluded from sync'),
  managed: t('firstRun_managedBrowserPolicyDevice', 'Managed by browser policy. This device cannot change it, so it does not sync'),
  unsupported_url_scheme: t('sync_onlyWebAddressesHttp', 'Only web addresses (http or https) can sync'),
  invalid_url: t('sync_urlCannotRepresentedMissing', 'URL cannot be synced (invalid format, disallowed scheme, or too long)'),
  invalid_title: t('sync_titleCannotRepresentedEmpty', 'Title cannot be represented (empty or too long)'),
  reorder_children_local_only: t('sync_orderChangedOnlyDevice', 'Order changed only on this device; Know-N keeps its order'),
  reorder_children_unmapped: t('sync_folderIsntLinkedKnow', "This folder isn't linked to your library yet, so the new order stays on this device"),
  reorder_children_excluded: t('sync_someSiblingBookmarksExcluded', 'Some sibling bookmarks are excluded, so the order change was not fully uploaded'),
  reorder_uplink_staged: t('sync_orderChangeScheduledUpload', 'Order change is scheduled to upload (it will sync to your library)'),
};
});

const CATEGORIES: Readonly<Record<string, IngressDiagnosticCategory>> = {
  unselected_range: 'filtered',
  private_local: 'filtered',
  managed: 'filtered',
  unsupported_url_scheme: 'filtered',
  invalid_url: 'filtered',
  invalid_title: 'filtered',
  reorder_children_local_only: 'local_order',
  reorder_children_unmapped: 'local_order',
  reorder_children_excluded: 'local_order',
  reorder_uplink_staged: 'uplinked',
};

let TAGS: Readonly<Record<IngressDiagnosticCategory, string>>;
localized(() => {
  TAGS = {
    filtered: INGRESS_DIAGNOSTICS_TAG_FILTERED,
    local_order: INGRESS_DIAGNOSTICS_TAG_LOCAL_ORDER,
    uplinked: INGRESS_DIAGNOSTICS_TAG_UPLINKED,
    // An unknown code gets no claim at all: not "unsupported", not "other issue".
    other: '',
  };
});

export interface IngressDiagnosticRow {
  readonly code: string;
  /** Readable copy for a known code, the raw code otherwise. */
  readonly label: string;
  readonly category: IngressDiagnosticCategory;
  /** Short qualifier, empty for a code this build does not know. */
  readonly tag: string;
  /** Accumulated suppressions for this code (≥ 1 by the storage contract). */
  readonly count: number;
  /** `Count: N · Latest: T` (see `ingressDiagnosticMeta`). */
  readonly meta: string;
}

export type IngressDiagnosticsView =
  | { readonly ok: true; readonly summary: string; readonly rows: readonly IngressDiagnosticRow[];
    readonly empty: boolean }
  | { readonly ok: false; readonly message: string };

/** The ledger's own quarantine marker prefix — never a filtered bookmark. */
export function isParkMarkerCode(code: string): boolean {
  return code.startsWith(PARK_MARKER_PREFIX);
}

export function ingressDiagnosticCategory(code: string): IngressDiagnosticCategory {
  return CATEGORIES[code] ?? 'other';
}

/** Unknown codes fall back to the raw code; this build never calls them unsupported. */
export function ingressDiagnosticLabel(code: string): string {
  return LABELS[code] ?? code;
}

export function ingressDiagnosticTag(code: string): string {
  return TAGS[ingressDiagnosticCategory(code)];
}

/**
 * `0` is the storage contract's "pre-ledger row, time unknown" value and a
 * non-finite number is corruption; both render as the time-unknown copy, never
 * as 1970.
 * The rest is formatted in UTC with an explicit suffix so the label and the
 * value cannot disagree in a browser whose zone is not the reader's.
 */
export function formatIngressTimestamp(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return INGRESS_TIME_UNKNOWN_COPY;
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return INGRESS_TIME_UNKNOWN_COPY;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
    + ` ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

/** The storage contract is `count >= 1`; a corrupt row must not read as "Count: 0". */
export function formatIngressCount(count: number): string {
  const normalized = Number.isSafeInteger(count) && count >= 1 ? count : 1;
  return t('sync_count', 'Count: $1', normalized);
}

/**
 * Count plus the ledger window. One occurrence shows a single time; a repeated
 * code shows both ends, which is exactly what "repeated events never overwrite
 * each other" looks like on
 * screen: the count grows while `firstAt` stays put and `lastAt` moves.
 */
export function ingressDiagnosticMeta(row: PublicIngressDiagnostic): string {
  const count = formatIngressCount(row.count);
  const firstAt = Number.isFinite(row.firstAt) ? row.firstAt : 0;
  const lastAt = Number.isFinite(row.lastAt) ? row.lastAt : 0;
  if (lastAt <= 0 && firstAt <= 0) return `${count} · ${INGRESS_TIME_UNKNOWN_COPY}`;
  const last = formatIngressTimestamp(lastAt);
  if (firstAt <= 0 || firstAt === lastAt) return t('sync_latest', '$1 · Latest: $2', count, last);
  return t('sync_firstLatest', '$1 · First: $2 · Latest: $3', count, formatIngressTimestamp(firstAt), last);
}

/** Order is the store's (`lastAt` desc, `code` asc) — never re-sorted here. */
export function ingressDiagnosticRows(diagnostics: readonly PublicIngressDiagnostic[]): readonly IngressDiagnosticRow[] {
  return diagnostics.filter((diagnostic) => !isParkMarkerCode(diagnostic.code)).map((diagnostic) => ({
    code: diagnostic.code,
    label: ingressDiagnosticLabel(diagnostic.code),
    category: ingressDiagnosticCategory(diagnostic.code),
    tag: ingressDiagnosticTag(diagnostic.code),
    count: Number.isSafeInteger(diagnostic.count) && diagnostic.count >= 1 ? diagnostic.count : 1,
    meta: ingressDiagnosticMeta(diagnostic),
  }));
}

export function ingressDiagnosticsSummary(rows: readonly IngressDiagnosticRow[]): string {
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const kinds = tn('sync_issueKinds', rows.length, '$1 kind of issue', '$1 kinds of issues');
  return t('sync_recordedIssues', 'Recorded $1 · $2', kinds, tn('common_bookmarks', total, '$1 bookmark', '$1 bookmarks'));
}

/** A failed read must say so; it never falls back to an empty "successful" list. */
export function ingressDiagnosticsFailureCopy(error: string): string {
  // Sync > Status only opens while signed in, so this means no collection syncs here yet.
  if (error === 'not_connected') return t('sync_exclusionsAfterFirstSync', 'Nothing syncs here yet. Excluded items are listed after the first sync.');
  if (error === 'state_unavailable') return t('sync_couldNotReadExclusion', 'Could not read the exclusion list. Reopen this page in a moment.');
  if (error === 'extension_unavailable') return t('sync_extensionBackgroundTemporarilyUnavailable', 'The extension background is temporarily unavailable. Reopen this page in a moment.');
  return t('sync_couldntReadListExcluded', "Couldn't read the list of excluded items. Try again.");
}

export function ingressDiagnosticsRequest(): IngressDiagnosticsGetRequest {
  return { kind: 'known.sync.ingressDiagnostics.get' };
}

/**
 * `undefined` means "no answer" (worker asleep or channel closed), which is a
 * failure like any other — the list is never painted as empty on a timeout.
 */
export function describeIngressDiagnostics(response: IngressDiagnosticsResponse | undefined): IngressDiagnosticsView {
  if (!response || response.ok !== true) {
    const error = response?.ok === false ? response.error : 'extension_unavailable';
    return { ok: false, message: ingressDiagnosticsFailureCopy(error) };
  }
  const rows = ingressDiagnosticRows(response.diagnostics);
  return { ok: true, summary: ingressDiagnosticsSummary(rows), rows, empty: rows.length === 0 };
}

interface IngressNodes {
  readonly intro: HTMLElement | null;
  readonly summary: HTMLElement | null;
  readonly empty: HTMLElement | null;
  readonly list: HTMLElement | null;
  readonly template: HTMLTemplateElement | null;
  readonly feedback: HTMLElement | null;
}

/** Options binder: `#ingress-diagnostics-settings` inside the Sync center pane. */
export function bindIngressDiagnosticsSettings(): void {
  const host = document.getElementById(INGRESS_DIAGNOSTICS_HOST);
  if (!host || !document.body) return;
  const nodes: IngressNodes = {
    intro: document.getElementById(`${INGRESS_DIAGNOSTICS_HOST}-intro`),
    summary: document.getElementById(`${INGRESS_DIAGNOSTICS_HOST}-count`),
    empty: document.getElementById(`${INGRESS_DIAGNOSTICS_HOST}-empty`),
    list: document.getElementById(`${INGRESS_DIAGNOSTICS_HOST}-list`),
    template: document.getElementById(`${INGRESS_DIAGNOSTICS_HOST}-item`) as HTMLTemplateElement | null,
    feedback: document.getElementById(`${INGRESS_DIAGNOSTICS_HOST}-feedback`),
  };
  if (nodes.intro) nodes.intro.textContent = INGRESS_DIAGNOSTICS_INTRO_COPY;
  const emptyTitle = nodes.empty?.querySelector('.empty-title') ?? nodes.empty;
  if (emptyTitle) emptyTitle.textContent = INGRESS_DIAGNOSTICS_EMPTY_COPY;
  let reading = false;
  const refresh = async (): Promise<void> => {
    // At most one read in flight: a second pane entry during a read cannot let
    // an older response paint over a newer one.
    if (reading) return;
    reading = true;
    try { paintIngressDiagnostics(nodes, describeIngressDiagnostics(await readIngressDiagnostics())); }
    finally { reading = false; }
  };
  if (inSyncPane()) void refresh();
  // Read-on-entry only: no interval, so a background options tab costs nothing.
  new MutationObserver(() => { if (inSyncPane()) void refresh(); })
    .observe(document.body, { attributes: true, attributeFilter: ['data-pane'] });
}

function inSyncPane(): boolean {
  return document.body?.dataset.pane === INGRESS_DIAGNOSTICS_PANE || document.body?.dataset.pane === 'help';
}

function paintIngressDiagnostics(nodes: IngressNodes, view: IngressDiagnosticsView): void {
  if (!view.ok) {
    // Clear both the rows and the "nothing filtered" claim: an unreadable
    // ledger is not evidence that the list is empty.
    nodes.list?.replaceChildren();
    if (nodes.list) nodes.list.hidden = true;
    if (nodes.summary) { nodes.summary.hidden = true; nodes.summary.textContent = ''; }
    if (nodes.empty) nodes.empty.hidden = true;
    if (nodes.feedback) { nodes.feedback.hidden = false; nodes.feedback.textContent = view.message; }
    return;
  }
  if (nodes.feedback) { nodes.feedback.hidden = true; nodes.feedback.textContent = ''; }
  if (nodes.summary) {
    nodes.summary.hidden = view.empty;
    nodes.summary.textContent = view.empty ? '' : view.summary;
  }
  if (nodes.empty) nodes.empty.hidden = !view.empty;
  if (!nodes.list) return;
  nodes.list.hidden = view.empty;
  nodes.list.replaceChildren(...view.rows.map((row) => ingressDiagnosticItem(nodes.template, row)));
}

function ingressDiagnosticItem(template: HTMLTemplateElement | null, row: IngressDiagnosticRow): HTMLElement {
  const item = (template?.content.firstElementChild?.cloneNode(true) ?? document.createElement('li')) as HTMLElement;
  item.classList.add('ingress-diagnostics-item');
  item.dataset.code = row.code;
  const reason = document.createElement('p');
  reason.className = 'ingress-diagnostics-reason';
  reason.textContent = row.label;
  if (row.tag) {
    const tag = document.createElement('span');
    tag.className = 'ingress-diagnostics-tag';
    tag.textContent = row.tag;
    reason.append(tag);
  }
  const meta = document.createElement('p');
  meta.className = 'ingress-diagnostics-meta detail';
  meta.textContent = row.meta;
  item.replaceChildren(reason, meta);
  return item;
}

/** Bounded like `sync-attention-ui.ts`: a sleeping worker must not blank the card. */
async function readIngressDiagnostics(): Promise<IngressDiagnosticsResponse | undefined> {
  try {
    const pending = chrome.runtime.sendMessage(ingressDiagnosticsRequest()) as Promise<IngressDiagnosticsResponse>;
    const timeout = new Promise<undefined>((resolve) => { setTimeout(() => resolve(undefined), 8_000); });
    return await Promise.race([pending, timeout]);
  } catch { return undefined; }
}

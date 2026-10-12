import type { CaptureScope, CaptureTask } from './contracts.js';

export type LocalHistoryItem = CaptureTask & { readonly historyReadOnly?: true; readonly historyOrigin?: 'backup' | 'device'; readonly historyAutomaticApplied?: boolean };
interface HistoryStore {
  listForOwner(scope: CaptureScope, before?: readonly [number, string], limit?: number): Promise<readonly CaptureTask[]>;
}

interface BrowserActivityStore extends HistoryStore {
  rememberMany?(tasks: readonly CaptureTask[]): Promise<void>;
}

/** Private command history stays account-bound; optional device facts carry no remote authority. */
export async function listBrowserCaptureHistory(store: HistoryStore, scope: CaptureScope,
  before?: readonly [number, string], archive?: HistoryStore, activity?: BrowserActivityStore): Promise<readonly LocalHistoryItem[]> {
  const pages: Promise<readonly LocalHistoryItem[]>[] = [store.listForOwner(scope, before)];
  if (archive) pages.push(archive.listForOwner(scope, before));
  const guestScope = { ...scope, accountId: null, collectionId: null };
  if (scope.accountId) {
    pages.push(store.listForOwner(guestScope, before).then(guest => guest.map(task => ({ ...task, historyReadOnly: true as const }))));
    if (archive) pages.push(archive.listForOwner(guestScope, before));
  }
  const visiblePages = await Promise.all(pages);
  if (activity) {
    // Lazy migration only examines records already visible to this caller, never
    // private commands from another account or cloud-only/imported history.
    const nativeSaves = visiblePages.flat().filter(task => task.save === 'local-saved'
      && task.disposition === 'new' && task.nativeId && !task.historyReadOnly);
    await activity.rememberMany?.(nativeSaves).catch(() => undefined);
    visiblePages.push(await activity.listForOwner(scope, before).then(items => items.map(task => ({
      ...task, historyReadOnly: true as const,
    }))).catch(() => []));
  }
  // The richer current-account/guest record wins over its read-only device fact.
  // Stable capture identity prevents double counting and duplicate backup ids.
  const unique = new Map<string, LocalHistoryItem>();
  for (const page of visiblePages) for (const item of page) {
    if (!unique.has(item.captureId)) unique.set(item.captureId, item);
  }
  return [...unique.values()]
    .sort((a, b) => b.createdAt - a.createdAt || (a.captureId < b.captureId ? 1 : a.captureId > b.captureId ? -1 : 0))
    .slice(0, 50);
}

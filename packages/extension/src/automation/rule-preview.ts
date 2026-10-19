import type { Predicate } from '@know-n/colp/automation';
import type { FolderLookup } from './browser-rules.js';
import type { BrowserPreviewEntryView, BrowserPreviewPageView, BrowserPreviewSampleRow, BrowserPreviewView } from './messages.js';
import { isPublicSuffix } from './public-suffix.js';
import { decideList, type ListResult } from './rule-list-decide.js';
import type { FlatItem, FlatList } from './rule-list-flatten.js';

/**
 * Try a page against the whole list (doc 17 §6.2 preview mode, RS-08): the same first-match loop a save
 * runs, carried on to the end, so Options can name the winner, the entries passed over and every later
 * entry the winner shadows. A sample of recent bookmarks answers "would this change move anything" and
 * which broad rules hide others. Nothing is written; each answer carries the list revision and content
 * versions it was made from, so a page can tell when it is stale (RS-08.4).
 */
export const PREVIEW_SAMPLE = 500;
const ENTRY_LIMIT = 50;

export interface PreviewPage { readonly url: string; readonly title: string; readonly nativeId?: string }

/** *Site or its subdomains* on a public suffix ("ends with .io"): it takes a whole registry's sites. */
export function broadItem(item: FlatItem): boolean {
  const walk = (predicate: Predicate): boolean => predicate.kind === 'field'
    ? predicate.field === 'bookmark.url.host' && predicate.op === 'hostSuffix' && typeof predicate.value === 'string' && isPublicSuffix(predicate.value)
    : predicate.kind === 'all' || predicate.kind === 'any' ? predicate.items.some(walk) : false;
  return walk(item.definition.match);
}

const entryView = (item: FlatItem): BrowserPreviewEntryView => ({ id: item.id, name: item.name, ...item.ref, sourceName: item.source?.name ?? null });

function pageView(page: PreviewPage, result: ListResult): BrowserPreviewPageView {
  const { decision } = result;
  return { url: page.url, title: page.title, ...(page.nativeId ? { nativeId: page.nativeId } : {}),
    outcome: decision?.outcome ?? 'none', ...(decision?.reason ? { reason: decision.reason } : {}),
    winner: decision ? entryView(decision.item) : null, folder: decision?.folder ?? null,
    broad: decision ? broadItem(decision.item) : false,
    skipped: result.skipped.map(entryView), shadowed: result.shadowed.slice(0, ENTRY_LIMIT).map(entryView) };
}

/**
 * The list over a sample: each page's winner, and for each broad winner how many different later
 * entries it shadows on those pages (RS-08.5).
 */
async function sampleRows(flat: FlatList, pages: readonly PreviewPage[], lookup: FolderLookup, now: number) {
  const rows: BrowserPreviewSampleRow[] = [], shadows = new Map<string, { item: FlatItem; hidden: Set<string> }>();
  for (const page of pages) {
    const result = await decideList(flat.items, { url: page.url, title: page.title, explicit: false }, lookup, now, { preview: true });
    const { decision } = result;
    rows.push({ nativeId: page.nativeId ?? '', title: page.title, url: page.url, outcome: decision?.outcome ?? 'none',
      winnerId: decision?.item.id ?? null, winnerName: decision?.item.name ?? null, folder: decision?.folder?.title ?? null });
    if (decision && broadItem(decision.item)) {
      const seen = shadows.get(decision.item.id) ?? { item: decision.item, hidden: new Set<string>() };
      for (const item of result.shadowed) seen.hidden.add(item.id);
      shadows.set(decision.item.id, seen);
    }
  }
  return { rows, broad: [...shadows.values()].map(({ item, hidden }) => ({ ...entryView(item), shadows: hidden.size })) };
}

export async function previewList(flat: FlatList, stopped: FlatList['stopped'], request: { readonly page?: PreviewPage;
  readonly sample?: readonly PreviewPage[] }, lookup: FolderLookup, now: number): Promise<BrowserPreviewView> {
  const base = { listRevision: flat.revision, contentVersions: flat.contentVersions, stopped };
  if (!request.page) {
    const sample = await sampleRows(flat, request.sample ?? [], lookup, now);
    return { ...base, sample: { size: sample.rows.length, rows: sample.rows, broad: sample.broad } };
  }
  const result = await decideList(flat.items, { ...request.page, explicit: false }, lookup, now, { preview: true });
  const view = pageView(request.page, result);
  if (!view.broad || !result.decision) return { ...base, page: view };
  // A broad winner is measured against the sample too, so its label says what it hides beyond this page.
  const hidden = new Set(result.shadowed.map((item) => item.id));
  const winner = result.decision.item.id;
  for (const page of request.sample ?? []) {
    const other = await decideList(flat.items, { url: page.url, title: page.title, explicit: false }, lookup, now, { preview: true });
    if (other.decision?.item.id === winner) for (const item of other.shadowed) hidden.add(item.id);
  }
  return { ...base, page: { ...view, broadShadows: hidden.size } };
}

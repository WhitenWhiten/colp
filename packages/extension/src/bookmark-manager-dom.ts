import { readDisplayFavicon } from './favicon-display-cache.js';
import { bookmarkFaviconSources } from './bookmark-favicon-sources.js';
import { createIcon } from './icons.js';

export interface NativeNode {
  readonly id: string;
  readonly title: string;
  readonly url?: string;
  readonly parentId?: string;
  readonly index?: number;
  readonly unmodifiable?: string;
  readonly folderType?: string;
  readonly dateAdded?: number;
  readonly children?: readonly NativeNode[];
}

export type IconName = 'folder' | 'chevron' | 'globe' | 'pencil' | 'move' | 'trash' | 'more-horizontal' | 'sync' | 'pin';

export function icon(name: IconName): SVGSVGElement {
  return createIcon(name === 'chevron' ? 'chevron-down' : name);
}

/** True when this folder, or the nearest folder above it with a rule, is part of Know-N sync. */
export function isNodeSynced(
  id: string,
  nodesById: ReadonlyMap<string, NativeNode>,
  boundaries: { readonly selected: readonly string[]; readonly privateLocal: readonly string[] },
): boolean {
  let current: NativeNode | undefined = nodesById.get(id);
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (boundaries.privateLocal.includes(current.id)) return false;
    if (boundaries.selected.includes(current.id)) return true;
    current = current.parentId ? nodesById.get(current.parentId) : undefined;
  }
  return false;
}

/** Device icons and authorized server icons affect this extension view only. */
export function faviconTile(pageUrl: string, nativeId?: string): HTMLElement {
  const tile = document.createElement('span');
  tile.className = 'favicon-tile';
  const img = document.createElement('img');
  img.width = 32; img.height = 32; img.alt = ''; img.loading = 'lazy';
  const sources = bookmarkFaviconSources(pageUrl);
  let next = 0;
  const attempt = () => {
    const source = sources[next++];
    if (source) img.src = source;
    else img.replaceWith(icon('globe'));
  };
  img.addEventListener('error', attempt);
  tile.append(img);
  attempt();
  void (async () => {
    const source = await readDisplayFavicon(pageUrl).catch(() => null);
    if (source) { tile.replaceChildren(img); img.src = source; }
    if (!nativeId) return;
    const cloud = await chrome.runtime.sendMessage({ kind: 'known.favicon.display', nativeId, pageUrl }) as
      { ok?: boolean; suppressed?: boolean; iconUrl?: string | null } | undefined;
    if (cloud?.ok && cloud.suppressed) tile.replaceChildren(icon('globe'));
    else if (cloud?.ok && typeof cloud.iconUrl === 'string') {
      tile.replaceChildren(img); img.referrerPolicy = 'no-referrer'; img.src = cloud.iconUrl;
    }
  })().catch(() => undefined);
  return tile;
}

export function iconTile(name: IconName): HTMLElement {
  const tile = document.createElement('span');
  tile.className = 'favicon-tile';
  tile.append(icon(name));
  return tile;
}

/** A host as a person reads it, without a leading `www.`, as the web app shows it. */
export function displayHost(host: string): string {
  return host.replace(/^www\.(?=.)/iu, '');
}

export function domainOf(url: string): string {
  try { return displayHost(new URL(url).hostname) || url; } catch { return url; }
}

export function normalizedUrl(value: string): string | undefined {
  const raw = value.trim(); if (!raw) return undefined;
  const candidate = /^[a-z][a-z0-9+.-]*:/iu.test(raw) ? raw : `https://${raw}`;
  try { const parsed = new URL(candidate); return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : undefined; }
  catch { return undefined; }
}

export function collectSubtreeIds(node: NativeNode, output: Set<string>): void {
  output.add(node.id);
  for (const child of node.children ?? []) collectSubtreeIds(child, output);
}

/** Bookmarks (not folders) under each folder, for the tree's counts. */
export function bookmarkTotals(root: NativeNode): Map<string, number> {
  const totals = new Map<string, number>();
  const visit = (node: NativeNode): number => {
    if (node.url !== undefined) return 1;
    let sum = 0;
    for (const child of node.children ?? []) sum += visit(child);
    totals.set(node.id, sum);
    return sum;
  };
  visit(root);
  return totals;
}

export interface ManagerElements {
  readonly pane: HTMLElement;
  /** Shown instead of the manager while bookmark access is off. */
  readonly gate: HTMLElement;
  readonly gateButton: HTMLButtonElement;
  readonly reloadHint: HTMLElement;
  readonly body: HTMLElement;
  readonly card: HTMLElement;
  readonly tree: HTMLElement;
  readonly list: HTMLElement;
  readonly path: HTMLElement;
  readonly search: HTMLInputElement;
  readonly newFolder: HTMLButtonElement;
  readonly newBookmark: HTMLButtonElement;
  readonly feedback: HTMLElement;
  readonly selectToggle: HTMLButtonElement;
  /** The folder's Synced / Not synced mark at the right of the path bar. */
  readonly syncState: HTMLElement;
}

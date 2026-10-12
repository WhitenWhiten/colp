/**
 * Exact-bag oracles for first-run remediation MV3. Compare Chrome trees through
 * COLP IDs, never native IDs. Multiplicity is counted, not `includes` / `>= 2`.
 */
import { expect, type BrowserContext, type Page } from '@playwright/test';
import {
  evidence, liveCanonical, optionsPage, scopeFacts, type ProfileBinding,
} from './kns-08-harness.js';
import type { RealStack } from './real-stack.js';

const LIVE = new Set(['pending', 'claimed', 'deferred', 'gap', 'blocked', 'unknown', 'rejected']);

export type ChromeNode = {
  readonly id: string; readonly parentId: string; readonly title: string;
  readonly url: string; readonly kind: 'bookmark' | 'folder';
};
export type ColpNode = {
  readonly colpId: string; readonly parentColp: string; readonly title: string;
  readonly url: string; readonly kind: string;
};

export async function chromeTree(page: Page): Promise<readonly ChromeNode[]> {
  return page.evaluate(async () => {
    const rows: ChromeNode[] = [];
    const walk = (nodes: chrome.bookmarks.BookmarkTreeNode[], parentId: string) => {
      for (const node of nodes) {
        rows.push({
          id: node.id, parentId, title: node.title ?? '', url: node.url ?? '',
          kind: node.url ? 'bookmark' : 'folder',
        });
        if (node.children) walk(node.children, node.id);
      }
    };
    walk((await chrome.bookmarks.getTree())[0]?.children ?? [], '');
    return rows;
  });
}

export async function exportedScope(page: Page): Promise<any> {
  return evidence(page, 'exportOutboundPushEvidence');
}

export function mappingsByNative(exported: any): Map<string, any> {
  return new Map((exported.mappings ?? []).map((row: any) => [String(row.nativeId), row]));
}

export function colpBag(tree: readonly ChromeNode[], exported: any): ColpNode[] {
  const byNative = mappingsByNative(exported);
  const bag: ColpNode[] = [];
  for (const node of tree) {
    const mapping = byNative.get(node.id);
    if (!mapping) continue;
    const parent = node.parentId ? byNative.get(node.parentId) : undefined;
    bag.push({
      colpId: String(mapping.colpId),
      parentColp: parent ? String(parent.colpId) : String(mapping.parentColpId ?? ''),
      title: node.title, url: node.url, kind: node.kind,
    });
  }
  return bag;
}

export function serverBag(nodes: readonly Record<string, unknown>[]): ColpNode[] {
  return nodes.filter((node) => node.deleted_at == null && node.is_root !== true).map((node) => ({
    colpId: String(node.id), parentColp: String(node.parent_id ?? ''),
    title: String(node.title ?? ''), url: String(node.url ?? ''),
    kind: node.url ? 'bookmark' : 'folder',
  }));
}

export function countBy(nodes: readonly ColpNode[], key: (node: ColpNode) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    const item = key(node);
    counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  return counts;
}

export function contentKey(node: Pick<ColpNode, 'parentColp' | 'kind' | 'title' | 'url'>): string {
  return `${node.parentColp}|${node.kind}|${node.title}|${node.url}`;
}

export function assertUniqueMappings(exported: any): void {
  const mappings = exported.mappings ?? [];
  expect(new Set(mappings.map((row: any) => String(row.nativeId))).size).toBe(mappings.length);
  expect(new Set(mappings.map((row: any) => String(row.colpId))).size).toBe(mappings.length);
}

export function assertQueueFinished(exported: any): void {
  const queue = exported.queue ?? [];
  const sequences = queue.map((row: any) => Number(row.sequence)).sort((left: number, right: number) => left - right);
  expect(sequences).toEqual(sequences.map((_: number, index: number) => index + 1));
  expect(queue.filter((row: any) => LIVE.has(String(row.status)))).toEqual([]);
}

export async function waitObservedQuiet(page: Page, stack: RealStack, binding: ProfileBinding,
  timeout = 90_000): Promise<void> {
  await expect.poll(async () => {
    const facts = await scopeFacts(page, stack, binding);
    const live = facts.queueStatuses.filter((status) => LIVE.has(status));
    if (facts.recoveryFrozen === true || facts.rejectedPending === true) return 'busy';
    if (live.length > 0) return live.join(',');
    if (facts.mappingCount < 1) return 'nomap';
    return 'quiet';
  }, { timeout }).toBe('quiet');
}

export async function waitBarrierHits(page: Page, timeout = 90_000): Promise<void> {
  await expect.poll(async () => {
    const status = await evidence<{ hits?: number }>(page, 'projectionApplyBarrierStatus')
      .catch(() => ({ hits: 0 }));
    return Number(status.hits ?? 0);
  }, { timeout }).toBeGreaterThanOrEqual(1);
}

/**
 * Wait until an apply is HELD at the barrier — the bookmark exists and the
 * mapping is not yet durable — rather than merely having hit it.
 *
 * With the `hold` mode the apply is still suspended when this returns, so the
 * worker can be interrupted with that window open. With the default `throw` mode
 * the apply has already failed and unwound, which is why the older crash tests
 * terminate after the fact.
 */
export async function waitBarrierHeld(page: Page, timeout = 90_000): Promise<void> {
  await expect.poll(async () => {
    const status = await evidence<{ held?: number; mode?: string }>(page, 'projectionApplyBarrierStatus')
      .catch(() => ({ held: 0, mode: 'unknown' }));
    return `${status.mode}:${Number(status.held ?? 0)}`;
  }, { timeout }).toMatch(/^hold:[1-9]/u);
}

export async function withExtensionPage<T>(context: BrowserContext,
  work: (page: Page) => Promise<T>): Promise<T> {
  const page = await optionsPage(context);
  try { return await work(page); } finally { await page.close().catch(() => undefined); }
}

export async function assertBothSides(pageA: Page, pageB: Page, stack: RealStack,
  title: string, url: string): Promise<void> {
  const key = (node: ColpNode) => contentKey(node);
  await expect.poll(async () => {
    const live = serverBag(await liveCanonical(stack));
    const exportA = await exportedScope(pageA);
    const exportB = await exportedScope(pageB);
    const bagA = colpBag(await chromeTree(pageA), exportA);
    const bagB = colpBag(await chromeTree(pageB), exportB);
    const wanted = [...countBy(live, key).entries()].filter(([item]) => item.includes(title) && item.includes(url));
    if (wanted.length === 0) return 'server-missing';
    const missing = wanted.flatMap(([item, count]) => {
      const left = countBy(bagA, key).get(item);
      const right = countBy(bagB, key).get(item);
      return [
        ...(left === count ? [] : [`A ${item} have=${left ?? 0} want=${count}`]),
        ...(right === count ? [] : [`B ${item} have=${right ?? 0} want=${count}`]),
      ];
    });
    return missing.length === 0 ? 'aligned' : missing.join('; ');
  }, { timeout: 90_000 }).toBe('aligned');
  const exportA = await exportedScope(pageA);
  const exportB = await exportedScope(pageB);
  assertUniqueMappings(exportA);
  assertUniqueMappings(exportB);
  assertQueueFinished(exportA);
  assertQueueFinished(exportB);
}

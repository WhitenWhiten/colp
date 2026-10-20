import { expect, type Page } from '@playwright/test';
import { virtualNativeId } from '../src/projection-native-occupancy.js';
import type { MappingInput, ScopeRecord, SyncScope } from '../src/sync-state-store.js';
import type { PublicRootView, RootRequest, RootResponse } from '../src/types.js';

export async function readStores(page: Page, names: string[]): Promise<Record<string, Array<Record<string, unknown>>>> {
  return page.evaluate(async (storeNames) => {
    const request = indexedDB.open('known-phase3-indexeddb-entry');
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      const transaction = database.transaction(storeNames, 'readonly');
      return Object.fromEntries(await Promise.all(storeNames.map(async (name) => {
        const values = transaction.objectStore(name).getAll();
        const rows = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
          values.onsuccess = () => resolve(values.result); values.onerror = () => reject(values.error);
        });
        return [name, rows] as const;
      })));
    } finally { database.close(); }
  }, names);
}

export async function reviewCurrentRootAuthority(page: Page, view: PublicRootView) {
  const request: RootRequest = { kind: 'known.roots.preview', viewId: view.viewId,
    selectedRefs: view.roots.filter(row => row.selected).map(row => row.ref),
    privateRefs: view.roots.filter(row => row.privateLocal).map(row => row.ref) };
  const result = await page.evaluate(message => chrome.runtime.sendMessage(message), request) as RootResponse;
  expect(result.ok).toBe(true);
  if (!result.ok || !('preview' in result)) throw new Error('current_root_preview_missing');
  expect(result.preview).toMatchObject({ additions: [], removals: [], shifts: [] });
  return { request, preview: result.preview };
}

/** The request must reach the real preview/confirmation route. A legacy update
 * returns preview_required before inspecting any token and proves no isolation. */
export async function expectRootAuthorityRejected(page: Page, scope: SyncScope, requests: RootRequest[]) {
  const before = await boundaryEvidence(page, scope);
  for (const request of requests) {
    expect(await page.evaluate(message => chrome.runtime.sendMessage(message), request))
      .toEqual({ ok: false, error: 'request_invalid' });
    expect(await boundaryEvidence(page, scope)).toEqual(before);
  }
}

async function boundaryEvidence(page: Page, scope: SyncScope) {
  const names = ['sync_scopes', 'native_mappings', 'outbound_queue', 'receipts', 'apply_intents',
    'mount_bindings', 'boundary_confirmation_commands', 'scope_previews', 'durable_sequences'];
  const rows = await readStores(page, names);
  const record = rows.sync_scopes?.find(row => Object.entries(scope).every(([key, value]) => row[key] === value));
  expect(record).toBeDefined();
  const native = await page.evaluate(async () => {
    const visit = (nodes: chrome.bookmarks.BookmarkTreeNode[]): unknown[] => nodes.map(node => ({
      id: node.id, parentId: node.parentId, title: node.title, url: node.url, index: node.index,
      children: visit(node.children ?? []),
    }));
    return visit(await chrome.bookmarks.getTree());
  });
  return { native, scope: { selectedRoots: record!.selectedRoots, privateRoots: record!.privateRoots,
    boundaryVersion: record!.boundaryVersion, lifecycle: record!.lifecycle, firstRun: record!.firstRun },
  rows: Object.fromEntries(names.filter(name => name !== 'sync_scopes')
    .map(name => [name, (rows[name] ?? []).filter(row => row.scopeKey === record!.scopeKey)])) };
}

export async function expectProfileMappingBoundary(page: Page,
  exported: { scope: ScopeRecord; mappings: MappingInput[]; queue: unknown[] },
  fixture: { selected: string; privateRoot: string }, foreignRootId: string) {
  const selected = exported.mappings.filter(row => exported.scope.selectedRoots.includes(row.colpId));
  const privateRoots = exported.mappings.filter(row => (exported.scope.privateRoots ?? []).includes(row.colpId));
  expect(selected.map(row => row.nativeId)).toEqual([fixture.selected]);
  expect(privateRoots.map(row => row.nativeId)).toEqual([fixture.privateRoot]);
  const nativeRoot = await page.evaluate(async id => (await chrome.bookmarks.get(id))[0]!, fixture.selected);
  const structuralParent = exported.mappings.find(row => row.colpId === selected[0]!.parentColpId);
  expect(structuralParent).toMatchObject({ nativeId: nativeRoot.parentId, rootRole: 'bookmarks-bar' });
  expect(exported.scope.selectedRoots).not.toContain(structuralParent!.colpId);
  expect(exported.scope.privateRoots).not.toContain(structuralParent!.colpId);
  // This fixture has one empty selected folder with one private child. The only
  // additional real identity is its actual Bar ancestor, used for placement.
  expect(exported.mappings.filter(row => !virtualNativeId(row.nativeId)).map(row => row.nativeId).sort())
    .toEqual([fixture.selected, fixture.privateRoot, nativeRoot.parentId!].sort());
  const related = await readStores(page, ['mount_bindings']);
  const mounts = (related.mount_bindings ?? []).filter(row => row.scopeKey === exported.scope.scopeKey && row.status === 'active');
  expect(mounts.map(row => [row.nativeRootId, row.remoteMountNodeId]))
    .toEqual([[fixture.selected, selected[0]!.colpId]]);
  const foreign = exported.mappings.find(row => row.colpId === foreignRootId);
  if (foreign) expect(virtualNativeId(foreign.nativeId)).toBe(true);
  expect(exported.scope.selectedRoots).not.toContain(foreignRootId);
  expect(exported.scope.privateRoots).not.toContain(foreignRootId);
  expect(mounts.some(row => row.remoteMountNodeId === foreignRootId)).toBe(false);
  // Shared canonical facts may name the other root. They grant no upload body.
  expect(exported.queue.some(row => containsValue(row, foreignRootId))).toBe(false);
}

function containsValue(value: unknown, expected: string): boolean {
  if (value === expected) return true;
  if (Array.isArray(value)) return value.some(child => containsValue(child, expected));
  return Boolean(value && typeof value === 'object'
    && Object.values(value).some(child => containsValue(child, expected)));
}

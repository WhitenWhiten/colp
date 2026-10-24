import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, expect, test, vi } from 'vitest';
import { createSourceDatabase } from '../src/site-adapters/source-db.js';
const f = vi.hoisted(() => ({ allowed: true, parent: 'old', calls: 0, lost: false }));
vi.mock('../src/sw/classification-destination.js', () => ({ classificationDestinationPolicy: { assertAllowed: async () => { if (!f.allowed) throw new Error('destination_policy_changed'); } } }));
vi.mock('../src/bookmark-subscriptions/guards.js', () => ({ personalBookmarks: { move: async (_id: string, to: { parentId: string }) => {
  f.calls++; f.parent = to.parentId; if (f.lost) { f.lost = false; throw new Error('response lost'); }
} } }));
vi.mock('../src/site-adapters/source-runtime.js', async () => ({ siteLedger: { db: createSourceDatabase(new IDBFactory()) } }));
import { handleDestinationRequest, validDestinationRequest } from '../src/site-adapters/destination-runtime.js';
const message = () => ({ kind: 'known.siteAdapters.destination.move', commandId: crypto.randomUUID(), nativeId: 'bookmark', parentId: 'new', expectedParentId: 'old', expectedTitle: 'Video', expectedUrl: 'https://example.test/', dateAdded: 10, digest: `sha256:${'a'.repeat(64)}` });
beforeEach(() => { f.allowed = true; f.parent = 'old'; f.calls = 0; f.lost = false;
  vi.stubGlobal('chrome', { bookmarks: { get: async () => [{ id: 'bookmark', title: 'Video', url: 'https://example.test/', dateAdded: 10, parentId: f.parent }] } }); });
test('native application rejects forged payloads and changed policy without moving', async () => {
  const r = message(); expect(validDestinationRequest({ ...r, recipe: 'arbitrary' })).toBe(false);
  f.allowed = false; await expect(handleDestinationRequest(r)).rejects.toThrow('destination_policy_changed'); expect(f.calls).toBe(0);
});
test('a lost move response is recovered under its original command and native creation identity', async () => {
  const r = message(); f.lost = true; await expect(handleDestinationRequest(r)).rejects.toThrow('response lost');
  expect(await handleDestinationRequest(r)).toEqual({ ok: true }); expect(f.calls).toBe(1);
  await expect(handleDestinationRequest({ ...r, parentId: 'replacement' })).rejects.toThrow('command_id_reused');
  f.parent = 'old'; await expect(handleDestinationRequest(r)).rejects.toThrow('capture_bookmark_changed'); expect(f.calls).toBe(1);
});

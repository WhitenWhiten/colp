import { expect, test, vi } from 'vitest';
import { createSiteAgentManager } from '../src/site-adapters/agent-management.js';
import { initialTransportState, createSiteTransport } from '../src/site-adapters/transport.js';
import { registerSiteAgent, manageSiteAgent } from '../src/site-adapters/agent-runtime.js';
import { legacySite } from '../src/site-adapters/registry.js';
import { createTrustedSiteStorage } from '../src/site-adapters/trusted-storage.js';
import { resolvePageItem } from '../src/site-adapters/resolve-page-item.js';

function fixture() {
  let state = initialTransportState(), configuration: unknown = null, allowed = true;
  const archive = { valid: (v: unknown) => !!v && typeof v === 'object' && 'kind' in v,
    handle: vi.fn(async (_raw: unknown, guard?: () => Promise<void>) => { await guard?.(); return { importId: 'import' }; }) };
  const transport = createSiteTransport({ read: async () => structuredClone(state), write: async next => { state = next; },
    extensionId: 'extension', now: Date.now, random: () => 'random', permitted: async () => true, current: async () => null }, legacySite);
  const readCollections = vi.fn(async () => ({ status: 'reading' }));
  const manager = createSiteAgentManager({ ready: async () => {}, state: async () => state, configuration: async () => configuration,
    archive, connection: (enabled, guard) => transport.configure(enabled, guard), readCollections,
    collections: async () => ({ items: Array.from({ length: 47 }, (_, i) => ({ id: String(i), identity: 'siteId' as const, title: `Collection ${i}` })), nextCursor: 'source-next' }),
    importStatus: async () => ({ id: 'import', phase: 'preview', pageReceipts: ['private internal facts'],
      progress: { prepared: 3 }, preview: { id: 'preview', revision: 2, digest: 'digest', counts: { createBookmarks: 3 } } }), wake: () => {},
  });
  const authorize = async () => { if (!allowed) throw Error('device_bridge_disabled'); };
  const call = (operation: string, input: { revision?: string; cursor?: string; request?: Record<string, unknown> } = {}) => manager({
    operation, requestId: 'request', ...input, assertCurrent: authorize,
  });
  return { call, manager, archive, readCollections, change: () => { configuration = { changedByUser: true }; }, revoke: () => { allowed = false; } };
}

test('configuration changes use a current revision and never disclose transport capabilities', async () => {
  const f = fixture();
  const before = await f.call('configuration') as { revision: string };
  const enabled = await f.call('configure', { revision: before.revision, request: { operation: 'enable', enabled: true } });
  expect(enabled).toMatchObject({ enabled: true, configured: true });
  expect(JSON.stringify(enabled)).not.toContain('leases');
  await expect(f.call('configure', { revision: before.revision, request: { operation: 'disable_archive' } })).rejects.toThrow('adapter_configuration_changed');
  const fresh = await f.call('configuration') as { revision: string };
  f.change();
  await expect(f.call('configure', { revision: fresh.revision, request: { operation: 'archive', rootNativeId: '30' } })).rejects.toThrow('adapter_configuration_changed');
  f.revoke(); await expect(f.call('configuration')).rejects.toThrow('device_bridge_disabled');
});

test('cached collection pagination stays separate from source pagination and refresh waits for current configuration', async () => {
  const f = fixture(); let cursor: string | undefined; const ids: string[] = [];
  do {
    const page = await f.call('collections', { cursor, request: { mode: 'list' } }) as { items: { id: string }[]; nextCursor: string | null; sourceCursor: string };
    ids.push(...page.items.map(row => row.id)); expect(page.sourceCursor).toBe('source-next'); cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(new Set(ids).size).toBe(47);
  const current = await f.call('configuration') as { revision: string };
  expect(await f.call('collections', { revision: current.revision, request: { mode: 'refresh', sourceCursor: 'source-next' } })).toEqual({ status: 'reading' });
  expect(f.readCollections).toHaveBeenCalledWith('source-next');
});

test('import workflow exposes the reviewed preview, forwards exact approval, and respects host disposal', async () => {
  const f = fixture(), current = await f.call('configuration') as { revision: string };
  await f.call('import_preview', { revision: current.revision });
  expect(f.archive.handle).toHaveBeenCalledWith({ kind: 'known.siteAdapters.import.start' }, expect.any(Function));
  const result = await f.call('import_get') as { job: { preview: { id: string; revision: number; digest: string } } };
  expect(JSON.stringify(result)).not.toContain('private internal facts');
  const request = { jobId: 'import', previewId: result.job.preview.id, revision: result.job.preview.revision, digest: result.job.preview.digest };
  await f.call('import_approve', { revision: current.revision, request });
  expect(f.archive.handle).toHaveBeenLastCalledWith({ kind: 'known.siteAdapters.import.approve', ...request }, expect.any(Function));
  const dispose = registerSiteAgent('site', async () => {}, f.manager);
  expect(await manageSiteAgent('site', { operation: 'import_get', requestId: 'request', assertCurrent: async () => {} })).toEqual(result);
  dispose(); expect(() => manageSiteAgent('site', { operation: 'configuration', requestId: 'request', assertCurrent: async () => {} })).toThrow('adapter_unavailable');
});

test('trusted storage retries a failed boundary setup and caches only successful setup', async () => {
  const setAccessLevel = vi.fn().mockRejectedValueOnce(Error('unavailable')).mockResolvedValue(undefined);
  const ready = createTrustedSiteStorage([{ setAccessLevel }]);
  await expect(ready()).rejects.toThrow('unavailable');
  await ready(); await ready();
  expect(setAccessLevel).toHaveBeenCalledTimes(2);
  expect(setAccessLevel).toHaveBeenLastCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
});

test('page resolution binds the document and rejects a replaced inspection command', async () => {
  const url = `${legacySite.origin}/video/av1`, definition = { ...legacySite, sameResolutionTarget: () => true };
  const context = { connectionId: 'source', documentId: 'doc', leaseId: 'lease', installationGeneration: 1,
    sourceSessionGeneration: 1, routeEpoch: 0, tabId: 1 };
  const current = { command: { deadlineAt: Date.now() + 10000, id: 'first' }, result: { status: 'resolved', item: { id: 'item' } } };
  const inspection = vi.fn(async () => current);
  const ports = { source: async () => ({ context }), state: async () => ({ leases: [{ id: 'lease', url }] }),
    inspect: async () => ({ status: 'reading' }), inspection };
  expect(await resolvePageItem(definition, url, 1, ports, { commandMs: 100, spacingMs: 1 })).toBe('item');
  inspection.mockResolvedValueOnce(current).mockResolvedValueOnce({ ...current, command: { ...current.command, id: 'replacement' } });
  expect(await resolvePageItem(definition, url, 1, ports, { commandMs: 100, spacingMs: 1 })).toBeNull();
});

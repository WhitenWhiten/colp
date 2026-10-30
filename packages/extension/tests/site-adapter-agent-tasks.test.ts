import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, test } from 'vitest';
import { createSourceDatabase, sourceKey } from '../src/site-adapters/source-db.js';
import { listAgentTasks, readAgentTask, retryAgentSave } from '../src/site-adapters/agent-tasks.js';
import { registerSiteAgent, controlSiteAgent } from '../src/site-adapters/agent-runtime.js';
import { createSiteAgentController } from '../src/site-adapters/agent-controller.js';
import { retryLocalTransfers } from '../src/site-adapters/local-transfer-queue.js';
const owner = { serverOrigin: 'https://server.test', accountId: 'owner', collectionId: 'library' };

test('bounded task pages cover a whole connection and refuse foreign continuations', async () => {
  const db = createSourceDatabase(new IDBFactory());
  try {
    await db.transaction(['work'], 'readwrite', async tx => {
      for (let n = 0; n < 45; n++) tx.objectStore('work').put({ id: `work-${String(n).padStart(3, '0')}`, connectionId: 'connection', dueAt: Number.MAX_SAFE_INTEGER,
        reason: 'nativeIdentityChanged', attempts: 2 }, `work-${String(n).padStart(3, '0')}`);
      tx.objectStore('work').put({ id: 'foreign', connectionId: 'other', dueAt: 0 }, 'foreign');
    });
    let cursor: string | null = null; const ids: string[] = [];
    do {
      const page = await listAgentTasks(db, { requestId: 'request', kind: 'save', connectionId: 'connection', owner, ...(cursor ? { cursor } : {}) });
      ids.push(...page.items.map(item => item.id)); cursor = page.nextCursor;
      if (cursor) await expect(listAgentTasks(db, { requestId: 'request', kind: 'save', connectionId: 'other', owner, cursor })).rejects.toThrow('invalid_cursor');
    } while (cursor);
    expect(new Set(ids).size).toBe(45); expect(ids).not.toContain('foreign');
    const task = await readAgentTask(db, 'save', 'connection', ids[0]!, owner);
    await expect(retryAgentSave(db, 'connection', task.id, 'stale')).rejects.toThrow('adapter_task_changed');
    await db.transaction(['outbox'], 'readwrite', async tx => { tx.objectStore('outbox').put({ state: 'unknown', command: { commandId: 'original' } }, 'original'); });
    await retryAgentSave(db, 'connection', task.id, task.revision);
    expect(await db.read('work', task.id)).toMatchObject({ dueAt: 0, attempts: 2 });
    expect(await db.read('outbox', 'original')).toEqual({ state: 'unknown', command: { commandId: 'original' } });
  } finally { await db.close(); }
});

test('transfer tasks retain cloud ownership while one damaged semantic row does not hide healthy tasks', async () => {
  const db = createSourceDatabase(new IDBFactory());
  try {
    await db.transaction(['transfers', 'semanticJobs'], 'readwrite', async tx => {
      tx.objectStore('transfers').put({ commandId: 'private', connectionId: 'connection', owner: { ...owner, accountId: 'other' }, state: 'attention' }, 'private');
      tx.objectStore('semanticJobs').put({ id: 'broken', connections: ['connection'], scope: owner, state: 'pending', invalid: 1n }, 'broken');
      tx.objectStore('semanticJobs').put({ id: 'healthy', connections: ['connection'], scope: owner, state: 'attention', reason: 'local_key_required' }, 'healthy');
    });
    expect((await listAgentTasks(db, { requestId: 'r', kind: 'transfer', connectionId: 'connection', owner })).items).toEqual([]);
    const page = await listAgentTasks(db, { requestId: 'r', kind: 'semantic', connectionId: 'connection', owner });
    expect(page.items).toEqual([expect.objectContaining({ id: 'broken', reason: 'record_invalid', actions: [] }),
      expect.objectContaining({ id: 'healthy', reason: 'local_key_required', actions: ['retry'] })]);
  } finally { await db.close(); }
});

test('confirmation task details expose no page hint or capability payload', async () => {
  const db = createSourceDatabase(new IDBFactory());
  try {
    await db.transaction(['readRequests'], 'readwrite', async tx => { tx.objectStore('readRequests').put({ id: 'hint', state: 'uncertain',
      hint: { code: 0, privatePagePayload: 'not-for-diagnostics' }, origin: { connectionId: 'connection', capability: 'private-capability' }, reason: 'timeout' }, sourceKey('hint', 'hint')); });
    const result = await readAgentTask(db, 'confirmation', 'connection', 'hint', owner);
    expect(result.actions).toEqual(['retry']); expect(JSON.stringify(result)).not.toContain('private-');
  } finally { await db.close(); }
});

test('retiring an old host cannot remove the replacement host controller', async () => {
  const input = { connectionId: 'connection', kind: 'save' as const, id: 'work', revision: 'revision', action: 'retry' as const, owner, assertCurrent: async () => {} };
  const dispose = registerSiteAgent('site', async () => 'old');
  const replacement = registerSiteAgent('site', async () => 'new');
  dispose(); expect(await controlSiteAgent('site', input)).toBe('new'); replacement();
  expect(() => controlSiteAgent('site', input)).toThrow('adapter_unavailable');
});

test('task control rejects stale revisions and retries only the selected transfer', async () => {
  const db = createSourceDatabase(new IDBFactory());
  try {
    await db.transaction(['authorities', 'transfers'], 'readwrite', async tx => {
      tx.objectStore('authorities').put({ enabled: true, connectionId: 'connection' }, 'site');
      for (const id of ['one', 'two']) tx.objectStore('transfers').put({ commandId: id, connectionId: 'connection', owner,
        state: 'attention', dueAt: Number.MAX_SAFE_INTEGER }, id);
    });
    const act = createSiteAgentController({ db, adapterId: 'site', ready: async () => {}, wake: () => {},
      importer: { retry: async () => {}, resume: async () => {}, cancel: async () => {} }, reconcile: async () => {}, confirm: async () => {}, semantic: async () => {} });
    const task = await readAgentTask(db, 'transfer', 'connection', 'one', owner);
    const input = { connectionId: 'connection', kind: 'transfer' as const, id: 'one', revision: 'stale', action: 'retry' as const, owner, assertCurrent: async () => {} };
    await expect(act(input)).rejects.toThrow('adapter_task_changed');
    await act({ ...input, revision: task.revision });
    expect(await db.read('transfers', 'one')).toMatchObject({ state: 'pending', dueAt: 0 });
    expect(await db.read('transfers', 'two')).toMatchObject({ state: 'attention' });
    await expect(act({ ...input, revision: task.revision, connectionId: 'other' })).rejects.toThrow('sourceAuthorizationChanged');
    await retryLocalTransfers(db, 'other', 'two');
    expect(await db.read('transfers', 'two')).toMatchObject({ state: 'attention' });
  } finally { await db.close(); }
});

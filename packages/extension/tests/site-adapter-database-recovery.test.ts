import 'fake-indexeddb/auto';
import { IDBFactory, forceCloseDatabase } from 'fake-indexeddb';
import { expect, test, vi } from 'vitest';
import { createSourceDatabase } from '../src/site-adapters/source-db.js';
// fake-indexeddb's declaration takes the constructor, while its implementation takes an instance.
const forceClose = forceCloseDatabase as unknown as (database: IDBDatabase) => void;

test.each(['forced', 'silent'] as const)('a %s closed connection reopens and retains durable evidence', async kind => {
  const db = createSourceDatabase(new IDBFactory());
  try {
    await db.transaction(['meta'], 'readwrite', async tx => { tx.objectStore('meta').put({ commandId: 'original' }, 'receipt'); });
    const closed = await db.open();
    if (kind === 'forced') forceClose(closed); else closed.close();
    expect(await db.read('meta', 'receipt')).toEqual({ commandId: 'original' });
    expect(await db.open()).not.toBe(closed);
    await db.transaction(['meta'], 'readwrite', async tx => { tx.objectStore('meta').put('new', 'next'); });
    expect(await db.read('meta', 'next')).toBe('new');
  } finally { await db.close(); }
});

test('an InvalidStateError after application work begins is never automatically replayed', async () => {
  const db = createSourceDatabase(new IDBFactory());
  try {
    const work = vi.fn(async (tx: IDBTransaction) => {
      tx.objectStore('meta').put('tentative', 'write');
      throw new DOMException('application state changed', 'InvalidStateError');
    });
    await expect(db.transaction(['meta'], 'readwrite', work)).rejects.toMatchObject({ name: 'InvalidStateError' });
    expect(work).toHaveBeenCalledOnce();
    expect(await db.read('meta', 'write')).toBeUndefined();
  } finally { await db.close(); }
});

test('a transient synchronous open failure does not poison the connection cache', async () => {
  const factory = new IDBFactory(), open = factory.open.bind(factory);
  vi.spyOn(factory, 'open').mockImplementationOnce(() => { throw new DOMException('temporarily unavailable', 'UnknownError'); }).mockImplementation(open);
  const db = createSourceDatabase(factory);
  try {
    await expect(db.open()).rejects.toMatchObject({ name: 'UnknownError' });
    expect(await db.read('meta', 'missing')).toBeUndefined();
  } finally { await db.close(); }
});

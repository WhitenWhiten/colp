import { afterEach, describe, expect, it } from 'vitest';
import { createNativeExecutor } from '../src/bookmark-subscriptions/native.js';
import { database, nativeFixture, owned, root, row } from './bookmark-subscriptions-fixture.js';

const stores: ReturnType<typeof database>[] = [];
afterEach(async () => { for (const db of stores.splice(0)) await db.close(); });

async function setup() {
  const db = database(); stores.push(db);
  const mapping = row(); await db.put('mappings', mapping);
  const fixture = nativeFixture();
  const bookmark = await fixture.api.create({ parentId: 'bar', title: root.title });
  const evidence = owned(mapping, root, bookmark.id);
  await db.put('nodes', evidence);
  return { db, mapping, fixture, evidence };
}

describe('native move rejection journal', () => {
  it('retires an explicit index rejection and permits an authorized retry', async () => {
    const { db, mapping, fixture, evidence } = await setup();
    const move = fixture.api.move;
    fixture.api.move = async () => { throw new Error('Index out of bounds.'); };
    const native = createNativeExecutor(db, fixture.api);
    await expect(native.restorePlacement(mapping, evidence, 'bar', 2)).rejects.toThrow('Index out of bounds');
    const [operation] = await db.all('operations');
    expect(operation).toMatchObject({ phase: 'received', settled: true, eventConsumed: true, observedOutcome: 'not_applied' });
    expect(await db.nodeForNative(evidence.nativeId)).toEqual(evidence);
    expect(await db.pendingOperations()).toEqual([]);
    await native.recover(mapping);
    fixture.api.move = move;
    await native.restorePlacement(mapping, evidence, 'bar', 0);
    expect(await db.pendingOperations()).toEqual([]);
  });

  it('keeps a lost reply pending instead of inferring non-application', async () => {
    const { db, mapping, fixture, evidence } = await setup();
    fixture.api.move = async () => { throw new Error('Connection closed before reply'); };
    const native = createNativeExecutor(db, fixture.api);
    await expect(native.restorePlacement(mapping, evidence, 'bar', 2)).rejects.toThrow('Connection closed');
    expect(await db.pendingOperations()).toMatchObject([{ phase: 'issued' }]);
    await expect(native.recover(mapping)).rejects.toThrow('recovery_identity_uncertain');
    expect(await db.nodeForNative(evidence.nativeId)).toEqual(evidence);
  });
});

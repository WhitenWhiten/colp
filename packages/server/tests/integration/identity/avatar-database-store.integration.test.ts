import { test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createIsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';
import { makePng } from '../../support/link-preview-fixtures.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createDatabaseAvatarStore, createPersistentAvatarStore } from '../../../src/infrastructure/identity/index.js';

test('without R2, avatar bytes persist in the database through the upload lifecycle', async () => {
  const isolated = await createIsolatedPostgresRuntime('avatar_database_store');
  try {
    const { db, pool } = isolated.runtime;
    await runMigrations(db, 'latest');
    await pool.query("insert into accounts(id,subject_id,status) values ('a','a','active')");
    await pool.query("insert into profiles(account_id,display_name,updated_at) values ('a','a',now())");
    const png = makePng(4, 4);
    const id = randomUUID();

    const objects = createDatabaseAvatarStore(db);
    const store = createPersistentAvatarStore(db, objects);
    await store.put(id, png, 'image/png', 'a');
    expect(await store.get(id)).toEqual({ contentType: 'image/png', body: png });
    // A store reopened on the same database reads the same bytes.
    expect((await createDatabaseAvatarStore(db).get(id))?.body).toEqual(png);
    const state = await pool.query('select lifecycle_state from avatar_objects where object_id=$1', [id]);
    expect(state.rows[0]?.lifecycle_state).toBe('ready');

    await expect(objects.put(randomUUID(), Buffer.from('not an image'), 'image/png')).rejects.toMatchObject({ code: 'invalid_identity_input' });
    await expect(objects.get('../outside')).rejects.toThrow('Invalid avatar object id');

    // Unreferenced bytes are removed by the lifecycle cleanup.
    await store.delete(id);
    expect(await objects.get(id)).toBeNull();
  } finally { await isolated.close(); }
}, 120000);

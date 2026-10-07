import { test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createIsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPersistentAvatarStore } from '../../../src/infrastructure/identity/avatar-lifecycle-store.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';

test('ATT-01: trusted upload ownership and active references gate mutation and deletion', async () => {
  const isolated = await createIsolatedPostgresRuntime('avatar_ownership');
  try {
    const {db,pool} = isolated.runtime;
    await runMigrations(db,'latest');
    for (const id of ['a','b']) {
      await pool.query("insert into accounts(id,subject_id,status) values ($1,$1,'active')",[id]);
      await pool.query("insert into profiles(account_id,display_name,updated_at) values ($1,$1,now())",[id]);
    }
    const objects = new Map<string, Buffer>();
    let blockDelete = false;
    let enteredDelete!: () => void;
    let resumeDelete!: () => void;
    const deleting = new Promise<void>(resolve => { enteredDelete = resolve; });
    const release = new Promise<void>(resolve => { resumeDelete = resolve; });
    const store = createPersistentAvatarStore(db,{
      async put(id,body) { objects.set(id,body); },
      async get(id) { const body = objects.get(id); return body ? {body,contentType:'image/png'} : null; },
      async delete(id) { if (blockDelete) { enteredDelete(); await release; } objects.delete(id); },
    });
    const id = randomUUID();
    const url = `https://app.example.test/api/v1/avatar/${id}`;
    await store.put(id,Buffer.from('image'),'image/png','a');
    await pool.query('update profiles set avatar_url=$1 where account_id=$2',[url,'a']);
    const uow = createPostgresIdentityUnitOfWork(db);
    await expect(uow.execute(async ports => {
      const profile = (await ports.profiles.findByAccountId('b'))!;
      await ports.profiles.update({...profile,avatarUrl:url});
    })).rejects.toMatchObject({code:'invalid_identity_input'});
    await store.delete(id);
    expect(objects.has(id)).toBe(true);
    // A legacy governance-attribution row cannot be promoted into ownership.
    const legacy = randomUUID();
    await pool.query('insert into avatar_objects(object_id,account_id) values ($1,$2)',[legacy,'b']);
    objects.set(legacy,Buffer.from('legacy'));
    await expect(pool.query('update profiles set avatar_url=$1 where account_id=$2',[`https://app.example.test/api/v1/avatar/${legacy}`,'b'])).rejects.toMatchObject({constraint:'avatar_upload_ownership'});
    await store.delete(legacy);
    expect(objects.has(legacy)).toBe(true);
    await pool.query('update profiles set avatar_url=null where account_id=$1',['a']);
    blockDelete = true;
    const cleanup = store.delete(id);
    await deleting;
    await expect(pool.query('update profiles set avatar_url=$1 where account_id=$2',[url,'a'])).rejects.toMatchObject({constraint:'avatar_upload_ownership'});
    resumeDelete();
    await cleanup;
    expect(objects.has(id)).toBe(false);
    await expect(pool.query('update profiles set avatar_url=$1 where account_id=$2',[url,'a'])).rejects.toMatchObject({constraint:'avatar_upload_ownership'});
  } finally { await isolated.close(); }
},120000);

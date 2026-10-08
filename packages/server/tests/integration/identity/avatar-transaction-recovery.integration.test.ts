import { test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createIsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPersistentAvatarStore } from '../../../src/infrastructure/identity/avatar-lifecycle-store.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import { prepareAvatarUpload, uploadAvatar } from '../../../src/modules/identity/index.js';

const PNG = Buffer.from('89504e470d0a1a0a00000000','hex');

test('ATT-02: profile, receipt, commit and lost acknowledgement preserve referenced bytes and recover GC', async () => {
  const isolated = await createIsolatedPostgresRuntime('avatar_transaction_recovery');
  try {
    const {db,pool} = isolated.runtime;
    await runMigrations(db,'latest');
    const objects = new Map<string,Buffer>();
    let insideTransaction = false;
    let failDelete = false;
    let puts = 0;
    const provider = {
      async put(id: string, body: Buffer) { expect(insideTransaction).toBe(false); puts++; objects.set(id,body); },
      async get(id: string) { const body=objects.get(id); return body ? {body,contentType:'image/png'} : null; },
      async delete(id: string) { expect(insideTransaction).toBe(false); if (failDelete) throw new Error('provider interrupted'); objects.delete(id); },
    };
    const store = createPersistentAvatarStore(db,provider);
    let index = 0;
    for (const phase of ['profile','receipt','commit','ack'] as const) {
      const accountId = `avatar-${index++}`;
      await pool.query("insert into accounts(id,subject_id,status) values ($1,$1,'active')",[accountId]);
      await pool.query('insert into profiles(account_id,display_name,updated_at) values ($1,$1,now())',[accountId]);
      await pool.query('insert into profile_handles(handle,account_id,created_at) values ($1,$2,now())',[`avatar_${index}`,accountId]);
      const oldId = randomUUID();
      const oldUrl = `https://app.example.test/api/v1/avatar/${oldId}`;
      await store.put(oldId,PNG,'image/png',accountId);
      await pool.query('update profiles set avatar_url=$1 where account_id=$2',[oldUrl,accountId]);
      const input = {accountId,body:PNG,contentType:'image/png',productOrigin:'https://app.example.test',commandId:randomUUID()};
      const preparedAvatarId = await prepareAvatarUpload(store,input);
      const uow = createPostgresIdentityUnitOfWork(db, {faultInjector: {
        afterCallbackBeforeCommit() { if(phase==='commit') throw new Error('commit failed'); },
        afterCommitAcknowledged() { if(phase==='ack') throw new Error('ack lost'); },
      }});
      insideTransaction = true;
      await expect(uow.execute(async ports => {
        return uploadAvatar({ ...ports,
          profiles: phase === 'profile' ? {...ports.profiles, async update() {throw new Error('profile failed');}} : ports.profiles,
          receipts: phase === 'receipt' ? {...ports.receipts, async complete(...args) {await ports.receipts.complete(...args); throw new Error('receipt failed');}} : ports.receipts,
        },{...input,preparedAvatarId});
      })).rejects.toThrow();
      insideTransaction = false;
      const url = (await db.selectFrom('profiles').select('avatar_url').where('account_id','=',accountId).executeTakeFirstOrThrow()).avatar_url;
      expect(url).toBe(phase==='ack' ? `${input.productOrigin}/api/v1/avatar/${preparedAvatarId}` : oldUrl);
      expect(objects.has(oldId)).toBe(true);
      expect(objects.has(preparedAvatarId)).toBe(true);
      const retryPreparedId = await prepareAvatarUpload(store,input);
      const retry = await createPostgresIdentityUnitOfWork(db).execute(ports => uploadAvatar(ports,{...input,preparedAvatarId: retryPreparedId}));
      expect(retry.kind).toBe(phase==='ack'?'replay':'created');
      const replay = await createPostgresIdentityUnitOfWork(db).execute(ports => uploadAvatar(ports,{...input,preparedAvatarId}));
      expect(replay.kind).toBe('replay');
    }
    // An abandoned prepared object survives process loss and is reclaimed later.
    const orphan = randomUUID();
    await store.put(orphan,PNG,'image/png','avatar-0');
    await pool.query("update avatar_objects set cleanup_after=now()-interval '1 second',lease_until=null where uploader_account_id is not null");
    failDelete=true;
    await expect(store.drainCleanup()).rejects.toThrow('provider interrupted');
    expect((await pool.query("select count(*) from avatar_objects where lifecycle_state='deleting'")).rows[0].count).toBe('1');
    // Simulated new API process takes over persisted leases, no in-memory retry list.
    failDelete=false;
    await pool.query("update avatar_objects set lease_until=null,cleanup_after=now()-interval '1 second' where lifecycle_state='deleting'");
    const restarted = createPersistentAvatarStore(db,provider);
    await restarted.drainCleanup();
    expect(objects.has(orphan)).toBe(false);
    const profiles = await db.selectFrom('profiles').select('avatar_url').execute();
    for (const profile of profiles) expect(objects.has(profile.avatar_url!.split('/').at(-1)!)).toBe(true);
    expect(objects.size).toBe(4);
  } finally { await isolated.close(); }
},120000);

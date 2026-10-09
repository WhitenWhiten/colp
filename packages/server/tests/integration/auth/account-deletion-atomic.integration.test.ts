import { test, expect } from 'vitest';
import { createIsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresAccountDeletionStore } from '../../../src/infrastructure/auth/account-deletion-postgres.js';
import { createPostgresCollectionPolicyRevisionPort } from '../../../src/infrastructure/collections/index.js';
import { createPostgresPublicationMetadataReadPort } from '../../../src/infrastructure/publication/index.js';
import { sql } from 'kysely';

test('AUTH-03: deletion phases roll back together and approved retry is idempotent', async () => {
  const isolated = await createIsolatedPostgresRuntime('atomic_account_deletion');
  try {
    const { db, pool } = isolated.runtime;
    await runMigrations(db, 'latest');
    await pool.query("insert into accounts(id,subject_id,status,email) values ('acct','subject','active','atomic@example.test')");
    await pool.query(`insert into auth_users(id,name,email,"emailVerified") values ('usr','Atomic','atomic@example.test',true)`);
    await pool.query(`insert into auth_accounts(id,"accountId","providerId","userId",issuer,password,"createdAt","updatedAt") values ('cred','usr','credential','usr','credential','hash',now(),now())`);
    await pool.query("insert into auth_user_account_map(auth_user_id,account_id) values ('usr','acct')");
    await pool.query(`insert into auth_sessions(id,token,"expiresAt","userId","createdAt","updatedAt") values ('sess','token',now()+interval '1 day','usr',now(),now())`);
    await pool.query(`insert into auth_verifications(id,identifier,value,"expiresAt") values ('trust','hashed-trust','usr',now()+interval '1 day')`);
    for (const phase of ['accounts', 'auth_verifications', 'auth_users', 'commit'] as const) {
      const store = createPostgresAccountDeletionStore(db, {
        collectionPolicyRevisions: (transaction) => createPostgresCollectionPolicyRevisionPort(transaction),
        faultInjector: {
          async beforeCallback(tx) {
            if (phase === 'commit') return;
            await sql`create function pg_temp.reject_delete_phase() returns trigger language plpgsql as $$ begin raise exception 'injected phase failure'; end $$`.execute(tx);
            await sql.raw(`create trigger fail_phase before ${phase === 'accounts' ? 'update' : 'delete'} on ${phase} for each row execute function pg_temp.reject_delete_phase()`).execute(tx);
          },
          afterCallbackBeforeCommit() { if (phase === 'commit') throw new Error('injected commit failure'); },
        },
      });
      await expect(store.complete('acct', 'usr')).rejects.toThrow();
      const account = await db.selectFrom('accounts').selectAll().where('id','=','acct').executeTakeFirstOrThrow();
      expect(account.status).toBe('active');
      expect(BigInt(account.security_epoch)).toBe(0n);
      expect(account.email).toBe('atomic@example.test');
      expect((await db.selectFrom('auth_accounts').select('id').execute()).length).toBe(1);
      expect((await db.selectFrom('auth_sessions').select('id').execute()).length).toBe(1);
      expect((await db.selectFrom('auth_verifications').select('id').execute()).length).toBe(1);
    }
    const store = createPostgresAccountDeletionStore(db, {
      collectionPolicyRevisions: (transaction) => createPostgresCollectionPolicyRevisionPort(transaction),
    });
    await store.complete('acct','usr');
    await store.complete('acct','usr');
    const account = await db.selectFrom('accounts').selectAll().where('id','=','acct').executeTakeFirstOrThrow();
    expect(account.status).toBe('deleted'); expect(account.email).toBe(null); expect(BigInt(account.security_epoch)).toBe(1n);
    for (const table of ['auth_users','auth_accounts','auth_sessions','auth_verifications'] as const) {
      expect((await db.selectFrom(table).select('id').execute()).length).toBe(0);
    }
  } finally { await isolated.close(); }
},120000);

test('account deletion advances owned publication policy revisions, rotates public caches and ends publication', async () => {
  const isolated = await createIsolatedPostgresRuntime('account_deletion_publication');
  try {
    const { db, pool } = isolated.runtime;
    await runMigrations(db, 'latest');
    await pool.query("insert into accounts(id,subject_id,status,email) values ('acct','owner-subject','active','pub@example.test')");
    await pool.query(`insert into auth_users(id,name,email,"emailVerified") values ('usr','Owner','pub@example.test',true)`);
    await pool.query("insert into auth_user_account_map(auth_user_id,account_id) values ('usr','acct')");
    // collections_root_fk is DEFERRABLE INITIALLY DEFERRED: seed the owned
    // collections and their roots in one transaction.
    await db.transaction().execute(async (transaction) => {
      await sql`insert into resource_id_ledger(resource_id, resource_type)
        values ('pub-col','collection'), ('pub-root','node'), ('private-col','collection'), ('private-root','node')`.execute(transaction);
      await sql`insert into collections
          (id, owner_subject_id, title, kind, visibility, root_node_id, resource_revision,
           content_revision, policy_revision, publication_slug, published_at)
        values ('pub-col','owner-subject','Published','bookmarks','public','pub-root','r1','c1','p1','published-slug','2026-07-01T00:00:00Z'),
               ('private-col','owner-subject','Private','bookmarks','private','private-root','r1','c1','p1',null,null)`.execute(transaction);
      await sql`insert into nodes (id, collection_id, kind, is_root, title, visibility, resource_revision, children_revision)
        values ('pub-root','pub-col','folder',true,'Published','inherit','r1','ch1'),
               ('private-root','private-col','folder',true,'Private','inherit','r1','ch1')`.execute(transaction);
    });
    const metadataReads = createPostgresPublicationMetadataReadPort(isolated.runtime);
    expect((await metadataReads.load({ publicationSlug: 'published-slug' }))?.id).toBe('pub-col');
    expect(await metadataReads.isPublicCacheCurrent('pub-col', 'c1.p1')).toBe(true);

    const rotated: string[] = [];
    const store = createPostgresAccountDeletionStore(db, {
      collectionPolicyRevisions: (transaction) => createPostgresCollectionPolicyRevisionPort(transaction),
      publicationCacheInvalidator: {
        async rotateCollection(scope) { rotated.push(`collection:${scope.collectionId}:${scope.publicationSlug}`); },
        async rotateDirectory() { rotated.push('directory'); },
      },
    });
    await store.complete('acct', 'usr');

    const collections = await db.selectFrom('collections').select(['id', 'policy_revision']).orderBy('id').execute();
    expect(collections.map((row) => row.id)).toEqual(['private-col', 'pub-col']);
    for (const row of collections) expect(row.policy_revision).not.toBe('p1');
    expect((await db.selectFrom('policy_revisions').select('collection_id').execute()).length).toBe(2);
    // Only the published collection owns a public cache; the directory epoch rotates once.
    expect(rotated).toEqual(['collection:pub-col:published-slug', 'directory']);
    // The owner lifecycle fence ends publication without touching the collection row.
    expect(await metadataReads.load({ publicationSlug: 'published-slug' })).toBe(null);
    expect(await metadataReads.isPublicCacheCurrent('pub-col', 'c1.p1')).toBe(false);
  } finally { await isolated.close(); }
}, 120000);

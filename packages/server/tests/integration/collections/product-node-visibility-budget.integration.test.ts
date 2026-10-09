import assert from 'node:assert/strict';
import { afterAll, beforeAll, beforeEach, test } from 'vitest';
import { buildProductNodeVisibilitySql } from '../../../src/infrastructure/database/product-node-visibility-sql.js';
import { createIsolatedPostgresRuntime, describeWithPostgres, type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';

describeWithPostgres('bounded Product ancestry visibility', () => {
  let isolated: IsolatedPostgresRuntime;
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('product_visibility_budget');
    await isolated.runtime.pool.query(`create table collections(id text primary key, visibility text);
      create table nodes(id text primary key, collection_id text, parent_id text, visibility text, deleted_at timestamptz);
      insert into collections values ('collection', 'public')`);
  });
  afterAll(async () => isolated?.close());
  beforeEach(async () => { await isolated.runtime.pool.query('truncate nodes'); });

  async function visibility() {
    const result = await isolated.runtime.pool.query<{ visibility: string }>(
      `select ${buildProductNodeVisibilitySql('n', 'c')} as visibility
       from nodes n join collections c on c.id=n.collection_id where n.id='target'`);
    return result.rows[0]?.visibility;
  }

  test('live inherited chains retain collection visibility and ancestor restrictions', async () => {
    await isolated.runtime.pool.query(`insert into nodes values
      ('target','collection','parent','inherit',null), ('parent','collection',null,'inherit',null)`);
    assert.equal(await visibility(), 'public');
    await isolated.runtime.pool.query("update nodes set visibility='protected' where id='parent'");
    assert.equal(await visibility(), 'protected');
    await isolated.runtime.pool.query("update nodes set visibility='private' where id='parent'");
    assert.equal(await visibility(), 'private');
  });

  test('cyclic, dangling and deleted ancestry all fail closed', async () => {
    await isolated.runtime.pool.query("insert into nodes values ('target','collection','missing','inherit',null)");
    assert.equal(await visibility(), 'private');
    await isolated.runtime.pool.query("update nodes set parent_id='target' where id='target'");
    assert.equal(await visibility(), 'private');
    await isolated.runtime.pool.query("update nodes set parent_id=null,deleted_at=now() where id='target'");
    assert.equal(await visibility(), 'private');
  });

  test('depth overflow is denied while a complete chain within the limit stays public', async () => {
    await isolated.runtime.pool.query(`insert into nodes
      select 'parent-'||i,'collection',case when i=256 then null else 'parent-'||(i+1) end,'inherit',null
      from generate_series(1,256) i;
      insert into nodes values ('target','collection','parent-1','inherit',null)`);
    assert.equal(await visibility(), 'private');
    await isolated.runtime.pool.query("update nodes set parent_id=null where id='parent-255'");
    assert.equal(await visibility(), 'public');
  });
});

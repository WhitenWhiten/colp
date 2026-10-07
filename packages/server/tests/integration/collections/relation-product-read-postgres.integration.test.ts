import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresRelationReadPort } from '../../../src/infrastructure/collections/index.js';
import { createIsolatedPostgresRuntime, describeWithPostgres, type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';

describeWithPostgres('P2B-12 Relation Product PostgreSQL paging and plans', () => {
  let isolated: IsolatedPostgresRuntime;
  beforeAll(async () => { isolated = await createIsolatedPostgresRuntime('phase2b_relation_product_read');
    await runMigrations(isolated.runtime.db, 'latest'); await fixture(); }, 120_000);
  afterAll(async () => isolated?.close());

  test('incoming and outgoing branches page independently using their partial indexes without Seq Scan or Sort', async () => {
    await isolated.runtime.pool.query('set enable_seqscan=off');
    for (const [column, index] of [['from_node_id', 'relations_product_live_from_idx'],
      ['to_node_id', 'relations_product_live_to_idx']] as const) {
      const plan = await isolated.runtime.pool.query<{ 'QUERY PLAN': string }>(`explain (analyze, buffers, format text)
        select * from relations where collection_id=$1 and ${column}=$2 and deleted_at is null
        order by updated_at desc, id collate "C" asc limit 51`, ['read-collection', 'focus-node']);
      const text = plan.rows.map((row) => row['QUERY PLAN']).join('\n');
      assert.match(text, new RegExp(index)); assert.doesNotMatch(text, /Seq Scan on relations/u);
      assert.doesNotMatch(text, /^\s*Sort\s/mu);
    }
  });

  test('port traverses a large mixed endpoint set with stable tie breaking and no duplicates', async () => {
    const port = createPostgresRelationReadPort(isolated.runtime.db as never);
    for (const direction of ['incoming', 'outgoing'] as const) {
      const seen: string[] = []; let after: { updatedAt: string; id: string } | undefined;
      do {
        const rows = await port.listLiveByNode({ collectionId: 'read-collection', nodeId: 'focus-node', direction,
          types: [], visibilities: [], endpointVisibilities: ['private', 'protected', 'unlisted', 'public'],
          limit: 37, ...(after ? { after } : {}) });
        const page = rows.slice(0, 37); seen.push(...page.map((row) => row.id));
        const last = page.at(-1); after = rows.length > 37 && last
          ? { updatedAt: last.updatedAt.toISOString().replace('.000Z', 'Z'), id: last.id } : undefined;
      } while (after);
      assert.equal(seen.length, 250); assert.equal(new Set(seen).size, 250);
      assert.deepEqual(seen, [...seen].sort((a, b) => {
        const ai = Number(a.split('-').at(-1)); const bi = Number(b.split('-').at(-1));
        const at = Math.floor(ai / 5); const bt = Math.floor(bi / 5);
        return at - bt || a.localeCompare(b, 'en');
      }));
    }
  });

  async function fixture() {
    const pool = isolated.runtime.pool; const now = new Date('2026-07-25T12:00:00.000Z');
    const client = await pool.connect();
    try {
    await client.query('begin');
    await client.query('set constraints all deferred');
    await client.query(`insert into resource_id_ledger(resource_id,resource_type,committed_at)
      values ('read-collection','collection',now()),('focus-node','node',now())`);
    await client.query(`insert into collections(id,owner_subject_id,title,kind,visibility,root_node_id,root_node_is_root,
      resource_revision,content_revision,policy_revision,commit_ordinal,created_at,updated_at,payload_json,payload_schema_version,payload_authority_status)
      values ('read-collection','owner','Read','mixed','private','focus-node',true,'r','c','p',1,$1,$1,
      '{"id":"read-collection"}',1,'backfilled')`, [now]);
    await client.query(`insert into nodes(id,collection_id,parent_id,kind,is_root,title,visibility,resource_revision,
      children_revision,created_at,updated_at,payload_json,payload_schema_version,payload_authority_status)
      values ('focus-node','read-collection',null,'folder',true,'Focus','inherit','r','c',$1,$1,
      '{"id":"focus-node"}',1,'backfilled')`, [now]);
    for (let index = 0; index < 250; index += 1) {
      for (const direction of ['incoming', 'outgoing'] as const) {
        const endpoint = `${direction}-node-${String(index).padStart(3, '0')}`;
        const id = `${direction}-relation-${String(index).padStart(3, '0')}`;
        await client.query(`insert into resource_id_ledger(resource_id,resource_type,committed_at)
          values ($1,'node',now()),($2,'relation',now())`, [endpoint, id]);
        await client.query(`insert into nodes(id,collection_id,parent_id,position_token,kind,is_root,title,visibility,resource_revision,
          children_revision,created_at,updated_at,payload_json,payload_schema_version,payload_authority_status)
          values ($1,'read-collection','focus-node',$2,'folder',false,$1,'inherit','r','c',$3,$3,$4,1,'backfilled')`,
        [endpoint, `position-${direction}-${String(index).padStart(3, '0')}`, now, { id: endpoint }]);
        const updated = new Date(now.getTime() - Math.floor(index / 5) * 1000);
        const from = direction === 'outgoing' ? 'focus-node' : endpoint;
        const to = direction === 'incoming' ? 'focus-node' : endpoint;
        const canonicalUpdated = updated.toISOString().replace('.000Z', 'Z');
        const payload = { id, collectionId: 'read-collection', fromNodeId: from, toNodeId: to, type: 'related',
          visibility: 'protected', revision: `revision-${id}`, createdAt: canonicalUpdated,
          updatedAt: canonicalUpdated, extensions: {} };
        await client.query(`insert into relations(id,collection_id,from_node_id,to_node_id,type,label,visibility,
          resource_revision,created_at,updated_at,payload_json) values ($1,'read-collection',$2,$3,'related',null,
          'protected',$4,$5,$5,$6)`, [id, from, to, `revision-${id}`, updated, payload]);
      }
    }
    await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
});

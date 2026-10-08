import assert from 'node:assert/strict';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { runMigrations, type DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import { createPostgresNodeWritePort } from '../../../src/infrastructure/collections/repositories.js';
import { classifyParentAncestry } from '../../../src/modules/collections/application/ancestry-validation.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const COLLECTION = 'parent-ancestry-collection';
const ROOT = 'parent-ancestry-root';

/** R12 integration evidence: the real PostgreSQL recursive CTE, not a test mirror. */
describeWithPostgres('R12 PostgreSQL parent ancestry recursive CTE', () => {
  let isolated: IsolatedPostgresRuntime;
  let runtime: DatabaseRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('parent_ancestry_cte', { maxConnections: 12 });
    runtime = isolated.runtime;
    await runMigrations(runtime.db, 'latest');
    await runtime.pool.query(`
      insert into accounts(id, subject_id, status, security_epoch)
      values ('parent-ancestry-owner', 'parent-ancestry-owner', 'active', 0)
    `);
    await runtime.pool.query(`
      insert into profiles(account_id, display_name, avatar_url)
      values ('parent-ancestry-owner', 'Ancestry owner', null)
    `);
    await runtime.pool.query(`
      insert into resource_id_ledger(resource_id, resource_type)
      values ($1, 'collection'), ($2, 'node')
    `, [COLLECTION, ROOT]);
    await runtime.pool.query('begin');
    await runtime.pool.query('set constraints all deferred');
    await runtime.pool.query(`
      insert into collections (id, owner_subject_id, title, kind, visibility, root_node_id,
        resource_revision, content_revision, policy_revision, commit_ordinal)
      values ($1, 'parent-ancestry-owner', 'ancestry', 'bookmarks', 'private', $2,
        'collection-r1', 'content-r1', 'policy-r1', 1)
    `, [COLLECTION, ROOT]);
    await runtime.pool.query(`
      insert into nodes
        (id, collection_id, parent_id, kind, is_root, title, visibility, resource_revision, children_revision)
      values ($1, $2, null, 'folder', true, 'root', 'inherit', 'root-r1', 'root-c1')
    `, [ROOT, COLLECTION]);
    await runtime.pool.query('commit');
  });

  afterAll(async () => isolated?.close());

  async function reset(): Promise<void> {
    await runtime.pool.query('delete from nodes where collection_id = $1 and id <> $2', [COLLECTION, ROOT]);
  }

  async function chain(depth: number, prefix = `chain-${depth}`): Promise<string> {
    let parent = ROOT;
    const rows: unknown[][] = [];
    for (let i = 1; i <= depth; i += 1) {
      const id = `${prefix}-${i}`;
      rows.push([id, COLLECTION, parent, `folder ${i}`, `r-${prefix}-${i}`, `c-${prefix}-${i}`]);
      parent = id;
    }
    await runtime.pool.query(
      `insert into resource_id_ledger(resource_id, resource_type)
       select id, 'node' from unnest($1::text[]) as ids(id)
       on conflict (resource_id) do nothing`,
      [rows.map(([id]) => id)],
    );
    await runtime.pool.query('begin');
    await runtime.pool.query('set constraints all deferred');
    try {
      for (const [id, _collectionId, parentId, title, resourceRevision, childrenRevision] of rows) {
        await runtime.pool.query(`insert into nodes
          (id, collection_id, parent_id, kind, is_root, title, visibility, position_token, resource_revision, children_revision)
          values ($1, $2, $3, 'folder', false, $4, 'inherit', $1, $5, $6)
        `, [id, COLLECTION, parentId, title, resourceRevision, childrenRevision]);
      }
      await runtime.pool.query('commit');
    } catch (error) {
      await runtime.pool.query('rollback');
      throw error;
    }
    return parent;
  }

  async function ancestry(parentId: string, maxDepth = 256) {
    return runtime.db.transaction().execute(async (tx) => createPostgresNodeWritePort(tx).readParentAncestry!(COLLECTION, parentId, maxDepth));
  }

  test.each([255, 256])('depth %i reaches root and is valid', async (depth) => {
    await reset();
    const leaf = await chain(depth);
    const rows = await ancestry(leaf, 256);
    assert.equal(rows.length, depth + 1);
    assert.equal(rows.at(-1)?.id, ROOT);
    assert.equal(rows.at(-1)?.isRoot, true);
    assert.deepEqual(classifyParentAncestry(rows.map((row, i) => ({ ...row, depth: i })), COLLECTION, 'not-in-chain', leaf, true), { ok: true });
  });

  test('depth 257 fails closed with depth code, not truncation', async () => {
    await reset();
    const leaf = await chain(257);
    const rows = await ancestry(leaf, 256);
    assert.equal(rows.length, 257);
    assert.notEqual(rows.at(-1)?.id, ROOT);
    assert.deepEqual(classifyParentAncestry(rows.map((row, i) => ({ ...row, depth: i })), COLLECTION, 'not-in-chain', leaf, true), { ok: false, code: 'depth' });
  });

  test.each([
    ['deleted', { deletedAt: new Date() }],
    ['non-folder', { kind: 'bookmark', url: 'https://example.test/invalid' }],
    ['foreign collection', { collectionId: 'other-collection' }],
  ])('%s ancestor is invalid and has no writes', async (_label, patch) => {
    await reset();
    const parent = await chain(2, `invalid-${_label.replaceAll(' ', '-')}`);
    if (_label === 'foreign collection') {
      const foreignRoot = `foreign-root-${Date.now()}`;
      await runtime.pool.query("insert into resource_id_ledger(resource_id, resource_type) values ('other-collection', 'collection'), ($1, 'node')", [foreignRoot]);
      await runtime.pool.query('begin');
      await runtime.pool.query('set constraints all deferred');
      try {
        await runtime.pool.query(`insert into collections (id, owner_subject_id, title, kind, visibility, root_node_id, resource_revision, content_revision, policy_revision, commit_ordinal)
          values ('other-collection', 'parent-ancestry-owner', 'other', 'bookmarks', 'private', $1, 'other-r1', 'other-c1', 'other-p1', 1)`, [foreignRoot]);
        await runtime.pool.query(`insert into nodes (id, collection_id, parent_id, kind, is_root, title, visibility, resource_revision, children_revision)
          values ($1, 'other-collection', null, 'folder', true, 'other root', 'inherit', 'other-r1', 'other-c1')`, [foreignRoot]);
        await runtime.pool.query('commit');
      } catch (error) {
        await runtime.pool.query('rollback');
        throw error;
      }
      const before = (await runtime.pool.query('select count(*)::int as count from operations')).rows[0].count;
      const rows = await ancestry(foreignRoot);
      const result = classifyParentAncestry(rows.map((row, i) => ({ ...row, depth: i })), COLLECTION, 'not-in-chain', foreignRoot, true);
      assert.deepEqual(result, { ok: false, code: 'invalid' });
      const after = (await runtime.pool.query('select count(*)::int as count from operations')).rows[0].count;
      assert.equal(after, before);
      return;
    }
    await runtime.pool.query('update nodes set deleted_at = coalesce($2, deleted_at), kind = coalesce($3, kind), url = coalesce($4, url) where id = $1', [parent, patch.deletedAt ?? null, patch.kind ?? null, patch.url ?? null]);
    const before = (await runtime.pool.query('select count(*)::int as count from operations')).rows[0].count;
    const rows = await ancestry(parent);
    const result = classifyParentAncestry(rows.map((row, i) => ({ ...row, depth: i })), COLLECTION, 'not-in-chain', parent, true);
    assert.deepEqual(result, { ok: false, code: 'invalid' });
    const after = (await runtime.pool.query('select count(*)::int as count from operations')).rows[0].count;
    assert.equal(after, before);
  });

  test('pre-existing cycle is cycle-specific, distinct from depth truncation', async () => {
    await reset();
    const a = await chain(2, 'cycle');
    const b = 'cycle-2';
    await runtime.pool.query('update nodes set parent_id = $2 where id = $1', [b, a]);
    const rows = await ancestry(a);
    assert.deepEqual(classifyParentAncestry(rows.map((row, i) => ({ ...row, depth: i })), COLLECTION, 'not-in-chain', a, true), { ok: false, code: 'cycle' });
    assert.notDeepEqual(classifyParentAncestry(rows.map((row, i) => ({ ...row, depth: i })), COLLECTION, 'not-in-chain', a, true), { ok: false, code: 'depth' });
  });

  test('self-parent and descendant target produce target/cycle classifications', async () => {
    await reset();
    const leaf = await chain(2, 'descendant'); // root -> descendant-1 -> descendant-2 (leaf)
    const rows = await ancestry(leaf);
    const depthRows = rows.map((row, i) => ({ ...row, depth: i }));
    // Self-parent: the moving node is the seed parent itself.
    assert.deepEqual(classifyParentAncestry(depthRows, COLLECTION, leaf, leaf, true), { ok: false, code: 'target' });
    // Move-to-descendant: an ancestor of the seed parent is the moving node.
    assert.deepEqual(classifyParentAncestry(depthRows, COLLECTION, 'descendant-1', leaf, true), { ok: false, code: 'target' });
    // Missing parent row fails closed as invalid, not a cycle.
    assert.deepEqual(classifyParentAncestry([], COLLECTION, leaf, leaf, true), { ok: false, code: 'invalid' });
  });

  test('parent/cycle validation statement count is constant shallow versus depth 200', async () => {
    await reset();
    const shallow = await chain(2, 'count-shallow');
    const deep = await chain(200, 'count-deep');
    const capture = async (id: string) => {
      const base = runtime.db.getExecutor();
      const sqls: string[] = [];
      const db = runtime.db.withPlugin({ transformQuery(args) { sqls.push(base.compileQuery(args.node, args.queryId).sql); return args.node; }, async transformResult(args) { return args.result; } });
      await db.transaction().execute(async (tx) => createPostgresNodeWritePort(tx).readParentAncestry!(COLLECTION, id, 256));
      return sqls.filter((query) => query.toLowerCase().includes('with recursive ancestry')).length;
    };
    const shallowCount = await capture(shallow);
    const deepCount = await capture(deep);
    assert.equal(shallowCount, 1);
    assert.equal(deepCount, 1);
    assert.equal(shallowCount, deepCount);
  });

  test('concurrent parent moves with an explicit barrier keep the tree acyclic and root-reached', async () => {
    await reset();
    const a = await chain(1, 'race-a');
    const b = await chain(1, 'race-b');
    const c = await chain(1, 'race-c');
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const arrive = async () => { arrived += 1; if (arrived === 2) release(); await gate; };

    // Each transaction runs the R12 pipeline (set-based ancestry read, classifier,
    // parent move). The barrier fixes the interleaving: both transactions must
    // reach the validation point before either commits its move.
    const moveThroughPipeline = async (id: string, newParent: string) => {
      await runtime.db.transaction().execute(async (tx) => {
        const nodePort = createPostgresNodeWritePort(tx);
        await arrive();
        const rows = await nodePort.readParentAncestry!(COLLECTION, newParent, 256);
        const result = classifyParentAncestry(
          rows.map((row, i) => ({ ...row, depth: i })),
          COLLECTION, id, newParent, true,
        );
        assert.deepEqual(result, { ok: true });
        await nodePort.updateParentAndPosition(COLLECTION, id, {
          parentId: newParent,
          positionToken: `${id}-moved`,
          resourceRevision: `${id}-r2`,
          updatedAt: new Date(),
        });
      });
    };
    await Promise.all([moveThroughPipeline(b, a), moveThroughPipeline(c, a)]);

    const state = await runtime.pool.query(
      `select id, parent_id from nodes where id = any($1::text[]) order by id`,
      [[a, b, c]],
    );
    assert.deepEqual(state.rows.map((row) => ({ id: row.id, parent: row.parent_id })), [
      { id: a, parent: ROOT },
      { id: b, parent: a },
      { id: c, parent: a },
    ]);
    // The moved subtree still reaches root and validates after both commits.
    const rows = await ancestry(c, 256);
    assert.equal(rows.at(-1)?.id, ROOT);
    assert.deepEqual(classifyParentAncestry(
      rows.map((row, i) => ({ ...row, depth: i })),
      COLLECTION, 'new-child', c, true,
    ), { ok: true });
  });
});

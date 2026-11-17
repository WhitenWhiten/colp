import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { withAbortablePostgresClient, withPostgresAbort } from '../../../src/infrastructure/database/query-abort.js';
import { createPostgresPublicationMetadataReadPort } from '../../../src/infrastructure/publication/index.js';

describe('withPostgresAbort background settle (A5-4)', () => {
  test('returns the signal reason without awaiting the statement when cancel reports false', async () => {
    const controller = new AbortController();
    const reason = new Error('client disconnected');
    let cancelCalls = 0;
    // A statement that never settles: awaiting it would hold the request
    // until statement_timeout, which is exactly the contract being removed.
    const statement = new Promise<string>(() => {});
    const work = withPostgresAbort(statement, controller.signal, async () => {
      cancelCalls += 1;
      return false; // pg_cancel_backend could not cancel the backend.
    });
    controller.abort(reason);
    await assert.rejects(work, /client disconnected/u);
    assert.equal(cancelCalls, 1);
  });

  test('observes a late rejection from the abandoned statement', async () => {
    const controller = new AbortController();
    const reason = new Error('deadline exceeded');
    let rejectStatement!: (error: unknown) => void;
    const statement = new Promise<string>((_resolve, reject) => {
      rejectStatement = reject;
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => { unhandled.push(error); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const work = withPostgresAbort(statement, controller.signal, async () => false);
      controller.abort(reason);
      await assert.rejects(work, /deadline exceeded/u);
      rejectStatement(new Error('canceling statement due to user request (57014)'));
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.deepEqual(unhandled, [], 'the abandoned statement rejection must stay observed');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('a statement that settles before abort keeps its result and never cancels', async () => {
    const controller = new AbortController();
    let cancelled = false;
    const value = await withPostgresAbort(
      Promise.resolve({ rows: [] }),
      controller.signal,
      async () => { cancelled = true; },
    );
    assert.deepEqual(value, { rows: [] });
    assert.equal(cancelled, false);
  });

  test('a pre-aborted signal rejects with its reason without invoking cancel', async () => {
    const controller = new AbortController();
    const reason = new Error('already aborted');
    controller.abort(reason);
    let cancelled = false;
    await assert.rejects(
      withPostgresAbort(new Promise<string>(() => {}), controller.signal, async () => {
        cancelled = true;
      }),
      /already aborted/u,
    );
    assert.equal(cancelled, false);
  });

  test('without a signal the statement runs untouched', async () => {
    let cancelled = false;
    const value = await withPostgresAbort(Promise.resolve('ok'), undefined, async () => {
      cancelled = true;
    });
    assert.equal(value, 'ok');
    assert.equal(cancelled, false);
  });

  test('reports the abandoned statement to the checkout owner', async () => {
    const controller = new AbortController();
    let abandoned = 0;
    const work = withPostgresAbort(new Promise<string>(() => {}), controller.signal, async () => false,
      () => { abandoned += 1; });
    controller.abort(new Error('client disconnected'));
    await assert.rejects(work, /client disconnected/u);
    assert.equal(abandoned, 1);
  });

  test('a signal aborted before the race starts still reports the started statement', async () => {
    // The caller starts the operation before handing it to the helper, so an
    // abort that lands in between must not be mistaken for "nothing happened":
    // the checkout owner has to destroy a connection that may be busy.
    const controller = new AbortController();
    controller.abort(new Error('deadline exceeded'));
    let abandoned = 0;
    await assert.rejects(
      withPostgresAbort(new Promise<string>(() => {}), controller.signal, async () => false,
        () => { abandoned += 1; }),
      /deadline exceeded/u,
    );
    assert.equal(abandoned, 1);
  });

  test('never reports a completed statement as abandoned', async () => {
    const controller = new AbortController();
    let abandoned = 0;
    const value = await withPostgresAbort(Promise.resolve('done'), controller.signal, async () => false,
      () => { abandoned += 1; });
    assert.equal(value, 'done');
    assert.equal(abandoned, 0);
  });
});

/**
 * Pool-ownership regression (P2): an aborted statement is abandoned, so the
 * checkout must be destroyed instead of released to the shared pool. Releasing
 * it would hand the still-busy backend to the next borrower, whose statements
 * would queue behind the abandoned one until the backend observes the cancel
 * (the reproduction: a `max=1` pool blocking the next checkout for ~3s).
 */
describe('abortable checkout pool ownership', () => {
  function fakeRuntime(
    statement: () => Promise<{ rows: readonly unknown[] }>,
    cancelBackend: () => Promise<boolean>,
  ) {
    const releases: Array<boolean | undefined> = [];
    let signalStatementStarted!: () => void;
    const statementStarted = new Promise<void>((resolve) => { signalStatementStarted = resolve; });
    const client = {
      async query(text: string) {
        if (text.includes('pg_backend_pid')) return { rows: [{ pid: 4242 }] };
        signalStatementStarted();
        return statement();
      },
      release(error?: boolean) { releases.push(error); },
    };
    return {
      releases,
      statementStarted,
      runtime: {
        pool: { connect: async () => client },
        cancelBackend,
      } as unknown as Parameters<typeof createPostgresPublicationMetadataReadPort>[0],
    };
  }

  test('a failed cancel destroys the checkout instead of returning a busy connection', async () => {
    const { runtime, releases, statementStarted } = fakeRuntime(
      () => new Promise<{ rows: readonly unknown[] }>(() => {}),
      async () => false,
    );
    const controller = new AbortController();
    const load = createPostgresPublicationMetadataReadPort(runtime)
      .load({ collectionId: 'c', actorSubjectId: 'member', signal: controller.signal });
    await statementStarted;
    controller.abort(new Error('client disconnected'));
    await assert.rejects(load, /client disconnected/u);
    assert.deepEqual(releases, [true],
      'pg-pool release(true) destroys the connection; release() would pool a busy client');
  });

  test('a completed statement returns its checkout to the pool', async () => {
    const row = {
      id: 'c', owner_subject_id: 'owner', kind: 'bookmarks', title: 'C', summary: null,
      visibility: 'public', publication_slug: 'c', root_node_id: 'r', content_revision: 'c1',
      policy_revision: 'p1', root_available: true, tags: [], language: null, membership_role: 'owner',
      created_at: new Date('2026-07-24T00:00:00Z'), updated_at: new Date('2026-07-24T00:00:00Z'),
      deleted_at: null,
    };
    const { runtime, releases } = fakeRuntime(async () => ({ rows: [row] }), async () => true);
    const loaded = await createPostgresPublicationMetadataReadPort(runtime)
      .load({ collectionId: 'c', actorSubjectId: 'member', signal: new AbortController().signal });
    assert.equal(loaded?.id, 'c');
    assert.deepEqual(releases, [false]);
  });

  test('an abort while awaiting pool.connect() destroys the checkout before any statement', async () => {
    // Regression for the pre-aborted checkout: the signal can fire while
    // `pool.connect()` is pending. Starting the PID probe after that would
    // leave a busy statement on a client that a plain `release()` returns to
    // the pool (reproduced with a fake pool: probe issued, release(false)).
    const controller = new AbortController();
    const reason = new Error('client disconnected');
    const statements: string[] = [];
    const releases: Array<boolean | undefined> = [];
    const client = {
      async query(text: string) {
        statements.push(text);
        return { rows: [{ pid: 4242 }] };
      },
      release(error?: boolean) { releases.push(error); },
    };
    let resolveConnect!: (connected: typeof client) => void;
    const pool = {
      connect: () => new Promise<typeof client>((resolve) => { resolveConnect = resolve; }),
    };
    let workReached = false;
    const work = withAbortablePostgresClient(pool, controller.signal, async () => false, async () => {
      workReached = true;
      return 'unreachable';
    });
    controller.abort(reason);
    resolveConnect(client);
    await assert.rejects(work, /client disconnected/u);
    assert.equal(workReached, false);
    assert.deepEqual(statements, [],
      'no statement may be issued on a checkout whose request already aborted');
    assert.deepEqual(releases, [true],
      'an aborted checkout is destroyed; release() would pool a half-owned connection');
  });
});

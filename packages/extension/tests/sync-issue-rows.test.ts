import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { describeSyncAttention } from '../src/sync-attention-view.js';
import { issueSummaryCopy, mergeResolutionFailureCopy } from '../src/sync-issue-copy.js';
import { SYNC_ISSUE_ROW_LIMIT, syncIssueRows } from '../src/sync-issue-rows.js';
import { reportCode, replicaIssuesFromPull, replicaIssuesFromQueue, type ReplicaHealthIssue } from '../src/sync-issue-snapshot.js';
import { withResolvedTitles } from '../src/sync-issue-titles.js';
import { handleSyncAttentionRequest } from '../src/sw/sync-attention.js';
import type { SyncIssueDiagnostic } from '../src/types.js';
import type { QueueOperation, SyncScope } from '../src/sync-state-store.js';

/** C-03: an item is a row (its name, why, what next), not "Title: raw_code" in one paragraph. */
const issue = (overrides: Partial<SyncIssueDiagnostic>): SyncIssueDiagnostic => ({ direction: 'push', code: 'set_aside', count: 1, ...overrides });

describe('item rows (C-03)', () => {
  test('each item is its own row with a name, a sentence in the Sync center vocabulary and the direction', () => {
    const { rows, more } = syncIssueRows([
      issue({ code: 'create_placement_unproven', title: 'Recipes', issueId: 'a', count: 3, firstSeenAt: '2026-10-24T09:12:00.000Z' }),
      issue({ code: 'managed_not_writable', direction: 'pull', title: 'Work links', issueId: 'b' }),
      issue({ code: 'invalid_node_constraints', title: 'Bank', issueId: 'c' }),
    ]);
    assert.equal(more, 0);
    assert.deepEqual(rows.map(row => [row.title, row.directionLabel, row.summary]), [
      ['Recipes', 'Upload', "Its place in the folder couldn't be confirmed"],
      ['Work links', 'Download', 'This bookmark is managed by the browser and cannot be changed here'],
      ['Bank', 'Upload', "The server didn't accept this change"],
    ]);
    assert.match(rows[0]!.seen ?? '', /^Seen 3 times since /u);
    assert.equal(rows[1]!.seen, undefined);
  });

  test('a raw code never stands in for the sentence, and the code stays reachable on the row', () => {
    const { rows } = syncIssueRows([issue({ code: 'some_future_failure', direction: 'local', title: 'X' }),
      issue({ code: 'some_future_failure', direction: 'pull', title: 'Y' }), issue({ code: 'some_future_failure', title: 'Z', actions: ['retry'] })]);
    assert.deepEqual(rows.map(row => row.summary), ["Couldn't be prepared for sync", "Couldn't be applied in this browser",
      "This browser couldn't get it ready to upload"]);
    assert.deepEqual(rows.map(row => row.code), ['some_future_failure', 'some_future_failure', 'some_future_failure']);
  });

  test('an item without a title is named by where it lives, and an epoch first-seen is not shown as 1970', () => {
    const { rows } = syncIssueRows([issue({ code: 'push_deferred', nodeId: 'node-1', firstSeenAt: '1970-01-01T00:00:00.000Z' }),
      issue({ code: 'local_merge_difference', direction: 'local', firstSeenAt: 0 })]);
    assert.deepEqual(rows.map(row => row.title), ['A bookmark in your library', 'A bookmark on this device']);
    assert.deepEqual(rows.map(row => row.seen), [undefined, undefined]);
  });

  test('decisions come before items that clear by themselves, and the list is a window with a count of the rest', () => {
    const many = Array.from({ length: SYNC_ISSUE_ROW_LIMIT + 5 }, (_, index) => issue({ code: index === 0 ? 'dependency_pending' : 'set_aside',
      title: `item ${index}`, issueId: `i${index}`, ...(index === 0 ? { recovery: 'automatic' as const } : {}) }));
    const { rows, more } = syncIssueRows(many);
    assert.equal(rows.length, SYNC_ISSUE_ROW_LIMIT);
    assert.equal(more, 5);
    assert.equal(rows.find(row => row.title === 'item 0'), undefined, 'the automatic one waits behind the decisions');
  });

  test('the recovery card keeps its count sentence and no longer concatenates "Title: code"', () => {
    const view = describeSyncAttention({ issueCount: 3, issues: [
      issue({ code: 'create_placement_unproven', title: 'My bookmark' }), issue({ code: 'set_aside', title: 'Docs' }),
      issue({ code: 'parent_set_aside', direction: 'pull', title: 'Folder' })] });
    assert.equal(view.recovery.copy, '3 items need attention.');
    assert.doesNotMatch(view.recovery.copy, /create_placement_unproven|My bookmark/u);
    assert.equal(view.issues.show, true);
    assert.equal(view.issues.rows.length, 3);
  });

  test('a recorded engine error and the items are both told', () => {
    const view = describeSyncAttention({ issueCount: 1, issues: [issue({ title: 'Docs' })], lastError: 'push_network_failed', retryAutomatic: true });
    assert.match(view.recovery.copy, /can't reach the server/u);
    assert.match(view.recovery.copy, /1 item needs attention\./u);
  });

  test('every item sentence in the vocabulary is real text', () => {
    for (const code of ['remote_delete_confirmation_required', 'conflict_hold', 'dependency_hold', 'parent_set_aside', 'delete_subtree_changed',
      'sequence_blocked', 'push_deferred', 'sequence_gap', 'push_stalled', 'native_result_unknown']) {
      assert.ok(issueSummaryCopy({ code, direction: 'push' }).length > 20, code);
    }
    assert.match(issueSummaryCopy({ code: 'apply_failed:bookmark_api_error', direction: 'pull' }), /refused to apply this change/u);
  });

  test('a merge upload the server refused reads as a sentence, then the code', () => {
    assert.equal(mergeResolutionFailureCopy('invalid_node_constraints'),
      "That upload did not go through. The server didn't accept this change (invalid_node_constraints)");
  });
});

describe('issue codes in a report (C-17e)', () => {
  test('a code with a detail keeps its words instead of being dropped or poisoning the report', () => {
    assert.equal(reportCode('apply_failed:bookmark_api_error'), 'apply_failed_bookmark_api_error');
    assert.equal(reportCode('mapping_missing:subtree_root'), 'mapping_missing_subtree_root');
    assert.equal(reportCode('Bad Code!'), 'bad_code');
    assert.equal(reportCode('123', 'fallback_code'), 'fallback_code');
    assert.equal(reportCode('a'.repeat(100)).length, 64);
    const [pull] = replicaIssuesFromPull([{ nodeId: 'node-1', code: 'apply_failed:bookmark_api_error', eventId: 'e', count: 1, firstSeenAt: 1, lastSeenAt: 2 }]);
    assert.equal(pull?.code, 'apply_failed_bookmark_api_error');
    const [queued] = replicaIssuesFromQueue([{ scopeKey: 's', sequence: 1, opId: 'op-1', batchId: 'op-1', idempotencyKey: 'op-1', digest: 'd',
      endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: null, operationRevision: 'r', status: 'set_aside',
      retry: { attempt: 0, notBefore: 0 }, recovery: { code: 'apply_failed:x' },
      payload: { type: 'delete_node', targetId: 'node-9', occurredAt: '2026-10-24T10:00:00.000Z', payload: {} } } as QueueOperation]);
    assert.equal(queued?.code, 'apply_failed_x');
  });
});

describe('titles for rows that only name their target (C-03)', () => {
  const scope = { serverId: 's' } as unknown as SyncScope;
  const named = (title: string | undefined) => ({ projection: { content: title === undefined ? undefined : { title } } }) as never;

  test('a delete or move takes the title the mapping remembers; others stay as they were', async () => {
    const asked: string[] = [];
    const out = await withResolvedTitles([
      { issueId: 'a', code: 'set_aside', direction: 'push' as const, nodeId: 'node-1', count: 1, firstSeenAt: 't', lastSeenAt: 't', actions: [] as const },
      { issueId: 'b', code: 'set_aside', direction: 'push' as const, nodeId: 'node-2', count: 1, firstSeenAt: 't', lastSeenAt: 't', actions: [] as const },
      { issueId: 'c', code: 'set_aside', direction: 'push' as const, nodeId: 'node-1', count: 1, firstSeenAt: 't', lastSeenAt: 't', actions: [] as const },
      { issueId: 'd', code: 'set_aside', direction: 'push' as const, title: 'Own title', nodeId: 'node-3', count: 1, firstSeenAt: 't', lastSeenAt: 't', actions: [] as const },
      { issueId: 'e', code: 'set_aside', direction: 'local' as const, count: 1, firstSeenAt: 't', lastSeenAt: 't', actions: [] as const },
    ], scope, async (_scope, id) => { asked.push(id); return id === 'node-1' ? named('  Reading list  ') : undefined; });
    assert.deepEqual(out.map(row => row.title), ['Reading list', undefined, 'Reading list', 'Own title', undefined]);
    assert.deepEqual(asked, ['node-1', 'node-2'], 'one lookup per node, none for titled or node-less rows');
  });

  test('a lookup that throws or has no title leaves the row alone; no lookup port leaves everything alone', async () => {
    const row: ReplicaHealthIssue = { issueId: 'a', code: 'set_aside', direction: 'push', nodeId: 'node-1', count: 1, firstSeenAt: 't', lastSeenAt: 't', actions: [] };
    assert.equal((await withResolvedTitles([row], scope, async () => { throw new Error('closed'); }))[0]?.title, undefined);
    assert.equal((await withResolvedTitles([row], scope, async () => named(undefined)))[0]?.title, undefined);
    assert.equal((await withResolvedTitles([row], scope, undefined))[0]?.title, undefined);
  });

  test('the attention read names a held delete from the mapping, so Status shows the bookmark and not a bare code', async () => {
    const queue: QueueOperation[] = [{ scopeKey: 's', sequence: 4, opId: 'op-del', batchId: 'op-del', idempotencyKey: 'op-del', digest: 'd',
      endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: null, operationRevision: 'r', status: 'set_aside',
      retry: { attempt: 0, notBefore: 0 }, recovery: { code: 'delete_subtree_changed' },
      payload: { type: 'delete_subtree', targetId: 'node-77', occurredAt: '2026-10-24T10:00:00.000Z', payload: {} } } as QueueOperation];
    const store = {
      getScope: async () => ({}), getEngineState: async () => undefined,
      listQueue: async (_scope: SyncScope, status: string) => status === 'set_aside' ? queue : [],
      getMappingByColpId: async (_scope: SyncScope, id: string) => id === 'node-77' ? named('Old drafts') : null,
    };
    const fixedScope = { environment: 'production', serverId: 's', serverOrigin: 'https://known.example', accountId: 'a',
      browserProfileId: 'p', collectionId: 'c', replicaId: 'r', generation: 1 } as SyncScope;
    const open = { bootstrap: [], operationalTotal: 1, queue, pull: [], local: [], replica: [], waits: [], deletes: [],
      roots: new Set<string>(), nativeRoots: new Set<string>(), total: 1 };
    const response = await handleSyncAttentionRequest({ scope: async () => fixedScope, store: store as never, openIssues: open });
    assert.ok(response.ok);
    if (!response.ok) return;
    assert.deepEqual(response.attention.issues?.map(row => [row.code, row.title]), [['delete_subtree_changed', 'Old drafts']]);
    const view = describeSyncAttention({ issueCount: 1, issues: response.attention.issues });
    assert.equal(view.issues.rows[0]!.title, 'Old drafts');
    assert.match(view.issues.rows[0]!.summary, /folder changed elsewhere first/u);
  });
});

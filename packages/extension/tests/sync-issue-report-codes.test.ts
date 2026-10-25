import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { reportCode, snapshotSyncIssues } from '../src/sync-issue-snapshot.js';
import { parseReplicaHealthReport } from '../../server/src/modules/sync/replica-health.js';

/**
 * C-17e: the server rejects a whole health report for one malformed issue code,
 * so no kind of row may put a code on the wire unchecked. Blocked pull pages
 * (the `replica` rows) used to skip the check; a code with a detail kept its
 * words, and one that is nothing but punctuation falls back to a code with words.
 */
const CODE = /^[a-z][a-z0-9_]{0,63}$/u;
const AT = Date.parse('2026-10-24T09:00:00.000Z');
const open = (parts: Record<string, unknown>) => ({ bootstrap: [], queue: [], pull: [], local: [], waits: [], deletes: [], replica: [],
  roots: new Set(), nativeRoots: new Set(), operationalTotal: 0, total: 0, ...parts }) as never;

describe('a code as the report carries it', () => {
  test('keeps a valid code and the words of one with a detail', () => {
    assert.equal(reportCode('pull_page_invalid'), 'pull_page_invalid');
    assert.equal(reportCode('apply_failed:bookmark_api_error'), 'apply_failed_bookmark_api_error');
    assert.equal(reportCode('Pull-Page:Blocked!'), 'pull_page_blocked');
  });

  test('falls back to a code with words when nothing usable is left, and bounds the length', () => {
    assert.equal(reportCode('!!!', 'pull_page_blocked'), 'pull_page_blocked');
    assert.equal(reportCode('', 'pull_page_blocked'), 'pull_page_blocked');
    assert.equal(reportCode('9lives'), 'lives');
    assert.equal(reportCode('x'.repeat(200)).length, 64);
    assert.match(reportCode('x'.repeat(200)), CODE);
  });
});

describe('every kind of issue row leaves with a code the server accepts', () => {
  const malformed = ['Bad Code!!', 'apply_failed:bookmark_api_error', '!!!', '', 'x'.repeat(200), '12345', 'UPPER_CASE'];

  test('a blocked pull page (replica row) with a malformed recovery code', () => {
    const issues = snapshotSyncIssues(open({ replica: malformed.map((code, index) => ({ pageId: `page-${index}`, code, at: AT, nodeIds: [] })) }));
    assert.equal(issues.length, malformed.length);
    for (const issue of issues) assert.match(issue.code, CODE, issue.code);
    assert.equal(issues[0]!.code, 'bad_code');
    assert.equal(issues[2]!.code, 'pull_page_blocked', 'nothing usable: the page-blocked code, not a dropped row');
  });

  test('pull, local and first-run rows too, and the whole report parses', () => {
    const issues = snapshotSyncIssues(open({
      pull: malformed.map((code, index) => ({ nodeId: `node-${index}`, code, count: 1, firstSeenAt: AT, lastSeenAt: AT })),
      local: malformed.map((code, index) => ({ nativeId: `n-${index}`, code, count: 1, firstSeenAt: AT, lastSeenAt: AT })),
      bootstrap: malformed.map((code, index) => ({ issueId: `b-${index}`, code, at: AT })),
      replica: malformed.map((code, index) => ({ pageId: `page-${index}`, code, at: AT, nodeIds: [] })),
    }));
    assert.equal(issues.length, malformed.length * 4);
    for (const issue of issues) assert.match(issue.code, CODE, issue.code);
    const items = issues.slice(0, 50);
    assert.doesNotThrow(() => parseReplicaHealthReport({ replicaId: 'replica-1', revision: 1, state: 'degraded', since: new Date(AT).toISOString(),
      issues: { total: issues.length, items }, actions: [] }));
  });
});

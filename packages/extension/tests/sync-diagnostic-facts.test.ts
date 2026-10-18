import { expect, test } from 'vitest';
import { reasonCode } from '../src/push-error-code.js';
import { SyncStateError } from '../src/sync-state/types.js';
import { openIngressIssue } from '../src/sync-state/open-issue-facts.js';
import { terminalFreezeReport } from '../src/sync-attention-ui.js';

test('structured codes survive descriptions; programming errors remain local', () => {
  expect(reasonCode(new SyncStateError('record_invalid', 'field details'), 'push_local_failed')).toBe('record_invalid');
  expect(reasonCode(new ReferenceError('x is not defined'), 'push_local_failed')).toBe('push_local_failed');
  expect(reasonCode({ code: 'resource_id_unavailable' }, 'fallback')).toBe('resource_id_unavailable');
});
test('persisted ingress facts retain causal evidence in copied diagnostics without engine errors', () => {
  const row = openIngressIssue({ kind: 'ingress', park: { state: 'parked', code: 'dependency_pending',
    at: '2026-10-18T00:00:00Z', attempts: 5, dependencyOpId: 'op-a', dependencyEventId: 'event-a', reason: 'dependency_pending' } },
  { nativeId: 'private-browser-id', eventId: 'event-b', status: 'pending', details: {} } as never)!;
  expect(row).toMatchObject({ dependencyOpId: 'op-a', dependencyEventId: 'event-a', eventId: 'event-b', attempts: 5 });
  const { nativeId: _private, ...safe } = row;
  const copied = terminalFreezeReport({ phase: 'pushing', issues: [{ ...safe, direction: 'local' }] });
  expect(copied).toContain('dependency_pending'); expect(copied).toContain('op-a');
  expect(copied).not.toContain('private-browser-id');
  expect(openIngressIssue({ kind: 'ingress', park: { state: 'parked' } },
    { nativeId: 'old', eventId: 'old-event', status: 'pending', details: {} } as never)).toMatchObject({ firstSeenAt: 0, code: 'ingress_parked' });
});

test('a prolonged authority wait is diagnostic and automatic, independent of flush counts', async () => {
  const { ingressProtectsNode } = await import('../src/sync-state/open-issue-facts.js');
  const { describeSyncAttention } = await import('../src/sync-attention-ui.js');
  const issue = openIngressIssue({ kind: 'ingress', park: { state: 'open', code: 'children_fence_missing',
    at: '2026-10-18T00:06:00Z', attempts: 200 } }, { eventId: 'waiting', nativeId: 'private', status: 'pending',
    occurredAt: '2026-10-18T00:00:00Z', details: {} } as never)!;
  expect(issue.recovery).toBe('automatic'); expect(ingressProtectsNode(issue)).toBe(false);
  const { nativeId: _native, ...safe } = issue;
  const view = describeSyncAttention({ issueCount: 1, issues: [{ ...safe, direction: 'local' }] });
  expect(view.recovery.copy).toContain('automatic recovery'); expect(view.recovery.copy).not.toContain('needs attention');
});

test('separate retained events on the same bookmark have distinct shared diagnostic identities', async () => {
  const { replicaIssuesFromLocal } = await import('../src/sync-issue-snapshot.js');
  const issues = replicaIssuesFromLocal(['first', 'second'].map(eventId => ({ eventId, nativeId: 'same-browser-id',
    code: 'dependency_parked', count: 1, firstSeenAt: 0, lastSeenAt: 1 })));
  expect(new Set(issues.map(issue => issue.issueId)).size).toBe(2);
  expect(JSON.stringify(issues)).not.toContain('same-browser-id');
});

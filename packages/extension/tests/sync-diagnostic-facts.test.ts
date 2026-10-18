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

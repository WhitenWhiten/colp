import { describe, expect, it } from 'vitest';
import { selectOpenAgentItem } from '../../../src/modules/activity/index.js';
describe('agent activity aggregation window', () => {
  const now = new Date('2026-10-23T12:00:00Z');
  const item = (id: string, occurredAt: string, readAt: Date | null = null) => ({ id, occurredAt: new Date(occurredAt), readAt });
  it('selects an unread item within its first-event window', () => {
    expect(selectOpenAgentItem([item('read', '2026-10-23T10:00:00Z', now), item('open', '2026-10-22T12:00:00.001Z')], now)?.id).toBe('open');
  });
  it('starts a new aggregate at exactly 24 hours and rejects future events', () => {
    expect(selectOpenAgentItem([item('old', '2026-10-22T12:00:00Z'), item('future', '2026-10-23T12:00:01Z')], now)).toBeUndefined();
  });
});

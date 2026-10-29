import { describe, expect, it } from 'vitest';
import { activityView, type ActivityLookups, type ActivityRow } from '../../../src/infrastructure/activity/item-views.js';

const at = new Date('2026-10-28T09:00:00.000Z');
const row = (patch: Partial<ActivityRow> = {}): ActivityRow => ({ id: 'activity-1', kind: 'approval_requested', agent_client_id: 'claude',
  collection_id: null, run_id: null, plan_id: 'plan-1', count: 0, revision: '1', occurred_at: at, updated_at: at, read_at: null,
  details_json: {}, sort_updated_at: at.toISOString(), ...patch });
const lookups = (patch: Partial<ActivityLookups> = {}): ActivityLookups => ({ agents: [{ id: 'claude', name: 'Claude', kind: 'oauth_client' }],
  collections: [], members: [], folders: [], runs: [], plans: [{ plan_id: 'plan-1', summary: 'Move Attention from Inbox to Papers' }], ...patch });

describe('approval request activity view', () => {
  it('names the verified agent and the plan by its server-built summary', () => {
    expect(activityView(row(), lookups())).toEqual({ id: 'activity-1', kind: 'approval_requested', state: 'unread', revision: '1',
      occurredAt: at.toISOString(), updatedAt: at.toISOString(), readAt: null, count: 0,
      agent: { clientId: 'claude', name: 'Claude', kind: 'oauth_client' }, collection: null, folders: [], items: [], run: null,
      plan: { id: 'plan-1', summary: 'Move Attention from Inbox to Papers' } });
  });

  it('keeps an unnamed or unknown agent attributed by client id only', () => {
    expect(activityView(row({ agent_client_id: 'unregistered' }), lookups()).agent).toEqual({ clientId: 'unregistered', name: null, kind: 'unknown' });
  });

  it('clips an overlong summary by characters and drops a plan the account cannot read', () => {
    const long = `${'é'.repeat(600)}😀`;
    const summary = activityView(row(), lookups({ plans: [{ plan_id: 'plan-1', summary: long }] })).plan!.summary;
    expect(Array.from(summary)).toHaveLength(512);
    expect(summary.endsWith('…')).toBe(true);
    // The lookup is restricted to the reader's own plans; another account's plan is never shown.
    expect(activityView(row(), lookups({ plans: [] })).plan).toBeNull();
  });

  it('gives every other kind no plan', () => {
    const item = activityView(row({ kind: 'run_attention', plan_id: null, run_id: 'run-1', agent_client_id: null,
      details_json: { status: 'running', attention: 'awaitingApproval' } }), lookups({ runs: [{ id: 'run-1', rule_id: 'rule-1',
      rule_name: 'Docs from MDN', state: 'running', output_count: 0 }] }));
    expect(item).toMatchObject({ plan: null, agent: null, run: { id: 'run-1', ruleName: 'Docs from MDN', attention: 'awaitingApproval' } });
  });
});

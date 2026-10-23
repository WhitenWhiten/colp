import type { ActivityItem } from '../src/automation/activity-types.js';

export const item: ActivityItem = { id: 'activity-1', kind: 'agent_bookmarks_added', state: 'unread', revision: '2',
  occurredAt: '2026-10-23T08:00:00.000Z', updatedAt: '2026-10-23T08:01:00.000Z', readAt: null, count: 7,
  agent: { clientId: 'claude', name: 'Claude', kind: 'oauth_client' }, collection: { id: 'collection-1', title: 'Library' },
  folders: [{ nodeId: 'folder-1', title: 'LLM Papers', count: 7 }], items: [{ nodeId: 'node-1', title: 'A paper', host: 'arxiv.org', occurredAt: '2026-10-23T08:00:00.000Z' }], run: null };

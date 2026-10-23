import { vi } from 'vitest'
import type { ActivityApi } from '../../api/activityClient'
import type { ActivityItem } from '../../api/activityTypes'

export function activityItem(id = 'activity-1', patch: Partial<ActivityItem> = {}): ActivityItem {
  return {
    id, kind: 'agent_bookmarks_added', state: 'unread', revision: '1',
    occurredAt: '2026-10-23T09:00:00Z', updatedAt: '2026-10-23T09:10:00Z', readAt: null, count: 7,
    agent: { clientId: 'claude', name: 'Claude', kind: 'oauth_client' },
    collection: { id: 'personal', title: 'Personal' },
    folders: [{ nodeId: 'llm-papers', title: 'LLM Papers', count: 7 }],
    items: [{ nodeId: 'paper-1', title: 'Attention Is All You Need', host: 'arxiv.org', occurredAt: '2026-10-23T09:10:00Z' }],
    run: null, ...patch,
  }
}

export function fakeActivityApi() {
  return {
    listActivity: vi.fn<ActivityApi['listActivity']>(async () => ({ items: [], nextCursor: null, unreadCount: 0 })),
    getActivitySummary: vi.fn<ActivityApi['getActivitySummary']>(async () => ({ unreadCount: 0, latest: null, revision: '1' })),
    markActivityRead: vi.fn<ActivityApi['markActivityRead']>(async () => ({ readCount: 1, unreadCount: 0 })),
  }
}

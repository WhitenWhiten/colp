export type ActivityKind = 'agent_bookmarks_added' | 'agent_nodes_updated' | 'agent_nodes_moved' | 'agent_nodes_deleted' | 'run_completed' | 'run_partial' | 'run_failed' | 'run_attention'
  | 'approval_requested'

export interface ActivityItem {
  id: string
  kind: ActivityKind
  state: 'unread' | 'read'
  revision: string
  occurredAt: string
  updatedAt: string
  readAt: string | null
  count: number
  agent: { clientId: string; name: string | null; kind: 'oauth_client' | 'api_key' | 'unknown' } | null
  collection: { id: string; title: string | null } | null
  folders: Array<{ nodeId: string; title: string | null; count: number }>
  items: Array<{ nodeId: string; title: string | null; host: string | null; occurredAt: string }>
  run: {
    id: string
    ruleId: string
    ruleName: string | null
    status: string
    outputCount: number
    attention: 'review' | 'awaitingApproval' | null
  } | null
  /** An agent's plan waiting for the owner, by its server-built summary (contract 1.97.0; absent before). */
  plan?: { id: string; summary: string } | null
}

export interface ActivityPage { items: ActivityItem[]; nextCursor: string | null; unreadCount: number }
export interface ActivitySummary { unreadCount: number; latest: ActivityItem | null; revision: string }
export type ActivityReadRequest = { ids: string[] } | { through: string; throughRevision?: string }
export interface ActivityReadResult { readCount: number; unreadCount: number }

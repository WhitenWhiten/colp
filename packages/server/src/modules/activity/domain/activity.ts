export type ActivityKind = 'agent_bookmarks_added' | 'run_completed' | 'run_partial' | 'run_failed' | 'run_attention';
export interface ActivityItem {
  id: string; kind: ActivityKind; state: 'unread' | 'read'; revision: string;
  occurredAt: string; updatedAt: string; readAt: string | null; count: number;
  agent: { clientId: string; name: string | null; kind: 'oauth_client' | 'api_key' | 'unknown' } | null;
  collection: { id: string; title: string | null } | null;
  folders: Array<{ nodeId: string; title: string | null; count: number }>;
  items: Array<{ nodeId: string; title: string | null; host: string | null; occurredAt: string }>;
  run: { id: string; ruleId: string; ruleName: string | null; status: string; outputCount: number;
    attention: 'review' | 'awaitingApproval' | null } | null;
}
export interface ActivityPage { items: ActivityItem[]; nextCursor: string | null; unreadCount: number }
export interface ActivitySummary { unreadCount: number; latest: ActivityItem | null; revision: string }
export type ActivityReadRequest = { ids: string[] } | { through: string; throughRevision?: string };
export interface ActivityReadResult { readCount: number; unreadCount: number }
export interface OpenAgentCandidate { id: string; occurredAt: Date; readAt: Date | null }
/** The first event fixes the window; later arrivals never extend its 24-hour boundary. */
export function selectOpenAgentItem<T extends OpenAgentCandidate>(candidates: readonly T[], now: Date): T | undefined {
  return candidates.find(item => item.readAt === null && item.occurredAt.getTime() > now.getTime() - 86_400_000
    && item.occurredAt.getTime() <= now.getTime());
}

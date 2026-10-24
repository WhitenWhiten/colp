import type { ActivityPage, ActivitySummary, ActivityReadRequest, ActivityReadResult } from '../domain/activity.js';
export interface ActivityReadPort {
  list(accountId: string, query: Record<string, string>): Promise<ActivityPage>;
  summary(accountId: string): Promise<ActivitySummary>;
}
export interface ActivityCommandPort { markRead(accountId: string, request: ActivityReadRequest, commandId: string): Promise<ActivityReadResult> }
export type ActivityPorts = ActivityReadPort & ActivityCommandPort;

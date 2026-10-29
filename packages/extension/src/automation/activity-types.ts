/** The owner-facing activity contract, shared by the summary, badge and Options. */
export type ActivityKind = 'agent_bookmarks_added' | 'run_completed' | 'run_partial' | 'run_failed' | 'run_attention'
  | 'approval_requested';
const KINDS: readonly string[] = ['agent_bookmarks_added', 'run_completed', 'run_partial', 'run_failed', 'run_attention', 'approval_requested'];
export interface ActivityItem {
  readonly id: string;
  readonly kind: ActivityKind;
  readonly state: 'unread' | 'read';
  readonly revision: string;
  readonly occurredAt: string;
  readonly updatedAt: string;
  readonly readAt: string | null;
  readonly count: number;
  readonly agent: { readonly clientId: string; readonly name: string | null; readonly kind: 'oauth_client' | 'api_key' | 'unknown' } | null;
  readonly collection: { readonly id: string; readonly title: string | null } | null;
  readonly folders: readonly { readonly nodeId: string; readonly title: string | null; readonly count: number }[];
  readonly items: readonly { readonly nodeId: string; readonly title: string | null; readonly host: string | null; readonly occurredAt: string }[];
  readonly run: { readonly id: string; readonly ruleId: string; readonly ruleName: string | null; readonly status: string;
    readonly outputCount: number; readonly attention: 'review' | 'awaitingApproval' | null } | null;
  /** An agent's plan waiting for the owner, by its server-built summary. Older servers omit it. */
  readonly plan?: { readonly id: string; readonly summary: string } | null;
}
export interface ActivitySummary {
  readonly unreadCount: number;
  readonly latest: ActivityItem | null;
  readonly revision: string;
}

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string';
const nullableText = (value: unknown) => value === null || text(value);
const integer = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
const revision = (value: unknown) => text(value) && /^(0|[1-9]\d*)$/u.test(value);
const date = (value: unknown) => text(value) && /^\d{4}-\d{2}-\d{2}T.*Z$/u.test(value) && Number.isFinite(Date.parse(value));
const optionalObject = (value: unknown, valid: (item: Record<string, unknown>) => boolean) => value === null || object(value) && valid(value);
const boundedList = (value: unknown, valid: (item: Record<string, unknown>) => boolean) => Array.isArray(value)
  && value.length <= 5 && value.every((item: unknown) => object(item) && valid(item));

function validItem(value: unknown): value is ActivityItem {
  if (!object(value)) return false;
  return text(value.id) && text(value.kind) && KINDS.includes(value.kind)
    && text(value.state) && ['unread', 'read'].includes(String(value.state)) && revision(value.revision) && value.revision !== '0'
    && date(value.occurredAt) && date(value.updatedAt) && (value.readAt === null || date(value.readAt)) && integer(value.count)
    && optionalObject(value.agent, (agent) => text(agent.clientId) && nullableText(agent.name) && text(agent.kind) && ['oauth_client', 'api_key', 'unknown'].includes(String(agent.kind)))
    && optionalObject(value.collection, (collection) => text(collection.id) && nullableText(collection.title))
    && boundedList(value.folders, (folder) => text(folder.nodeId) && nullableText(folder.title) && integer(folder.count))
    && boundedList(value.items, (item) => text(item.nodeId) && nullableText(item.title) && nullableText(item.host) && date(item.occurredAt))
    && optionalObject(value.run, (run) => text(run.id) && text(run.ruleId) && nullableText(run.ruleName) && text(run.status)
      && integer(run.outputCount) && (run.attention === null || run.attention === 'review' || run.attention === 'awaitingApproval'))
    && (value.plan === undefined || optionalObject(value.plan, (plan) => text(plan.id) && text(plan.summary)));
}

export function validActivitySummary(value: unknown): value is ActivitySummary {
  return object(value) && integer(value.unreadCount) && revision(value.revision) && (value.latest === null || validItem(value.latest));
}

/** Pinned OpenAI webhook profile; deliberately excludes draft poll/stream methods. */
export const MCP_AUTOMATION_EVENT = 'colp.automation.triggered' as const;
export class McpEventsError extends Error {
  constructor(readonly code: -32601 | -32602 | -32015, message: string) { super(message); }
}
export interface McpEventSubscription {
  name: typeof MCP_AUTOMATION_EVENT;
  arguments: { targetId: string };
  delivery: { mode: 'webhook'; url: string; secret?: string };
  cursor?: null;
  ttlMs?: number | null;
}
const invalid = () => new McpEventsError(-32602, 'Invalid Events parameters.');
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw invalid();
  for (const d of Object.values(Object.getOwnPropertyDescriptors(value))) if (!('value' in d)) throw invalid();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw invalid();
}
export function parseMcpEventsParams(method: string, raw: unknown): McpEventSubscription | null {
  const p = record(raw ?? {});
  if (method === 'events/list') { keys(p, ['_meta']); return null; }
  if (method !== 'events/subscribe' && method !== 'events/unsubscribe') throw new McpEventsError(-32601, 'Method not found.');
  const subscribe = method === 'events/subscribe';
  keys(p, subscribe ? ['name','arguments','delivery','cursor','ttlMs','_meta'] : ['name','arguments','delivery','_meta']);
  const args = record(p.arguments), delivery = record(p.delivery);
  keys(args, ['targetId']); keys(delivery, subscribe ? ['mode','url','secret'] : ['mode','url']);
  if (p.name !== MCP_AUTOMATION_EVENT || typeof args.targetId !== 'string' || !/^[A-Za-z0-9._~-]{1,128}$/.test(args.targetId)
    || delivery.mode !== 'webhook' || typeof delivery.url !== 'string' || delivery.url.length > 2048
    || (p.cursor !== undefined && p.cursor !== null)
    || (p.ttlMs !== undefined && p.ttlMs !== null && (!Number.isSafeInteger(p.ttlMs) || (p.ttlMs as number) < 1))) throw invalid();
  let url: URL; try { url = new URL(delivery.url); } catch { throw invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw invalid();
  if (subscribe) {
    if (typeof delivery.secret !== 'string' || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(delivery.secret) || delivery.secret.length > 256) throw invalid();
    const encoded = delivery.secret.slice(6), decoded = Buffer.from(encoded, 'base64');
    if (decoded.length < 24 || decoded.length > 64 || decoded.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) throw invalid();
  }
  return { name: MCP_AUTOMATION_EVENT, arguments: { targetId: args.targetId },
    delivery: { mode: 'webhook', url: url.href, ...(subscribe ? { secret: delivery.secret as string } : {}) },
    ...(subscribe ? { cursor: null, ttlMs: (p.ttlMs ?? null) as number | null } : {}) };
}
export const MCP_AUTOMATION_EVENT_DESCRIPTOR = Object.freeze({
  name: MCP_AUTOMATION_EVENT,
  description: 'Ready automation work. Reconcile automation.jobs.list on setup and reconnect; a wake does not authorize or complete work.',
  delivery: ['webhook'],
  inputSchema: { type: 'object', properties: { targetId: { type: 'string', minLength: 1, maxLength: 128 } }, required: ['targetId'], additionalProperties: false },
  payloadSchema: { type: 'object', properties: Object.fromEntries(['runId','jobId','ruleId','ruleRevision','targetId','deliveryHandle'].map(k => [k, { type: 'string' }]).concat([['matchedCount', { type: 'integer' }]])),
    required: ['runId','jobId','ruleId','ruleRevision','targetId','deliveryHandle','matchedCount'], additionalProperties: false },
});

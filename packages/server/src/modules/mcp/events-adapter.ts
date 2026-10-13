import { McpEventsError, MCP_AUTOMATION_EVENT_DESCRIPTOR, parseMcpEventsParams, type McpEventSubscription } from '@know-n/colp/mcp';
import { AutomationError, type WorkPrincipal } from '../automation/index.js';
import type { McpApplicationContext } from './application-context.js';
import { automationWorkPrincipal } from './automation-context.js';
export interface AutomationEventsService {
  available(actor: WorkPrincipal): Promise<boolean>;
  subscribe(actor: WorkPrincipal, input: McpEventSubscription): Promise<{ id: string; refreshBefore: string; cursor: null; truncated: false }>;
  unsubscribe(actor: WorkPrincipal, input: McpEventSubscription): Promise<void>;
}
export interface McpEventsAdapter {
  available(context: McpApplicationContext): Promise<boolean>;
  call(context: McpApplicationContext, method: string, params: unknown): Promise<Record<string, unknown>>;
}
export function createMcpEventsAdapter(service: AutomationEventsService): McpEventsAdapter {
  const available = async (context: McpApplicationContext) => context.principal.kind === 'authenticated'
    && context.scopes.includes('automation:work') && service.available(automationWorkPrincipal(context));
  return { available, async call(context, method, params) {
    if (!await available(context)) throw new McpEventsError(-32601, 'Method not found.');
    const input = parseMcpEventsParams(method, params), actor = automationWorkPrincipal(context);
    try {
      if (method === 'events/list') return { events: [MCP_AUTOMATION_EVENT_DESCRIPTOR] };
      if (method === 'events/subscribe') return await service.subscribe(actor, input!);
      await service.unsubscribe(actor, input!); return {};
    } catch (error) {
      if (error instanceof AutomationError) throw eventsError(error);
      throw error;
    }
  } };
}

/** Invalid params only for what the caller can fix; transient server conditions stay retryable. */
function eventsError(error: AutomationError): McpEventsError {
  switch (error.code) {
    case 'rate_limited': case 'feature_temporarily_unavailable': case 'automation_paused':
      return new McpEventsError(-32603, 'Subscriptions are temporarily unavailable; retry later.');
    case 'invalid_request': case 'payload_too_large':
      return new McpEventsError(-32602, 'The subscription request is invalid.');
    default:
      return new McpEventsError(-32602, 'Current target authority is unavailable.');
  }
}

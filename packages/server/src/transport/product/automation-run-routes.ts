import { cancelAutomationRun, undoAutomationRun, getAutomationRun, parseContract, AutomationError } from '../../modules/automation/index.js';
import { automationView, type AutomationRoute } from './automation-rule-routes.js';
import { createAutomationPagination } from './automation-pagination.js';
export function automationRunRoutes(cursorKey: string): AutomationRoute[] {
  const page = createAutomationPagination(cursorKey);
  const runId = (params: unknown) => (params as { runId: string }).runId;
  return [
    { method:'POST',path:'/rules/:ruleId/run-once/preview',authorizeReplay:async({ports},body)=>{
      await ports.runOnce!.authorizePreview(JSON.parse(new TextDecoder().decode(body)).id);
    },action:async({ports,request})=>{
      if(!ports.runOnce)throw new AutomationError('automation_unsupported_capability','Run-once unavailable.');
      return automationView(await ports.runOnce.preview((request.params as {ruleId:string}).ruleId,request.body));
    }},
    { method:'POST',path:'/rules/:ruleId/run-once',authorizeReplay:async({ports,request})=>{
      await ports.runOnce!.authorizePreview(parseContract('RunOnceStartInput',request.body).previewId);
    },action:async({ports,request})=>{
      if(!ports.runOnce)throw new AutomationError('automation_unsupported_capability','Run-once unavailable.');
      return automationView(await ports.runOnce.start((request.params as {ruleId:string}).ruleId,request.body),201);
    }},
    { method: 'POST', path: '/runs/:runId/undo', ifMatch: true, action: async ({ ports, request, ifMatch }) =>
      automationView(await undoAutomationRun(ports, runId(request.params), request.body, ifMatch)) },
    { method: 'GET', path: '/runs', query: ['cursor', 'limit', 'collectionId', 'nodeId'], action: async ({ ports, actor, request }) => {
      const query = request.query as Record<string,string>;
      for (const value of [query.collectionId, query.nodeId]) if (value !== undefined && !/^[A-Za-z0-9._~-]{1,128}$/.test(value))
        throw new AutomationError('invalid_request', 'Invalid bookmark identity.');
      if (Boolean(query.collectionId) !== Boolean(query.nodeId)) throw new AutomationError('invalid_request', 'Bookmark history requires both collectionId and nodeId.');
      const scope = JSON.stringify(['runs', query.collectionId ?? null, query.nodeId ?? null]);
      const now = await ports.now(), { limit, after } = page.read(query, actor.accountId, scope, now);
      const rows = await ports.runs.list(after, limit + 1, query.nodeId ? { collectionId: query.collectionId!, nodeId: query.nodeId } : undefined);
      const items = rows.slice(0, limit).map(row => row.view);
      const last = rows[limit - 1];
      return automationView({ items, nextCursor: rows.length > limit && last
        ? page.next(actor.accountId, scope, limit, { createdAt: last.sortCreatedAt, id: last.view.id }, now) : null });
    } },
    { method: 'GET', path: '/runs/:runId', action: async ({ ports, request }) => automationView(await getAutomationRun(ports.runs, runId(request.params))) },
    { method: 'POST', path: '/runs/:runId/cancel', ifMatch: true, action: async ({ ports, request, ifMatch }) => {
      parseContract('CommandReason', request.body);
      return automationView(await cancelAutomationRun(ports.runs, runId(request.params), ifMatch));
    } },
  ];
}

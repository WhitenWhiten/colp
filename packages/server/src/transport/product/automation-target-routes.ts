import { AutomationError,parseContract,requireEtag,saveConnectionProfile,saveTarget,saveExecutor } from '../../modules/automation/index.js';
import { automationPathId,automationView,type AutomationRoute } from './automation-rule-routes.js';
import { createAutomationPagination } from './automation-pagination.js';

export function automationTargetRoutes(cursorKey: string): AutomationRoute[] {
  const page = createAutomationPagination(cursorKey),routes: AutomationRoute[] = [];
  for (const spec of [
    { path: 'connection-profiles',param: 'profileId',kind: 'profiles' as const,save: saveConnectionProfile },
    { path: 'targets',param: 'targetId',kind: 'targets' as const,save: saveTarget },
    { path: 'executors',param: 'executorId',kind: 'executors' as const,save: saveExecutor },
  ]) {
    routes.push(
      { method: 'POST',path: '/'+spec.path,action: async ({ ports,request }) => automationView(await spec.save(ports.targets,request.body),201) },
      { method: 'PUT',path: `/${spec.path}/:${spec.param}`,ifMatch: true,action: async ({ ports,request,ifMatch }) => automationView(await spec.save(ports.targets,request.body,automationPathId(request.params,spec.param),ifMatch)) },
      { method: 'GET',path: `/${spec.path}/:${spec.param}`,action: async ({ ports,request }) => {
        const view = await ports.targets[spec.kind].load(automationPathId(request.params,spec.param));
        if (!view) throw new AutomationError('resource_not_found','Automation configuration is unavailable.'); return automationView(view);
      } },
      { method: 'GET',path: '/'+spec.path,query: ['cursor','limit'],action: async ({ ports,actor,request }) => {
        const now = await ports.now(),{ limit,after } = page.read(request.query as Record<string,string>,actor.accountId,spec.path,now);
        const rows = await ports.targets[spec.kind].list(after,limit+1),last = rows[limit-1];
        return automationView({ items: rows.slice(0,limit).map(row => row.view),nextCursor: rows.length>limit && last ? page.next(actor.accountId,spec.path,limit,{ createdAt: last.createdAt,id: last.view.id },now) : null });
      } },
    );
  }
  routes.push(
    { method: 'POST',path: '/targets/:targetId/pairings',ifMatch: true,action: async ({ ports,request,ifMatch }) => {
      parseContract('CommandReason',request.body); const id = automationPathId(request.params,'targetId');
      const target = await ports.targets.targets.load(id); if (!target) throw new AutomationError('resource_not_found','Target is unavailable.'); requireEtag(target.revision,ifMatch);
      const grant = await ports.targets.issuePairing(id),current = (await ports.targets.targets.load(id))!;
      return { body: grant,status: 201,etag: `"${current.revision}"`,receiptBody: { ...grant,code: null } };
    } },
    { method: 'POST',path: '/targets/:targetId/revoke',ifMatch: true,action: async ({ ports,request,ifMatch }) => {
      parseContract('CommandReason',request.body); const id = automationPathId(request.params,'targetId');
      const target = await ports.targets.targets.load(id); if (!target) throw new AutomationError('resource_not_found','Target is unavailable.'); requireEtag(target.revision,ifMatch);
      return automationView(await ports.targets.revoke(id));
    } },
  );
  return routes;
}

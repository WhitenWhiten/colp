import { AutomationError,createAutomationPagination } from '../../modules/automation/index.js';
import { automationView,type AutomationRoute } from './automation-rule-routes.js';
export function automationDeliveryRoutes(cursorKey: string): AutomationRoute[] {
  const page=createAutomationPagination(cursorKey);
  return [
    { method:'GET',path:'/deliveries',query:['cursor','limit'],action:async ({ ports,actor,request }) => {
      if (!ports.deliveries) throw new AutomationError('automation_unsupported_capability','Deliveries unavailable.');
      const now=await ports.now(),{ limit,after }=page.read(request.query as Record<string,string>,actor.accountId,'deliveries',now);
      const rows=await ports.deliveries.list(after,limit+1),last=rows[limit-1];
      return automationView({ items:rows.slice(0,limit).map(r=>r.view),nextCursor:rows.length>limit && last
        ? page.next(actor.accountId,'deliveries',limit,{ id:last.view.id,createdAt:last.createdAt },now) : null });
    } },
    { method:'POST',path:'/deliveries/:deliveryId/retry',noBody:true,action:async ({ ports,request }) => {
      if (!ports.deliveries) throw new AutomationError('automation_unsupported_capability','Deliveries unavailable.');
      return automationView(await ports.deliveries.retry((request.params as { deliveryId:string }).deliveryId));
    } },
  ];
}

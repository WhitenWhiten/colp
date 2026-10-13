import { AutomationError } from '../../modules/automation/index.js';
import { readKnownCommandId } from './collection-route-helpers.js';
import { automationView,type AutomationRoute } from './automation-rule-routes.js';
export function automationJobRoutes(): AutomationRoute[] {
  const store = (ports: import('../../modules/automation/index.js').AutomationPorts) => {
    if (!ports.ownerJobs) throw new AutomationError('automation_unsupported_capability','Worker jobs are unavailable.');return ports.ownerJobs;
  };
  const id = (request: import('fastify').FastifyRequest) => (request.params as { jobId: string }).jobId;
  return [
    { method: 'GET',path: '/jobs/:jobId',action: async ({ ports,request }) => automationView(await store(ports).get(id(request))) },
    { method: 'POST',path: '/jobs/:jobId/decision',ifMatch: true,action: async ({ ports,request,ifMatch }) => automationView(await store(ports).decide(id(request),request.body,ifMatch,readKnownCommandId(request))) },
    { method: 'POST',path: '/jobs/:jobId/retry',ifMatch: true,action: async ({ ports,request,ifMatch }) => automationView(await store(ports).retry(id(request),request.body,ifMatch)) },
  ];
}

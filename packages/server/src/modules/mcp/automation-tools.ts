import { callAutomationAccountTool, type AutomationAccountTools } from './automation-account-tools.js';
import { automationManagerReadOrRecover, AUTOMATION_MANAGER_MUTATIONS } from './automation-manager.js';
import { configurationReceiptValue } from './automation-configuration-tools.js';
import { randomUUID } from 'node:crypto';
import { AutomationError,automationCapabilities,createRule,replaceRule,setLifecycle,validateRule,previewRule,createAutomationPagination,
  type AutomationUnitOfWork,type AutomationWorkerService,type WorkerPairingPort } from '../automation/index.js';
import { canonicalCommandFingerprint } from '../commands/index.js';
import type { AutomationCatalogPort } from './automation-catalog.js';
import { automationWorkPrincipal } from './automation-context.js';
import type { McpApplicationContext } from './application-context.js';
import { AUTOMATION_CONTRACT_VERSION } from '@know-n/colp/automation';

export function createAutomationToolPort(options: { access: AutomationCatalogPort['access']; configurations: AutomationUnitOfWork;
  worker?: AutomationWorkerService; pairing: WorkerPairingPort; cursorKey: string; accountTools?: AutomationAccountTools; deviceBridge?: import('../automation/index.js').DeviceBridgeOwnerPort }): AutomationCatalogPort {
  const pages = createAutomationPagination(options.cursorKey);
  return { access: options.access,
    async call(context,name,args) {
      try {
        const actor = automationWorkPrincipal(context);
        let value: unknown;
        if (name === 'automation.targets.pair') {
          const outcome = await options.pairing.pair(actor,args,String(args.pairingId));
          if (outcome.kind === 'succeeded') value=outcome.target;
          else if (outcome.kind === 'replay') value=JSON.parse(new TextDecoder().decode(outcome.result.body));
          else throw new AutomationError('automation_command_conflict','Pairing command is unavailable or conflicted.');
        } else if (name === 'automation.targets.mine') {
          value=await options.pairing.mine(actor,query(args));
        } else if (name.startsWith('automation.jobs.') && name !== 'automation.jobs.retry') {
          if (!options.worker) throw new AutomationError('automation_unsupported_capability','Worker orchestration is unavailable.');
          const id = String(args.jobId),operation = name.slice('automation.jobs.'.length);
          if (operation === 'list') value=await options.worker.list(actor,query(args));
          else if (operation === 'get') value=await options.worker.get(actor,id,String(args.deliveryHandle));
          else if (operation === 'inputs') value=await options.worker.inputs(actor,id,{ ...query(args),deliveryHandle: String(args.deliveryHandle) });
          else if (operation === 'claim' || operation === 'heartbeat' || operation === 'submit' || operation === 'fail') value=await options.worker.mutate(actor,id,operation,args.request,String(args.commandId));
          else throw new AutomationError('automation_unsupported_capability','Tool is unavailable.');
        } else if (name.startsWith('automation.adapters.') || name.startsWith('automation.classification.') || name === 'automation.device_requests.get') {
          if (!options.deviceBridge) throw new AutomationError('automation_unsupported_capability','Browser bridge unavailable.');
          value = name === 'automation.device_requests.get' ? await options.deviceBridge.get(actor,String(args.requestId))
            : await options.deviceBridge.request(actor,name.slice('automation.'.length) as import('../automation/index.js').DeviceBridgeOperation,args);
        } else if (name.startsWith('automation.activity.') || name.startsWith('automation.sync.')) value=await callAutomationAccountTool(options.accountTools ?? {},actor,name,args);
        else value=await managerCall(context,name,args);
        return { kind: 'complete',content: [{ type: 'text',text: JSON.stringify(value) }],structuredContent: value };
      } catch (error) {
        if (!(error instanceof AutomationError)) throw error;
        return { kind: 'rejected',stableCode: error.code,safeMessage: error.message,retryable: ['automation_paused','rate_limited','feature_temporarily_unavailable'].includes(error.code) };
      }
    },
  };
  async function managerCall(context: McpApplicationContext,name: string,args: Readonly<Record<string,unknown>>) {
    const actor = automationWorkPrincipal(context);
    return options.configurations.execute(actor,async ports => {
      const mutation = AUTOMATION_MANAGER_MUTATIONS.has(name),commandId = mutation ? String(args.commandId) : randomUUID();
      const binding = { principalId: actor.accountId,commandScope: JSON.stringify(['automation-manager',actor.clientId,actor.credentialBindingId,name]),commandId };
      const fingerprint = canonicalCommandFingerprint({ method: 'POST',route: name,mediaType: 'application/json',body: args });
      if (mutation) {
        const claim = await ports.receipts.claim(binding,fingerprint);
        if (claim.kind === 'replay') return JSON.parse(new TextDecoder().decode(claim.result.body));
        if (claim.kind !== 'claimed') throw new AutomationError('automation_command_conflict','Manager command is unavailable or conflicted.');
      }
      let value: unknown;
      switch (name) {
        case 'automation.rules.describe': value=automationCapabilities(ports);break;
        case 'automation.rules.validate': value=await validateRule(ports,actor,args);break;
        case 'automation.rules.preview': value=await previewRule(ports,actor,args);break;
        case 'automation.rules.save': value=args.mode === 'create' ? await createRule(ports,actor,args.rule)
          : await replaceRule(ports,actor,String(args.ruleId),args.change,`"${String(args.baseRevision)}"`);break;
        case 'automation.rules.set_state': value=await setLifecycle(ports,actor,String(args.ruleId),args.change,`"${String(args.baseRevision)}"`);break;
        case 'automation.bindings.list':
        case 'automation.targets.list': {
          const scope = name === 'automation.bindings.list' ? 'bindings' : 'targets',now = await ports.now(),{ limit,after } = pages.read(query(args),actor.accountId,scope,now);
          const rows = scope === 'bindings' ? await ports.bindings.list(actor.accountId,after,limit+1) : await ports.targets.targets.list(after,limit+1),last = rows[limit-1];
          value={ items: rows.slice(0,limit).map(r => r.view),nextCursor: rows.length>limit && last ? pages.next(actor.accountId,scope,limit,{ id: last.view.id,createdAt: last.createdAt },now) : null };break;
        }
        default: value=await automationManagerReadOrRecover(ports,actor,name,args,options.cursorKey);
      }
      if (mutation) await ports.receipts.complete(binding,fingerprint,{ status: 200,body: new TextEncoder().encode(JSON.stringify(configurationReceiptValue(name,value))),mediaType: 'application/json',contractVersion: AUTOMATION_CONTRACT_VERSION,stableHeaders: { 'cache-control': 'private, no-store' } });
      return value;
    });
  }
}
function query(args: Readonly<Record<string,unknown>>): { targetId?: string; cursor?: string; limit?: string } {
  return { ...(typeof args.targetId === 'string' ? { targetId: args.targetId } : {}),...(typeof args.cursor === 'string' ? { cursor: args.cursor } : {}),
    ...(typeof args.limit === 'number' ? { limit: String(args.limit) } : {}) };
}

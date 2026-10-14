import type { RuleDefinition, ExecutionPolicyInput, PairingGrant } from '@know-n/colp/automation';
import { automationWorkerFixture } from './automation-worker-fixture.js';
import { writeAgentPolicy } from '../../src/infrastructure/collections/index.js';
import { readRepositoryFile } from './repository-files.js';

/** Real machine credentials, Owner configuration, canonical intake and durable work. */
export async function automationPollingFixture(prefix: string, options: {
  wakeMode?: 'events' | 'poll';
  configure?: (definition:RuleDefinition,policy:ExecutionPolicyInput)=>void;
  three?: boolean; trusted?: boolean; policyEnabled?: boolean; maxCalls?: number; dailyLimit?: number;
  pair?: (fixture: Awaited<ReturnType<typeof automationWorkerFixture>>, grant: PairingGrant) => Promise<void>;
} = {}) {
  const f = await automationWorkerFixture(prefix,100,true,true);
  try {
    const check = <T extends { statusCode: number; body: string; json(): unknown }>(response: T, status = 201): T => {
      if (response.statusCode !== status) throw new Error(`Polling fixture ${response.statusCode}: ${response.body}`);
      return response;
    };
    const setup = await f.setup({ wakeMode: options.wakeMode ?? 'poll' });
    if (options.pair) await options.pair(f,setup.grant);
    else check(await f.pair(setup.grant),200);
    const executors = check(await f.app.inject({ url: '/api/v1/me/automations/executors',headers: { cookie: f.owner.cookie } }),200).json();
    const executor = executors.items[0];
    const bindings = check(await f.ownerPost('/binding-sets',{ name: 'Polling gate bindings',values: { ...f.values,researchEnricher: { kind: 'executor',executorId: executor.id } } }));
    const policy = JSON.parse(readRepositoryFile('docs/automation/design/examples/execution-policy.json')) as ExecutionPolicyInput;
    policy.allowAutomaticWrites=true;
    for (const assignment of policy.assignments) { assignment.allowedDestinations=[executor.id]; assignment.maxCalls=options.maxCalls ?? 1; }
    const definition = JSON.parse(readRepositoryFile(`docs/automation/design/examples/${options.three ? 'academic-intake' : 'academic-summary-only'}.json`)) as RuleDefinition;
    definition.scope.collectionId='collection'; definition.route.targetIds=[setup.target.id];
    if (options.three) definition.tasks[2]!.after=['tags'];
    if (options.dailyLimit !== undefined) definition.policy.maxRunsPerDay=options.dailyLimit;
    options.configure?.(definition,policy);
    const savedPolicy = options.policyEnabled === false ? null : check(await f.ownerPost('/execution-policies',policy));
    const ruleInput = { definition,bindingSetId: bindings.json().id,...(savedPolicy ? { executionPolicyId: savedPolicy.json().id } : {}) };
    const rule = check(await f.ownerPost('/rules',ruleInput));
    const preview = check(await f.ownerPost('/rules/preview',{ rule: ruleInput,mode: 'currentState' }),200);
    const enabled=check(await f.ownerPost(`/rules/${rule.json().id}/lifecycle`,{ state: 'enabled',pendingRuns: 'hold',reason: 'Activate exact backend gate preview',activationPreviewId: preview.json().previewId },String(rule.headers.etag)),200);
    if (options.trusted !== false) await writeAgentPolicy(f.db,f.owner.accountId,f.actor.clientId,'trusted');
    await f.createNode('fresh-paper','root','Private paper title','https://arxiv.org/abs/new'); await f.inspect();
    return { ...f,target: setup.target,rule: enabled.json(),ruleInput };
  } catch (error) { await f.close(); throw error; }
}

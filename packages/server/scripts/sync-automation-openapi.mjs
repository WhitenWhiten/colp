import { readFile, writeFile } from 'node:fs/promises';
import { parse, stringify } from 'yaml';
const root = new URL('../', import.meta.url);
const design = parse(await readFile(new URL('../../docs/automation/design/api/automation.openapi.yaml', root), 'utf8'));
const ids = new Set(JSON.parse(await readFile(new URL('openapi/automation-operations.json', root), 'utf8')));
const adjustments = JSON.parse(await readFile(new URL('../../docs/automation/contract-adjustments.json', root), 'utf8'));
for (const [name, patch] of Object.entries(adjustments)) {
  if (patch.schema) { design.components.schemas[name] = JSON.parse(JSON.stringify(patch.schema).replaceAll('#/$defs/', '#/components/schemas/')); continue; }
  design.components.schemas[name].required = [...design.components.schemas[name].required.filter((key) => !patch.removeRequired.includes(key)), ...(patch.addRequired ?? [])];
  Object.assign(design.components.schemas[name].properties, JSON.parse(JSON.stringify(patch.addProperties ?? {}).replaceAll('#/$defs/', '#/components/schemas/')));
}
const paths = {};
for (const [path, item] of Object.entries(design.paths)) {
  for (const [method, operation] of Object.entries(item)) if (ids.has(operation.operationId)) {
    paths[path] ??= {};
    paths[path][method] = structuredClone(operation);
    paths[path][method].tags = ['Automation'];
    paths[path][method]['x-known-feature-gate'] = 'automation_configuration';
    paths[path][method].security = [{ cookieAuth: [] }];
    if (path.startsWith('/api/v1/automation-work/')) {
      paths[path][method].security = [{ DeviceBearer: [] }];
      paths[path][method]['x-known-feature-gate'] = 'automation_runtime';
      paths[path][method].description += ' Uses the existing MCP OAuth verifier and resource audience, including machine account-key tokens; no additional issuer.';
    }
    if (path.startsWith('/api/v1/automation-device/')) {
      // Bridge recovery also accepts installation possession without a live Sync lease.
      const bridge = path === '/api/v1/automation-device/bridge-requests' || path === '/api/v1/automation-device/bridge-results';
      paths[path][method].security = [{ DeviceBearer: [] }];
      paths[path][method].parameters.push({ in: 'header', name: 'Known-Sync-Session', required: !bridge,
        ...(bridge ? { description: 'Legacy live Sync session. When omitted, both installation headers are required instead.' } : {}),
        schema: { type: 'string', minLength: 1, maxLength: 256 } });
      if (bridge) {
        paths[path][method].description += ' With a current device bearer, supply either Known-Sync-Session or both Known-Sync-Replica-Id and Known-Sync-Replica-Proof. Installation authority remains usable while personal Sync is paused; account, collection, replica ownership and credential revocation are checked.';
        for (const name of ['Known-Sync-Replica-Id', 'Known-Sync-Replica-Proof']) paths[path][method].parameters.push({
          in: 'header', name, required: false, description: 'Required when Known-Sync-Session is omitted.',
          schema: { type: 'string', minLength: 1, maxLength: 256 },
        });
      }
      paths[path][method].parameters.push({ $ref: '#/components/parameters/Origin' });
    }
    paths[path][method].description += ' Backend surface; runtime availability is reported by capabilities. Historical preview has no fallback.';
  }
}
// Additive AW-16 bookmark history filter, with cursor binding to the exact filter.
const setupOperation = structuredClone(paths['/api/v1/me/automations/connection-profiles'].post);
setupOperation.operationId = 'prepareAutomationAgent';
setupOperation.summary = 'Prepare an agent and a draft rule atomically';
setupOperation.description = 'Owner-authorized setup creates or reuses a target, binds executors and folders, and saves a rule with approval-required execution. It never enables the rule or starts an agent. Pairing codes are returned once; replay returns a null code.';
setupOperation.parameters = setupOperation.parameters.filter(parameter => !parameter.$ref?.endsWith('/IfMatch'));
delete setupOperation.responses['201'].headers.ETag;
setupOperation.requestBody.content['application/json'].schema = { $ref: '#/components/schemas/AgentSetupInput' };
setupOperation.responses['201'].content['application/json'].schema = { $ref: '#/components/schemas/AgentSetupResult' };
paths['/api/v1/me/automations/agent-setup'] = { post: setupOperation };

// Additive AW-16 bookmark history filter, with cursor binding to the exact filter.
if (paths['/api/v1/me/automations/runs']) {
  for (const name of ['collectionId', 'nodeId']) paths['/api/v1/me/automations/runs'].get.parameters.push({
    in: 'query', name, required: false, description: 'Supply both collectionId and nodeId for bookmark history.',
    schema: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._~-]+$' },
  });
}
if (paths['/api/v1/automation-device/bundle']) paths['/api/v1/automation-device/bundle'].get.parameters.push({
  in: 'query', name: 'profile', required: false, schema: { type: 'string', maxLength: 80 },
  description: 'Requested finite profile; unsupported profiles fail without a partial snapshot.',
});
// Narrow additions requested by BE-1 CRUD and required revision discovery.
const rulePath = '/api/v1/me/automations/rules/{ruleId}', bindingPath = '/api/v1/me/automations/binding-sets/{bindingSetId}';
paths[rulePath].delete = { ...structuredClone(paths[rulePath].get), operationId: 'deleteAutomationRule', summary: 'Archive a rule without deleting immutable history',
  parameters: [...paths[rulePath].get.parameters, ...['CommandId','IfMatch','Csrf','Origin'].map((name) => ({ $ref: `#/components/parameters/${name}` }))] };
paths[bindingPath].delete = { ...structuredClone(paths[bindingPath].get), operationId: 'deleteAutomationBindingSet', summary: 'Delete an unreferenced binding set',
  parameters: [...paths[bindingPath].get.parameters, ...['CommandId','IfMatch','Csrf','Origin'].map((name) => ({ $ref: `#/components/parameters/${name}` }))],
  responses: { ...paths[bindingPath].get.responses, '204': { description: 'Unreferenced binding set removed.' } } };
delete paths[bindingPath].delete.responses['200'];
paths['/api/v1/me/automations/pause'].get = { ...structuredClone(paths['/api/v1/me/automations/pause'].post), operationId: 'getAutomationPause',
  summary: 'Read global pause state and revision', parameters: [] };
delete paths['/api/v1/me/automations/pause'].get.requestBody;
// AW-31: uncertain provider work has an Owner retry, distinct from deferred Events delivery retry.
const jobPath = '/api/v1/me/automations/jobs/{jobId}';
if (paths[jobPath]) {
  const retry = structuredClone(paths[jobPath+'/decision'].post);
  retry.operationId='retryAutomationJob';retry.summary='Explicitly retry uncertain provider work with original pins';
  retry.description='Only uncertain work with no durable proposal and remaining pinned maxCalls is eligible. Existing plan/effects must reconcile, never re-execute. Unknown cost remains disclosed.';
  retry.requestBody={ required: true,content: { 'application/json': { schema: { $ref: '#/components/schemas/CommandReason' } } } };
  retry.responses['200'].content['application/json'].schema={ $ref: '#/components/schemas/Job' };
  paths[jobPath+'/retry']={ post: retry };
}
// Owner-controlled negative tag preferences use canonical tag keys, never whole-plan rejection.
const tagPreferencePath = rulePath + '/rejected-tags/{tagKey}';
paths[tagPreferencePath] = {};
for (const method of ['post', 'delete']) {
  const operation = structuredClone(paths[rulePath+'/lifecycle'].post);
  operation.operationId = method === 'post' ? 'rejectAutomationTag' : 'allowAutomationTag';
  operation.summary = method === 'post' ? 'Do not suggest this tag again for this rule' : 'Allow this tag to be suggested again';
  operation.parameters.push({ in:'path',name:'tagKey',required:true,schema:{type:'string',minLength:1,maxLength:64} });
  operation.requestBody = {required:true,content:{'application/json':{schema:{$ref:'#/components/schemas/CommandReason'}}}};
  operation.responses['200'].content['application/json'].schema = {$ref:'#/components/schemas/OperationReceipt'};
  paths[tagPreferencePath][method] = operation;
}
const components = {};
function prefix(value) {
  if (Array.isArray(value)) return value.map(prefix);
  if (!value || typeof value !== 'object') return value;
  if (value.$ref?.startsWith('#/components/')) {
    const [, , category, name] = value.$ref.split('/');
    components[category] ??= {};
    const prefixed = `Automation${name}`;
    if (!components[category][prefixed]) {
      components[category][prefixed] = {};
      components[category][prefixed] = prefix(design.components[category][name]);
    }
    return { ...value, $ref: `#/components/${category}/${prefixed}` };
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, prefix(item)]));
}
const fragment = { paths: prefix(paths), components };
// Mount the producer's private responses using the server's shared transport headers.
for (const item of Object.values(fragment.paths)) for (const operation of Object.values(item)) {
  for (const response of Object.values(operation.responses ?? {})) {
    if (response.$ref) continue;
    response.headers ??= {};
    response.headers['X-Request-Id'] = { $ref: '#/components/headers/XRequestId' };
    const cache = response.headers['Cache-Control'];
    if (!cache || cache.schema?.const === 'private, no-store') {
      response.headers['Cache-Control'] = { $ref: '#/components/headers/PrivateNoStore' };
    }
  }
}
if ([...ids].some(id => id === 'ingestAutomationIntakeReceipt')) {
  components.securitySchemes ??= {};
  components.securitySchemes.DeviceBearer = design.components.securitySchemes.DeviceBearer;
}
const outputs = { 'openapi/fragments/automations.yaml': '# Generated by sync-automation-openapi.mjs; producer mirror.\n' + stringify(fragment, { lineWidth: 120 }) };
let source = await readFile(new URL('openapi/product-v1.yaml', root), 'utf8');
function replaceBlock(text, label, content, insertion) {
  const start = `# BEGIN AUTOMATION ${label}\n`, end = `# END AUTOMATION ${label}\n`;
  if (text.includes(start)) return text.slice(0, text.indexOf(start)) + start + content + end + text.slice(text.indexOf(end) + end.length);
  return text.replace(insertion, start + content + end + insertion);
}
const pathBody = stringify(fragment.paths, { lineWidth: 120 }).split('\n').filter(Boolean).map((line) => '  ' + line).join('\n') + '\n';
source = replaceBlock(source, 'PATHS', pathBody, '\ncomponents:\n');
for (const [category, values] of Object.entries(components)) {
  const body = stringify(values, { lineWidth: 120 }).split('\n').filter(Boolean).map((line) => '    ' + line).join('\n') + '\n';
  const start = `# BEGIN AUTOMATION ${category}\n`, end = `# END AUTOMATION ${category}\n`;
  if (source.includes(start)) source = replaceBlock(source, category, body, '');
  else if (source.includes(`\n  ${category}:\n`)) source = source.replace(`\n  ${category}:\n`, `\n  ${category}:\n${start}${body}${end}`);
  else source += `\n  ${category}:\n${start}${body}${end}`;
}
outputs['openapi/product-v1.yaml'] = source;
for (const [file, value] of Object.entries(outputs)) {
  const path = new URL(file, root);
  if (process.argv.includes('--check')) { if (await readFile(path, 'utf8') !== value) throw new Error(`Automation OpenAPI drift: ${file}`); }
  else await writeFile(path, value);
}

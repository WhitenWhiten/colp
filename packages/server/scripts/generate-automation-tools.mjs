import { readFile,writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = new URL('../',import.meta.url);
const catalog = JSON.parse(await readFile(new URL('../../docs/automation/design/api/mcp-tool-catalog.json',root),'utf8'));
const patches = JSON.parse(await readFile(new URL('../../docs/automation/contract-adjustments.json',root),'utf8'));
const taskToolsets = JSON.parse(await readFile(new URL('../../docs/automation/design/api/mcp-task-toolsets.json',root),'utf8'));
const relations = JSON.parse(await readFile(new URL('../../docs/automation/design/api/mcp-capability-relations.json',root),'utf8'));
const canonical = JSON.parse(await readFile(new URL('../../docs/automation/design/schemas/rule-input.schema.json',root),'utf8'));
for (const [name,patch] of Object.entries(patches)) {
  for (const defs of [catalog.$defs,canonical.$defs]) {
    if (patch.schema) { defs[name] = patch.schema; continue; }
    const schema = defs[name];
    if (!schema) throw new Error(`Missing catalog definition ${name}`);
    schema.required = [...schema.required.filter(key => !patch.removeRequired.includes(key)),...(patch.addRequired ?? [])];
    Object.assign(schema.properties,patch.addProperties ?? {});
  }
}
// The catalog repeats canonical definitions; a local copy must never silently shadow the canonical one.
const stable = value => JSON.stringify(value,(_key,item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key,item[key]])) : item);
const shadowed = Object.keys(catalog.$defs).filter(name => Object.hasOwn(canonical.$defs,name) && stable(catalog.$defs[name]) !== stable(canonical.$defs[name]));
if (shadowed.length) throw new Error(`MCP catalog definitions differ from the canonical rule schema: ${shadowed.join(', ')}`);
catalog.$defs.HostCommandId = { type: 'string',minLength: 36,maxLength: 36,pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' };
function adaptCommands(value) {
  if (!value || typeof value !== 'object') return;
  if (value.properties?.commandId) value.properties.commandId = { $ref: '#/$defs/HostCommandId' };
  for (const child of Object.values(value)) adaptCommands(child);
}
for (const schema of Object.values(catalog.$defs)) adaptCommands(schema);
function closed(ref) {
  const schema = structuredClone(catalog.$defs[ref.$ref.split('/').at(-1)]),defs = {};
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (typeof value.$ref === 'string') {
      if (!value.$ref.startsWith('#/$defs/')) throw new Error(`External schema reference ${value.$ref}`);
      const name = value.$ref.split('/').at(-1);
      if (!Object.hasOwn(catalog.$defs,name)) throw new Error(`Missing schema definition ${name}`);
      if (!Object.hasOwn(defs,name)) { defs[name] = catalog.$defs[name];visit(defs[name]); }
    }
    for (const child of Object.values(value)) visit(child);
  }
  visit(schema);
  return { ...schema,type: schema.type ?? 'object',...(Object.keys(defs).length ? { $defs: defs } : {}) };
}
const standardHelpers = new Set(['collections.list','collections.get','nodes.get']);
const names = catalog.tools.map(tool => tool.name), known = new Set([...names,...standardHelpers]);
if (new Set(names).size !== names.length) throw new Error('Duplicate capability ID');
const taskNames = ['recovery','rule-authoring','sync-diagnostics','browser-rules'];
if (stable(Object.keys(taskToolsets).sort()) !== stable([...taskNames].sort())) throw new Error('Unexpected task toolsets');
for (const [name,set] of Object.entries(taskToolsets)) {
  if (!Array.isArray(set.aliases) || !set.aliases.some(alias => /[\u3400-\u9fff]/u.test(alias)) || !set.members.length
      || new Set(set.members).size !== set.members.length) throw new Error(`Invalid task set ${name}`);
  for (const member of set.members) {
    if (!known.has(member) || catalog.tools.find(tool => tool.name === member)?.profile === 'automationWorker') throw new Error(`Invalid task member ${member}`);
  }
}
for (const [name,links] of Object.entries(relations)) {
  if (!known.has(name)) throw new Error(`Unknown relation source ${name}`);
  for (const link of [...(links.prerequisites ?? []),...(links.nextSteps ?? [])]) {
    if (!known.has(link.id) || typeof link.input !== 'string' || !link.input.trim()) throw new Error(`Invalid relation ${name} -> ${link.id}`);
  }
}
const sha = value => createHash('sha256').update(stable(value)).digest('hex');
const tools = catalog.tools.map(tool => {
  if (typeof tool.description !== 'string' || tool.description.trim().length < 35
      || /owner-scoped management|authorized Automation operation/i.test(tool.description)) throw new Error(`Weak description: ${tool.name}`);
  const keys = ['businessMutation','deviceRequest','externalRequest','providerConsumption'];
  if (!tool.effects || keys.some(key => typeof tool.effects[key] !== 'boolean') || Object.keys(tool.effects).length !== keys.length)
    throw new Error(`Unreviewed effects: ${tool.name}`);
  const inputSchema = closed(tool.inputSchema),outputSchema = closed(tool.outputSchema);
  const contract = { name: tool.name,profile: tool.profile,requiredScopes: tool.requiredScopes,
    availability: tool.availability ?? 'paired',description: tool.description,inputSchema,outputSchema,
    annotations: tool.annotations,effects: tool.effects };
  return { ...contract,taskToolsets: taskNames.filter(name => taskToolsets[name].members.includes(tool.name)),
    prerequisites: relations[tool.name]?.prerequisites ?? [],nextSteps: relations[tool.name]?.nextSteps ?? [],contractDigest: sha(contract) };
});
const output = '// Generated from reviewed Automation contracts and task metadata. Do not edit.\n'
  + 'export const AUTOMATION_TOOL_CONTRACTS = '+JSON.stringify(tools)+' as const;\n'
  + 'export const TASK_TOOLSETS = '+JSON.stringify(taskToolsets)+' as const;\n'
  + 'export const CAPABILITY_RELATIONS = '+JSON.stringify(relations)+' as const;\n'
  + 'export const AUTOMATION_DEFINITION_DIGEST = '+JSON.stringify(sha({ tools,taskToolsets,relations }))+' as const;\n';
const path = new URL('src/modules/mcp/automation-tool-contracts.generated.ts',root);
if (process.argv.includes('--check')) { if (await readFile(path,'utf8') !== output) throw new Error('Automation MCP catalog drift'); }
else await writeFile(path,output);

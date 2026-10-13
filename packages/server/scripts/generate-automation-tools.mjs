import { readFile,writeFile } from 'node:fs/promises';
const root = new URL('../',import.meta.url);
const catalog = JSON.parse(await readFile(new URL('../../docs/automation/design/api/mcp-tool-catalog.json',root),'utf8'));
const patches = JSON.parse(await readFile(new URL('../../docs/automation/contract-adjustments.json',root),'utf8'));
for (const [name,patch] of Object.entries(patches)) {
  const schema = catalog.$defs[name];
  if (!schema) throw new Error(`Missing catalog definition ${name}`);
  schema.required = [...schema.required.filter(key => !patch.removeRequired.includes(key)),...(patch.addRequired ?? [])];
  Object.assign(schema.properties,patch.addProperties ?? {});
}
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
      const name = value.$ref.split('/').at(-1);
      if (!Object.hasOwn(defs,name)) { defs[name] = catalog.$defs[name];visit(defs[name]); }
    }
    for (const child of Object.values(value)) visit(child);
  }
  visit(schema);
  return { ...schema,type: schema.type ?? 'object',...(Object.keys(defs).length ? { $defs: defs } : {}) };
}
const tools = catalog.tools.map(tool => ({ name: tool.name,profile: tool.profile,requiredScopes: tool.requiredScopes,
  availability: tool.availability ?? 'paired',description: tool.description ?? `${tool.name}: authorized Automation operation; current profile and scopes are required.`,
  inputSchema: closed(tool.inputSchema),outputSchema: closed(tool.outputSchema),annotations: tool.annotations }));
const output = '// Generated from the reviewed Automation catalog and contract adjustments.\nexport const AUTOMATION_TOOL_CONTRACTS = '+JSON.stringify(tools)+' as const;\n';
const path = new URL('src/modules/mcp/automation-tool-contracts.generated.ts',root);
if (process.argv.includes('--check')) { if (await readFile(path,'utf8') !== output) throw new Error('Automation MCP catalog drift'); }
else await writeFile(path,output);

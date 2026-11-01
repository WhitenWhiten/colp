import { expect, test } from 'vitest';
import { AUTOMATION_TOOL_CONTRACTS, TASK_TOOLSETS } from '../../../src/modules/mcp/automation-tool-contracts.generated.js';
import { automationCatalogKey, capabilityMetadata, createMcpApplicationContext, PHASE4B_MCP_READ_TOOL_CATALOG } from '../../../src/modules/mcp/index.js';

test('metadata binds reviewed task relationships and versions to existing contracts', () => {
  const contract = AUTOMATION_TOOL_CONTRACTS.find(item => item.name === 'automation.trash.get')!;
  const metadata = capabilityMetadata(contract)!;
  expect(metadata.taskToolsets).toEqual(['recovery']);
  expect(metadata.aliases.some(alias => alias.includes('恢复'))).toBe(true);
  expect(metadata.nextSteps.map(step => step.id)).toContain('automation.trash.restore');
  expect(metadata.contractDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(metadata.effects.businessMutation).toBe(false);
  for (const name of ['automation.rules.preview','automation.runs.preview','automation.activity.read']) {
    expect(AUTOMATION_TOOL_CONTRACTS.find(item => item.name === name)?.effects.businessMutation,name).toBe(true);
  }
  expect(AUTOMATION_TOOL_CONTRACTS.find(item => item.name === 'automation.browser_rules.preview')?.effects.deviceRequest).toBe(true);
  expect(AUTOMATION_TOOL_CONTRACTS.find(item => item.name === 'automation.classification.preview')?.effects.providerConsumption).toBe(true);
  const collection = PHASE4B_MCP_READ_TOOL_CATALOG.find(item => item.name === 'collections.get')!;
  expect(capabilityMetadata(collection)?.taskToolsets).toContain('recovery');
  expect(capabilityMetadata({ ...collection, description: collection.description + ' updated' })?.contractDigest)
    .not.toEqual(capabilityMetadata(collection)?.contractDigest);
  const all = new Set([...AUTOMATION_TOOL_CONTRACTS.map(item => item.name),...PHASE4B_MCP_READ_TOOL_CATALOG.map(item => item.name),'collections.list']);
  for (const set of Object.values(TASK_TOOLSETS)) for (const name of set.members) expect(all.has(name),name).toBe(true);
});

test('catalog keys change with identity, profile selection and standard definition changes', () => {
  const context = createMcpApplicationContext({ principal: { kind: 'authenticated',principalId: 'owner',clientId: 'client',credentialBindingId: 'binding',
    resourceAudience: 'https://example.test/collections/-/mcp',securityEpoch: '1' },scopes: ['automation:read','mcp:read:own'],
    abortSignal: new AbortController().signal,budgets: { maxDepth: 16,maxNodes: 1000,maxBytes: 100000,maxOperations: 100 },correlationId: 'test',authorization: {} });
  const profile = { id: 'profile',revision: '1',automationEnabled: true,catalogs: ['standard','automationManager'],pairedTargets: [] };
  const tool = PHASE4B_MCP_READ_TOOL_CATALOG[0]!;
  const key = automationCatalogKey(context,profile,[tool]);
  expect(automationCatalogKey(context,{ ...profile,taskToolsets: ['recovery'] },[tool])).not.toBe(key);
  expect(automationCatalogKey(context,profile,[{ ...tool,description: tool.description+' changed' }])).not.toBe(key);
  expect(automationCatalogKey({ ...context,principal: { ...context.principal,clientId: 'other' } },profile,[tool])).not.toBe(key);
});

test('generator changes contract and catalog versions for deployed definition changes and rejects broken references', async () => {
  const { mkdtemp, mkdir, copyFile, readFile, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { execFileSync, spawnSync } = await import('node:child_process');
  const root = fileURLToPath(new URL('../../../../../',import.meta.url));
  const scratch = await mkdtemp(join(tmpdir(),'colp-mcp-generation-'));
  const files = ['packages/server/scripts/generate-automation-tools.mjs','docs/automation/design/api/mcp-tool-catalog.json',
    'docs/automation/design/api/mcp-task-toolsets.json','docs/automation/design/api/mcp-capability-relations.json',
    'docs/automation/contract-adjustments.json','docs/automation/design/schemas/rule-input.schema.json'];
  try {
    for (const file of files) { await mkdir(dirname(join(scratch,file)),{ recursive: true });await copyFile(join(root,file),join(scratch,file)); }
    await mkdir(join(scratch,'packages/server/src/modules/mcp'),{ recursive: true });
    const script = join(scratch,files[0]!);
    const output = join(scratch,'packages/server/src/modules/mcp/automation-tool-contracts.generated.ts');
    const generate = async () => {
      execFileSync(process.execPath,[script]);
      const text = await readFile(output,'utf8');
      const tools = JSON.parse(text.match(/AUTOMATION_TOOL_CONTRACTS = (.*) as const;/)![1]!);
      return { contract: tools.find((tool: { name: string }) => tool.name === 'automation.rules.describe').contractDigest,
        catalog: JSON.parse(text.match(/AUTOMATION_DEFINITION_DIGEST = (.*) as const;/)![1]!) };
    };
    const baseline = await generate(),catalogPath = join(scratch,files[1]!);
    const catalog = JSON.parse(await readFile(catalogPath,'utf8'));
    catalog.tools[0].description += ' Changed.';
    await writeFile(catalogPath,JSON.stringify(catalog));
    const description = await generate();
    expect(description.contract).not.toBe(baseline.contract);expect(description.catalog).not.toBe(baseline.catalog);
    catalog.$defs.EmptyInput.description = 'A changed closed input contract.';
    await writeFile(catalogPath,JSON.stringify(catalog));
    const schema = await generate();expect(schema.contract).not.toBe(description.contract);
    catalog.tools[0].effects.businessMutation = !catalog.tools[0].effects.businessMutation;
    await writeFile(catalogPath,JSON.stringify(catalog));
    const effects = await generate();expect(effects.contract).not.toBe(schema.contract);
    const originalDescription = catalog.tools[1].description;
    catalog.tools[1].description = catalog.tools[0].description;
    await writeFile(catalogPath,JSON.stringify(catalog));
    expect(spawnSync(process.execPath,[script]).status).not.toBe(0);
    catalog.tools[1].description = 'Queue adapters.status on the explicitly selected replica; current profile and scopes are required.';
    await writeFile(catalogPath,JSON.stringify(catalog));
    expect(spawnSync(process.execPath,[script]).status).not.toBe(0);
    catalog.tools[1].description = originalDescription;
    await writeFile(catalogPath,JSON.stringify(catalog));
    const setPath = join(scratch,files[2]!),sets = JSON.parse(await readFile(setPath,'utf8'));
    sets.recovery.members.push('automation.sync.status');await writeFile(setPath,JSON.stringify(sets));
    const membership = await generate();expect(membership.catalog).not.toBe(effects.catalog);expect(membership.contract).toBe(effects.contract);
    sets.recovery.members.push('automation.not_a_tool');await writeFile(setPath,JSON.stringify(sets));
    expect(spawnSync(process.execPath,[script]).status).not.toBe(0);
  } finally { await rm(scratch,{ recursive: true,force: true }); }
});

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  AUTOMATION_DISCOVERY_EXTERNAL_HELPERS,
  validateAutomationToolDiscovery,
} from '../../../scripts/automation-tool-discovery.mjs';
import { AUTOMATION_TOOL_CONTRACTS } from '../../../src/modules/mcp/automation-tool-contracts.generated.js';
import { wireToolFromDescriptor } from '../../../src/modules/mcp/application-catalog.js';

interface DiscoveryData {
  taskToolsets: string[]; keywords: string[]; prerequisites: string[]; nextSteps: string[];
  effects: string[]; dispatchClass: string; [key: string]: unknown;
}
interface CatalogTool { name: string; profile: string; description: string; discovery?: DiscoveryData }
const catalog = JSON.parse(readFileSync(new URL('../../../../../docs/automation/design/api/mcp-tool-catalog.json', import.meta.url), 'utf8')) as { tools: CatalogTool[] };
const contracts = new Map(AUTOMATION_TOOL_CONTRACTS.map(tool => [tool.name as string, tool]));
const contract = (name: string) => {
  const tool = contracts.get(name);
  if (!tool) throw new Error(`Missing expected workflow capability ${name}`);
  return tool;
};

describe('reviewed Automation discovery contracts', () => {
  test('generation requires specific descriptions and complete bounded metadata', () => {
    expect(() => validateAutomationToolDiscovery(catalog.tools)).not.toThrow();
    for (const tool of catalog.tools) {
      expect(contract(tool.name).description).toBe(tool.description);
      expect(contract(tool.name).discovery).toEqual(tool.discovery);
      expect(tool.discovery!.keywords.some(word => /[\u3400-\u9fff]/u.test(word))).toBe(true);
    }
  });

  test('the actual MCP wire projection does not preload discovery metadata', () => {
    for (const tool of AUTOMATION_TOOL_CONTRACTS) {
      const wire = wireToolFromDescriptor(tool);
      expect(Object.keys(wire)).toEqual(['name', 'description', 'inputSchema', 'outputSchema', 'annotations']);
      expect(wire).not.toHaveProperty('discovery');
      expect(wire).not.toHaveProperty('keywords');
      expect(wire).not.toHaveProperty('taskToolsets');
    }
  });

  test.each([
    ['missing metadata', (tool: CatalogTool) => { delete tool.discovery; }],
    ['generic description', (tool: CatalogTool) => { tool.description = `${tool.name}: authorized Automation operation; current profile and scopes are required.`; }],
    ['unknown task set', (tool: CatalogTool) => { tool.discovery!.taskToolsets = ['unreviewed']; }],
    ['unreviewed helper', (tool: CatalogTool) => { tool.discovery!.prerequisites = ['nodes.get']; }],
    ['wrapper recursion', (tool: CatalogTool) => { tool.discovery!.nextSteps = ['capabilities.invoke_read']; }],
    ['mixed read effects', (tool: CatalogTool) => { tool.discovery!.effects = ['read', 'provider-call']; }],
    ['unknown discovery flag', (tool: CatalogTool) => { tool.discovery!.allowAll = true; }],
    ['oversized keywords', (tool: CatalogTool) => { tool.discovery!.keywords = ['x'.repeat(65), 'other']; }],
  ])('rejects %s before generating runtime contracts', (_label, mutate) => {
    const tools = structuredClone(catalog.tools);
    mutate(tools[0]);
    expect(() => validateAutomationToolDiscovery(tools)).toThrow(/Automation discovery/);
  });

  test('preview storage and browser dispatch cannot inherit read status from annotations', () => {
    for (const name of [
      'automation.rules.preview', 'automation.runs.preview', 'automation.browser_rules.run_preview',
      'automation.adapters.status', 'automation.adapters.collections', 'automation.adapters.import_preview',
    ]) {
      const tool = contract(name);
      expect(tool.annotations.readOnlyHint).toBe(true);
      expect(tool.discovery.dispatchClass).toBe('write');
      expect(tool.discovery.effects.some(effect => effect !== 'read')).toBe(true);
    }
    expect(contract('automation.classification.preview').discovery.effects).toContain('provider-call');
    expect(contract('automation.activity.read').discovery.effects).toContain('state-write');
    expect(contract('automation.rules.validate').discovery.dispatchClass).toBe('read');
    expect(contract('automation.rules.validate').requiredScopes).toContain('automation:manage');
  });

  test('recovery hints connect the missing collection and deletion-revision steps', () => {
    expect(contract('automation.trash.restore').discovery.prerequisites).toContain('automation.trash.get');
    expect(contract('automation.trash.restore_subtree').discovery.prerequisites).toContain('automation.trash.get');
    expect(contract('automation.trash.get').discovery.prerequisites).toContain('automation.trash.list');
    expect(contract('automation.trash.list').discovery.prerequisites).toContain('collections.list');
    expect(AUTOMATION_DISCOVERY_EXTERNAL_HELPERS).toEqual(['collections.list']);
    expect(contract('automation.trash.restore').requiredScopes).toEqual(['automation:manage', 'mcp:read:own', 'nodes:write']);
  });

  test('every asynchronous browser operation points to result polling and a device selection path', () => {
    for (const tool of AUTOMATION_TOOL_CONTRACTS) {
      if (!(tool.discovery.effects as readonly string[]).includes('device-request') || tool.name.startsWith('automation.sync.')) continue;
      expect(tool.discovery.dispatchClass).toBe('write');
      expect(tool.discovery.nextSteps).toContain('automation.device_requests.get');
      expect(tool.discovery.prerequisites.length).toBeGreaterThan(0);
    }
    expect(contract('automation.device_requests.get').discovery.dispatchClass).toBe('read');
  });

  test('Worker workflows do not depend on Manager or broad node-read authority', () => {
    const workers = AUTOMATION_TOOL_CONTRACTS.filter(tool => tool.profile === 'automationWorker');
    const workerNames = new Set(workers.map(tool => tool.name as string));
    for (const worker of workers) {
      expect(worker.discovery.taskToolsets).toEqual(['worker']);
      for (const reference of [...worker.discovery.prerequisites, ...worker.discovery.nextSteps]) {
        expect(workerNames.has(reference)).toBe(true);
      }
    }
    const mixed = structuredClone(catalog.tools);
    const worker = mixed.find(tool => tool.profile === 'automationWorker');
    if (!worker) throw new Error('Missing Worker fixture');
    worker.discovery!.taskToolsets = ['worker', 'connection-admin'];
    expect(() => validateAutomationToolDiscovery(mixed)).toThrow(/dedicated worker toolset/);
  });

  test.each(['automation.rules.get', 'collections.list'])('rejects Worker workflow reference to %s at generation time', reference => {
    const tools = structuredClone(catalog.tools);
    const worker = tools.find(tool => tool.name === 'automation.jobs.get');
    if (!worker) throw new Error('Missing Worker fixture');
    worker.discovery!.prerequisites = [reference];
    expect(() => validateAutomationToolDiscovery(tools)).toThrow(/within the Worker catalog/);
  });

  test('queue reconciliation and stale-input convergence remain stateful Worker operations', () => {
    for (const name of ['automation.jobs.list', 'automation.jobs.inputs']) {
      const tool = contract(name);
      // Native hints/scopes are unchanged; compact dispatch uses the reviewed effects.
      expect(tool.annotations.readOnlyHint).toBe(true);
      expect(tool.requiredScopes).toEqual(['automation:work']);
      expect(tool.discovery.dispatchClass).toBe('write');
      expect(tool.discovery.effects).toContain('worker-state');
    }
  });
});

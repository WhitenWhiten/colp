#!/usr/bin/env node
// Size only: never print catalog payloads, credentials, or business data.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const contractFile = new URL('../src/modules/mcp/automation-tool-contracts.generated.ts', import.meta.url);
const source = await readFile(contractFile, 'utf8');
const json = source.match(/export const AUTOMATION_TOOL_CONTRACTS = (.*) as const;/s)?.[1];
if (!json) throw new Error('Cannot parse generated Automation contracts');
const contracts = JSON.parse(json);
const sizes = value => { const text = JSON.stringify(value); return { characters: text.length, utf8Bytes: Buffer.byteLength(text) }; };
const input = ({ name, description, inputSchema }) => ({ name, description, inputSchema });
const full = ({ name, description, inputSchema, outputSchema, annotations }) => ({ name, description, inputSchema, outputSchema, annotations });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const summarize = tools => ({ count: tools.length, input: sizes(tools.map(input)), full: sizes(tools.map(full)),
  definitionDigest: digest(tools.map(full)), largestInputs: tools.map(t => ({ name: t.name, ...sizes(t.inputSchema) })).sort((a,b) => b.utf8Bytes-a.utf8Bytes).slice(0,10),
  largestOutputs: tools.filter(t => t.outputSchema).map(t => ({ name: t.name, ...sizes(t.outputSchema) })).sort((a,b) => b.utf8Bytes-a.utf8Bytes).slice(0,10),
  capabilities: tools.map(t => ({ name: t.name, input: sizes(t.inputSchema), output: t.outputSchema ? sizes(t.outputSchema) : null,
    contractDigest: t.contractDigest ?? null })) });
let commit = 'unknown';
try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* not a checkout */ }
if (args.includes('--static')) {
  console.log(JSON.stringify({ kind: 'static contracts; not actual model loading', commit, node: process.version,
    tokenEstimate: null, tokenizer: null, providerUsage: null,
    automation: summarize(contracts), manager: summarize(contracts.filter(t => t.profile === 'automationManager')),
    worker: summarize(contracts.filter(t => t.profile === 'automationWorker')) }, null, 2));
} else if (option('--catalog')) {
  const raw = JSON.parse(await readFile(option('--catalog'), 'utf8'));
  const tools = Array.isArray(raw) ? raw : raw.tools ?? raw.result?.tools;
  if (!Array.isArray(tools) || tools.some(t => typeof t.name !== 'string' || !t.inputSchema)) throw new Error('Expected a tools/list result or tool array');
  console.log(JSON.stringify({ kind: 'captured authorized MCP catalog; not actual model loading', commit, node: process.version,
    endpoint: option('--endpoint') ?? 'unspecified', identityCategory: option('--identity') ?? 'unspecified',
    catalogs: option('--catalogs') ?? 'unspecified', scopes: option('--scopes') ?? 'unspecified',
    selection: option('--selection') ?? 'omitted', tokenEstimate: null, tokenizer: null, providerUsage: null, catalog: summarize(tools) }, null, 2));
} else {
  console.error('Usage: node scripts/measure-mcp-context.mjs --static | --catalog sanitized-tools-list.json --endpoint LABEL --identity CATEGORY --catalogs LIST --scopes LIST [--selection LIST]');
  process.exitCode = 2;
}

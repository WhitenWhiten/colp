import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { auditCatalog, auditTrace, measureJson, readGeneratedContracts, TRACE_FORMAT } from '../lib/mcp-context-audit.mjs';

const tool = { name: 'example.read', profile: 'manager', description: 'Inspect a selected item.', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, annotations: { readOnlyHint: true }, discovery: { keywords: ['private-index-only'] } };

test('catalog measures wire/input projections without exposing index metadata or pretending bytes are tokens', () => {
  const report = auditCatalog([tool]);
  assert.equal(report.all.toolCount, 1);
  assert.equal(report.all.inputDefinitions.characters, JSON.stringify([{ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }]).length);
  assert.equal(report.all.wireDefinitions.tokens, null);
  assert.equal(report.modelContextObserved, false);
  assert.ok(report.all.wireDefinitions.characters > report.all.inputDefinitions.characters);
  assert.ok(measureJson('恢复').utf8Bytes > measureJson('恢复').characters);
  assert.deepEqual(measureJson('😀'), { characters: 4, utf8Bytes: 6, tokens: null });
});

test('declaring deferred tools alone is not evidence they entered model context', () => {
  const report = auditTrace({ format: TRACE_FORMAT, turns: [{ declaredTools: [{ type: 'mcp', defer_loading: true }], usage: { inputTokens: 120, cachedInputTokens: 80 } }] });
  assert.equal(report.modelContextObserved, false);
  assert.equal(report.modelDefinitionTokensObserved, false);
  assert.equal(report.turns[0].activeDefinitions, null);
  assert.equal(report.turns[0].usage.cachedInputTokens, 80);
});

test('active snapshots can shrink and raw prompts/results never appear in audit output', () => {
  const secret = 'sensitive-bookmark-and-argument';
  const report = auditTrace({ format: TRACE_FORMAT, turns: [
    { activeDefinitions: [tool, { ...tool, name: 'example.write' }], toolResults: [{ content: secret }], observedDefinitionTokens: 48, completed: false },
    { activeDefinitions: [tool], newlyLoadedDefinitions: [], usage: { inputTokens: 64 }, completed: true },
  ] });
  assert.equal(report.modelContextObserved, true);
  assert.equal(report.turns[1].activeDefinitions.count, 1);
  assert.equal(report.turns[1].newlyLoadedDefinitions.count, 0);
  assert.equal(report.turns[1].observedDefinitionTokens, null);
  assert.equal(JSON.stringify(report).includes(secret), false);
});

test('missing observations remain unknown and invalid counters fail closed', () => {
  assert.equal(auditTrace({ format: TRACE_FORMAT, turns: [{}] }).turns[0].completed, null);
  const empty = auditTrace({ format: TRACE_FORMAT, turns: [{ activeDefinitions: [] }] });
  assert.equal(empty.modelContextObserved, true);
  assert.deepEqual(empty.turns[0].activeDefinitions, { count: 0, characters: 2, utf8Bytes: 2, tokens: null });
  assert.throws(() => auditTrace({ format: TRACE_FORMAT, turns: [{ usage: { inputTokens: -1 } }] }));
  assert.throws(() => auditTrace({ format: TRACE_FORMAT, turns: [{ usage: { inputTokens: 1, cachedInputTokens: 2 } }] }));
  assert.throws(() => auditTrace({ format: TRACE_FORMAT, turns: [{ activeDefinitions: {} }] }));
  assert.throws(() => auditTrace({ format: 'invented', turns: [] }));
});

test('generated contracts are parsed as JSON without evaluating source', () => {
  assert.deepEqual(readGeneratedContracts(`// header\nexport const AUTOMATION_TOOL_CONTRACTS = ${JSON.stringify([tool])} as const;\n`), [tool]);
  assert.throws(() => readGeneratedContracts('throw new Error("must not execute");'));
});

test('CLI failures do not expose malformed trace fragments or private paths', async () => {
  const secret = 'sensitive-trace-sentinel';
  const directory = await mkdtemp(join(tmpdir(), 'colp-context-audit-'));
  const tracePath = join(directory, secret + '.json');
  const cli = fileURLToPath(new URL('../mcp-context-audit.mjs', import.meta.url));
  try {
    await writeFile(tracePath, '{"private":"' + secret + '","turns":invalid}');
    for (const file of [tracePath, tracePath + '.missing']) {
      const result = spawnSync(process.execPath, [cli, '--trace', file], { encoding: 'utf8' });
      assert.ifError(result.error);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /^MCP context audit failed\./);
      assert.equal(result.stderr.includes(secret), false);
      assert.equal(result.stderr.includes(directory), false);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'vitest';
import {
  MCP_WRITE_ACCEPTANCE_NEGATIVE_CONTROL_MODE,
  MCP_WRITE_NEGATIVE_CONTROL_IDS,
  assertMcpWriteProductionBindingsAt,
  digestMcpWriteBindingsAt,
  exerciseMcpWriteTemporarySourceControl,
  runMcpWriteSourceNegativeControls,
} from '../../../scripts/phase4b-mcp-write-acceptance-bindings.mjs';

const backendRoot = resolve(import.meta.dirname, '../../..');
const repositoryRoot = resolve(backendRoot, '..');
const bindingsPath = resolve(backendRoot, 'scripts/phase4b-mcp-write-acceptance-bindings.mjs');

test('MCP Write bindings freeze temporary-source mode and the write-approval catalog', () => {
  assert.equal(MCP_WRITE_ACCEPTANCE_NEGATIVE_CONTROL_MODE, 'real-temporary-source-corruption');
  assert.deepEqual([...MCP_WRITE_NEGATIVE_CONTROL_IDS], [
    'missing-authorization-recheck',
    'missing-idempotency-key-scope',
    'missing-mcp-write-route',
    'missing-mcp-write-port',
    'missing-mcp-write-migration',
    'drifted-mcp-write-bindings',
  ]);
  assertMcpWriteProductionBindingsAt(repositoryRoot);
  const startDigest = digestMcpWriteBindingsAt(repositoryRoot);
  const bindings = readFileSync(bindingsPath, 'utf8');
  assert.match(bindings, /real-temporary-source-corruption/u);
  assert.match(bindings, /exerciseMcpWriteTemporarySourceControl/u);
  assert.match(bindings, /isVisible/u);
  assert.match(bindings, /authorizeAuthoritativeCapability/u);
  assert.match(bindings, /principal_id.*command_scope.*command_id/u);
  assert.match(bindings, /registerMcpWriteApprovalRoutes/u);
  assert.match(bindings, /202608051000_mcp_write_change_plans/u);
  assert.doesNotMatch(bindings, /injectFault|empty-string override|manual Boolean/iu);
  assert.equal(digestMcpWriteBindingsAt(repositoryRoot), startDigest);
});

test('MCP Write temporary-source controls fail closed at owned write-approval boundaries', async () => {
  const startDigest = digestMcpWriteBindingsAt(repositoryRoot);
  for (const fault of MCP_WRITE_NEGATIVE_CONTROL_IDS) {
    await assert.rejects(
      () => exerciseMcpWriteTemporarySourceControl(fault, { sourceRoot: repositoryRoot }),
      (error: unknown) => error instanceof Error && error.message === fault,
    );
  }
  assert.equal(digestMcpWriteBindingsAt(repositoryRoot), startDigest);
});

test('MCP Write source-control runner emits executed fail-closed observations', async () => {
  const startDigest = digestMcpWriteBindingsAt(repositoryRoot);
  const controls = await runMcpWriteSourceNegativeControls({ sourceRoot: repositoryRoot });
  assert.equal(controls.length, MCP_WRITE_NEGATIVE_CONTROL_IDS.length);
  assert.deepEqual(controls.map((control) => control.id), [...MCP_WRITE_NEGATIVE_CONTROL_IDS]);
  assert.equal(controls.every((control) => control.outcome === 'failed_closed'), true);
  assert.equal(controls.every((control) => control.injection.startsWith('temporary-source ')), true);
  assert.equal(controls.every((control) => /^[0-9a-f]{64}$/u.test(control.observationDigest)), true);
  assert.equal(digestMcpWriteBindingsAt(repositoryRoot), startDigest);
});

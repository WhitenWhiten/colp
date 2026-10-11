import assert from 'node:assert/strict';
import { test } from 'vitest';
import { Mcp20260728RequestError, McpChangePlanError } from '@know-n/colp/mcp';
import { rethrowPhase4bMcpWriteAdapterError } from '../../../src/modules/mcp/index.js';

function rethrown(error: unknown): unknown {
  try {
    rethrowPhase4bMcpWriteAdapterError(error);
  } catch (caught) {
    return caught;
  }
  assert.fail('rethrowPhase4bMcpWriteAdapterError must throw');
}

test('a stale Change Plan tells the agent the collection changed and to plan again', () => {
  const error = rethrown(new Mcp20260728RequestError('invalid_params', 'MCP write operation rejected.', { code: 'revision_drift' }));
  assert.ok(error instanceof Mcp20260728RequestError);
  assert.equal(error.kind, 'invalid_params');
  assert.match(error.message, /collection changed after this plan was made/u);
  assert.deepEqual(error.data, { code: 'revision_drift' });
});

test('an unapproved Change Plan says the owner has not approved it yet', () => {
  const error = rethrown(new Mcp20260728RequestError('invalid_params', 'MCP write operation rejected.', { code: 'plan_not_approved' }));
  assert.match((error as Error).message, /owner has not approved this plan yet/u);
});

test('host and SDK impact rejections explain the history limit without exposing dependency messages', () => {
  const errors = [
    new McpChangePlanError('impact_exceeded', 'private dependency details'),
    new Mcp20260728RequestError('invalid_params', 'MCP write operation rejected.', { code: 'impact_exceeded' }),
  ].map(rethrown);
  for (const error of errors) {
    assert.ok(error instanceof Mcp20260728RequestError);
    assert.equal(error.kind, 'invalid_params');
    assert.deepEqual(error.data, { code: 'impact_exceeded' });
    assert.match(error.message, /2000 live folders and bookmarks/u);
    assert.match(error.message, /Nothing was changed/u);
    assert.doesNotMatch(error.message, /private dependency details/u);
  }
  assert.equal((errors[0] as Error).message, (errors[1] as Error).message);
});

test('unknown codes and other messages pass through unchanged', () => {
  const unknown = new Mcp20260728RequestError('invalid_params', 'MCP write operation rejected.', { code: 'digest_mismatch' });
  assert.equal(rethrown(unknown), unknown);
  const other = new Mcp20260728RequestError('invalid_params', 'Invalid MCP write Tool arguments.', { code: 'revision_drift' });
  assert.equal(rethrown(other), other);
  const internal = rethrown(new Mcp20260728RequestError('internal_error', 'boom'));
  assert.equal((internal as Error).message, 'Internal error');
});

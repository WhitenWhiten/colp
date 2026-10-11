import assert from 'node:assert/strict';
import { test } from 'vitest';
import { Mcp20260728RequestError } from '@know-n/colp/mcp';
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

test('unknown codes and other messages pass through unchanged', () => {
  const unknown = new Mcp20260728RequestError('invalid_params', 'MCP write operation rejected.', { code: 'digest_mismatch' });
  assert.equal(rethrown(unknown), unknown);
  const other = new Mcp20260728RequestError('invalid_params', 'Invalid MCP write Tool arguments.', { code: 'revision_drift' });
  assert.equal(rethrown(other), other);
  const internal = rethrown(new Mcp20260728RequestError('internal_error', 'boom'));
  assert.equal((internal as Error).message, 'Internal error');
});

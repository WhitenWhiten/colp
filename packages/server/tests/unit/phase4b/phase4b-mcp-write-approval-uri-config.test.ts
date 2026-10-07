import assert from 'node:assert/strict';
import { test } from 'vitest';
import { loadMcpWriteFeatureConfig } from '../../../src/bootstrap/config-mcp.js';

const REQUEST_STATE_KEY = Buffer.alloc(32, 77).toString('base64');
const PRODUCT_ORIGIN = 'https://app.example.test';
const DEFAULT_APPROVAL_BASE_URI = `${PRODUCT_ORIGIN}/approvals`;

function writeEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    MCP_WRITE_REQUEST_STATE_KEY: REQUEST_STATE_KEY,
    ...overrides,
  };
}

test('empty MCP_WRITE_APPROVAL_BASE_URI falls back to the product approvals path', () => {
  const unset = loadMcpWriteFeatureConfig(writeEnv(), 'test', PRODUCT_ORIGIN);
  assert.equal(unset.approvalBaseUri, DEFAULT_APPROVAL_BASE_URI);

  const empty = loadMcpWriteFeatureConfig(
    writeEnv({ MCP_WRITE_APPROVAL_BASE_URI: '' }),
    'test',
    PRODUCT_ORIGIN,
  );
  assert.equal(empty.approvalBaseUri, DEFAULT_APPROVAL_BASE_URI);

  const whitespace = loadMcpWriteFeatureConfig(
    writeEnv({ MCP_WRITE_APPROVAL_BASE_URI: '   ' }),
    'test',
    PRODUCT_ORIGIN,
  );
  assert.equal(whitespace.approvalBaseUri, DEFAULT_APPROVAL_BASE_URI);
});

test('explicit MCP_WRITE_APPROVAL_BASE_URI accepts an external browser approval UI', () => {
  const externalApprovalUi = 'https://approve.example/tenant/review';
  const explicit = loadMcpWriteFeatureConfig(
    writeEnv({ MCP_WRITE_APPROVAL_BASE_URI: externalApprovalUi }),
    'test',
    PRODUCT_ORIGIN,
  );
  assert.equal(explicit.approvalBaseUri, externalApprovalUi);

  assert.throws(
    () => loadMcpWriteFeatureConfig(
      writeEnv({ MCP_WRITE_APPROVAL_BASE_URI: 'not-a-url' }),
      'test',
      PRODUCT_ORIGIN,
    ),
    /absolute HTTP\(S\) URL/u,
  );
  assert.throws(
    () => loadMcpWriteFeatureConfig(
      writeEnv({ MCP_WRITE_APPROVAL_BASE_URI: `${DEFAULT_APPROVAL_BASE_URI}?next=/` }),
      'test',
      PRODUCT_ORIGIN,
    ),
    /exact HTTP\(S\) origin path/u,
  );
});

test('MCP_WRITE_APPROVAL_BASE_URI rejects the product JSON API namespace', () => {
  for (const apiUri of [
    'https://app.example.test/api',
    'https://app.example.test/api/v1/mcp/approvals',
  ]) {
    assert.throws(
      () => loadMcpWriteFeatureConfig(
        writeEnv({ MCP_WRITE_APPROVAL_BASE_URI: apiUri }),
        'test',
        PRODUCT_ORIGIN,
      ),
      /browser approval UI outside the \/api JSON namespace/u,
    );
  }
});

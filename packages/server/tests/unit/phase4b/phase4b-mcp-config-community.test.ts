import assert from 'node:assert/strict';
import { test } from 'vitest';
import { loadMcpReadFeatureConfig } from '../../../src/bootstrap/config-mcp.js';
import {
  PHASE4B_MCP_CONFIG_SERVER_UUID as SERVER_UUID,
  phase4bMcpOnEnv as onEnv,
} from '../../support/phase4b-mcp-config-env.js';

test('community MCP compat tools require product:read and product:write scopes', () => {
  for (const scopes of ['mcp:read:public', 'mcp:read:public,product:read']) {
    assert.throws(
      () => loadMcpReadFeatureConfig(
        onEnv({ MCP_OAUTH_SCOPES: scopes }),
        'test',
        'https://collections.example.test',
        SERVER_UUID,
        { communityEnabled: true },
      ),
      /product:read and product:write/u,
    );
  }
  const config = loadMcpReadFeatureConfig(
    onEnv({ MCP_OAUTH_SCOPES: 'mcp:read:public,product:read,product:write' }),
    'test',
    'https://collections.example.test',
    SERVER_UUID,
    { communityEnabled: true },
  );
  assert.ok(config);
  assert.deepEqual(
    config.oauth.scopes,
    ['mcp:read:public', 'product:read', 'product:write'],
  );
});

test('community compat adapters require the contract output budget floor', () => {
  assert.throws(
    () => loadMcpReadFeatureConfig(
      onEnv({
        MCP_OAUTH_SCOPES: 'product:read,product:write',
        MCP_OUTPUT_MAX_BYTES: '262143',
      }),
      'test',
      'https://collections.example.test',
      SERVER_UUID,
      { communityEnabled: true },
    ),
    /MCP_OUTPUT_MAX_BYTES of at least 262144/u,
  );
  const config = loadMcpReadFeatureConfig(
    onEnv({
      MCP_OAUTH_SCOPES: 'product:read,product:write',
      MCP_OUTPUT_MAX_BYTES: '262144',
    }),
    'test',
    'https://collections.example.test',
    SERVER_UUID,
    { communityEnabled: true },
  );
  assert.ok(config);
  assert.equal(config.budgets.output.maxBytes, 262_144);
});

test('the supported-scope capacity is 32 entries', () => {
  const thirtyTwo = Array.from({ length: 32 }, (_, index) => `scope:${index}`).join(',');
  const config = loadMcpReadFeatureConfig(
    onEnv({ MCP_OAUTH_SCOPES: thirtyTwo }),
    'test',
    'https://collections.example.test',
    SERVER_UUID,
  );
  assert.ok(config);
  assert.equal(config.oauth.scopes.length, 32);
  const thirtyThree = Array.from({ length: 33 }, (_, index) => `scope:${index}`).join(',');
  assert.throws(
    () => loadMcpReadFeatureConfig(
      onEnv({ MCP_OAUTH_SCOPES: thirtyThree }),
      'test',
      'https://collections.example.test',
      SERVER_UUID,
    ),
    /at most 32 scopes/u,
  );
});

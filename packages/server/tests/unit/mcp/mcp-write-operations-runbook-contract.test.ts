import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';

test('MCP-W09 runbook and focused package scripts are exact', async () => {
  const [doc, packageText] = await Promise.all([
    readFile(new URL('../../../docs/runbooks/mcp-write-operations.md', import.meta.url), 'utf8'),
    readFile(new URL('../../../package.json', import.meta.url), 'utf8'),
  ]);
  const packageJson = JSON.parse(packageText) as { readonly scripts: Readonly<Record<string, string>> };
  assert.equal(
    packageJson.scripts['test:mcp:write-operations:unit:inner'],
    'vitest run --fileParallelism=false --project unit tests/unit/phase4b/phase4b-mcp-write-operations.test.ts tests/unit/phase4b/phase4b-mcp-write-operations-route.test.ts tests/unit/phase4b/phase4b-mcp-write-maintenance.test.ts tests/unit/mcp/mcp-write-operations-runbook-contract.test.ts',
  );
  assert.equal(
    packageJson.scripts['test:mcp:write-operations:unit'],
    'npm run test:mcp:write-operations:unit:inner',
  );
  assert.equal(
    packageJson.scripts['test:mcp:write-operations:postgres:inner'],
    'vitest run --fileParallelism=false --project postgres tests/integration/postgres/postgres-phase4b-mcp-write-operations.integration.test.ts',
  );
  assert.equal(
    packageJson.scripts['test:mcp:write-operations:postgres'],
    'node scripts/with-postgres.mjs -- npm run test:mcp:write-operations:postgres:inner',
  );
  assert.equal(
    packageJson.scripts['test:mcp:write-operations'],
    'npm run test:mcp:write-operations:unit && npm run test:mcp:write-operations:postgres',
  );

  for (const token of [
    'waiting for user',
    'expired',
    'retrying',
    'concurrent commit',
    'unknown outcome',
    'permanently failed',
    '/ready/features/mcp-write',
    '/ready/features/mcp',
    'mcp_write_waiting_for_user',
    'mcp_write_expired',
    'mcp_write_retry_backlog',
    'mcp_write_concurrent_commit',
    'mcp_write_unknown_outcome',
    'mcp_write_permanent_failure',
    'mcp_write_disabled',
    'N/N-1',
    'rollback',
    'drill',
  ]) {
    assert.match(doc, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'iu'), token);
  }
  assert.doesNotMatch(doc, /sessionId|session_id|Bearer |password|apiKey|raw error|stack trace/iu);
});

test('MCP-W09 Write operations exposure defaults off and rejects malformed flags', () => {
  const base = { DATABASE_URL: 'postgresql://known:known@127.0.0.1:5432/known',
    OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs' };
  assert.equal(loadConfig(base).mcpWriteEnabled, false);
  assert.equal(loadConfig({ ...base, KNOWN_FEATURE_MCP_WRITE: 'true' }).mcpWriteEnabled, true);
  assert.throws(
    () => loadConfig({ ...base, KNOWN_FEATURE_MCP_WRITE: 'yes' }),
    /KNOWN_FEATURE_MCP_WRITE must be true or false/u,
  );
});

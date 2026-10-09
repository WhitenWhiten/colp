import assert from 'node:assert/strict';
import { test } from 'vitest';
import { DEFAULT_MCP_RESOURCE_READ_BUDGET } from '@know-n/colp/mcp';
import { createMcpApplicationContext } from '../../../src/modules/mcp/application-context.js';
import { searchPrincipalFromMcpContext } from '../../../src/modules/mcp/nodes-search.js';

function context(scopes: readonly string[]) {
  return createMcpApplicationContext({
    principal: Object.freeze({
      kind: 'authenticated' as const,
      principalId: 'account-member',
      clientId: 'client-1',
      credentialBindingId: 'binding-1',
      resourceAudience: 'https://known.test/mcp',
      securityEpoch: 'epoch-1',
    }),
    scopes,
    abortSignal: new AbortController().signal,
    budgets: DEFAULT_MCP_RESOURCE_READ_BUDGET,
    correlationId: 'nodes-search-scope-test',
    authorization: Object.freeze({ accountSubjectId: 'subject-member' }),
  });
}

test('public-only nodes.search uses the anonymous visibility principal', () => {
  assert.deepEqual(
    searchPrincipalFromMcpContext(context(['mcp:read:public', 'nodes:read'])),
    { kind: 'anonymous' },
  );
});

test('nodes.search keeps the account principal only with the own-read grant', () => {
  assert.deepEqual(
    searchPrincipalFromMcpContext(context(['mcp:read:public', 'mcp:read:own', 'nodes:read'])),
    {
      kind: 'account',
      accountId: 'account-member',
      principalId: 'account-member',
      subjectId: 'subject-member',
      securityEpoch: 'epoch-1',
    },
  );
});

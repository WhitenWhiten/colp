import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createAuthenticatedBinding } from '@know-n/colp/mcp';
import { createStaticMcpToolLookup } from '../../../src/modules/mcp/static-tool-lookup.js';
import { createPhase4bMcpRequestContext } from '../../../src/modules/mcp/request-context.js';

function context(scope: readonly string[], signal = new AbortController().signal, clientId = 'client') {
  return createPhase4bMcpRequestContext({
    headers: [{ name: 'MCP-Protocol-Version', value: '2026-07-28' }, { name: 'Mcp-Method', value: 'tools/list' }],
    body: { method: 'tools/list', params: { _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {},
    } } },
    binding: createAuthenticatedBinding({ credentialKind: 'oauth', principalId: 'owner', clientId,
      credentialBindingId: `credential-${clientId}`, resourceAudience: 'https://example.test/mcp', securityEpoch: '1' }),
    scope,
    abortSignal: signal,
  });
}

function fixture(header = 'X-Collection-Id') {
  let builds = 0;
  let projections = 0;
  const tools = ['nodes.create', 'changes.commit'].map((name) => Object.freeze({
    name, inputSchema: Object.freeze({ type: 'object', properties: Object.freeze({
      collectionId: Object.freeze({ type: 'string', 'x-mcp-header': header }),
    }) }),
  }));
  const catalog = createStaticMcpToolLookup(async (request) => {
    builds += 1;
    return Object.freeze({ resultType: 'complete' as const,
      tools: tools.filter((tool) => request.scope.includes(tool.name)),
    });
  }, (request, name) => tools.some((tool) => tool.name === name) && request.scope.includes(name), (tool) => {
    projections += 1;
    return tool;
  });
  return { catalog, builds: () => builds, projections: () => projections };
}

test('static definitions are indexed once and warmed lookups do not rebuild the catalog', async () => {
  const { catalog, builds, projections } = fixture();
  const request = context(['nodes.create', 'changes.commit']);
  const [first, concurrent] = await Promise.all([
    catalog.getTool(request, 'nodes.create'), catalog.getTool(request, 'nodes.create'),
  ]);
  assert.equal(first, concurrent);
  assert.equal(projections(), 2, 'concurrent fills must project each definition only once');
  const warmedBuilds = builds();
  for (let index = 0; index < 10; index += 1) {
    assert.equal(await catalog.getTool(request, 'nodes.create'), first);
    assert.ok(await catalog.getTool(request, 'changes.commit'));
  }
  assert.equal(builds(), warmedBuilds);
  const listed = await catalog.listTools(request);
  assert.equal((listed.tools as unknown[])[0], first, 'explicit lists reuse projected definitions');
  assert.equal(projections(), 2);
});

test('cached definitions never cache permissions or catalogs across clients', async () => {
  const { catalog, builds } = fixture();
  const owner = context(['nodes.create', 'changes.commit']);
  await catalog.listTools(owner);
  const other = context(['nodes.create'], undefined, 'other-client');
  assert.ok(await catalog.getTool(other, 'nodes.create'));
  assert.equal(await catalog.getTool(other, 'changes.commit'), undefined);
  assert.equal(await catalog.getTool(context([]), 'nodes.create'), undefined);
  assert.equal(await catalog.getTool(owner, 'unknown.tool'), undefined);
  assert.equal(builds(), 1, 'hidden and unknown tools must not trigger a directory build');
  assert.deepEqual((await catalog.listTools(other)).tools, [await catalog.getTool(other, 'nodes.create')]);
});

test('a tool not seen under earlier scopes is loaded when newly granted', async () => {
  const { catalog, builds } = fixture();
  await catalog.getTool(context(['nodes.create']), 'nodes.create');
  assert.ok(await catalog.getTool(context(['changes.commit']), 'changes.commit'));
  assert.equal(builds(), 2);
  assert.ok(await catalog.getTool(context(['nodes.create']), 'nodes.create'));
  assert.equal(builds(), 2);
});

test('cached lookups still honor cancellation and a new adapter owns its own schema', async () => {
  const { catalog } = fixture();
  await catalog.getTool(context(['nodes.create']), 'nodes.create');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(catalog.getTool(context(['nodes.create'], controller.signal), 'nodes.create'), { name: 'AbortError' });
  const replacement = fixture('X-New-Collection-Id').catalog;
  const changed = await replacement.getTool(context(['nodes.create']), 'nodes.create');
  const schema = changed!.inputSchema as { properties: { collectionId: Record<string, unknown> } };
  assert.equal(schema.properties.collectionId['x-mcp-header'], 'X-New-Collection-Id');
});

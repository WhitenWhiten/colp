import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  CATALOG_INPUT,
  CONTEXT,
  REQUEST,
  createService,
  createdResult,
} from '../../support/phase4b-mcp-low-risk-node-create-fixture.js';

function inheritRequest() {
  return Object.freeze({
    ...REQUEST,
    input: Object.freeze({
      ...CATALOG_INPUT,
      node: Object.freeze({
        ...CATALOG_INPUT.node,
        visibility: 'inherit' as const,
      }),
    }),
  });
}

test('MCP-W04 inherit create on public or unlisted collections stores the node as private', async () => {
  for (const collectionVisibility of ['public', 'unlisted'] as const) {
    const { service: createServiceUnderTest, probe } = createService(createdResult(), {
      collectionVisibility,
      inspect: false,
    });
    const output = await createServiceUnderTest.execute(inheritRequest(), CONTEXT);
    assert.equal(output.resultType, 'complete', collectionVisibility);
    assert.equal(output.appliedVisibility, 'private', collectionVisibility);
    assert.ok(probe.canonicalExecuteCalls >= 1, collectionVisibility);
  }
});

test('MCP-W04 still auto-applies inherit create on private or protected collections', async () => {
  for (const collectionVisibility of ['private', 'protected'] as const) {
    const { service: createServiceUnderTest, probe } = createService(createdResult(), {
      collectionVisibility,
      inspect: false,
    });
    const output = await createServiceUnderTest.execute(inheritRequest(), CONTEXT);
    assert.equal(output.resultType, 'complete', collectionVisibility);
    assert.ok(probe.canonicalExecuteCalls >= 1, collectionVisibility);
  }
});

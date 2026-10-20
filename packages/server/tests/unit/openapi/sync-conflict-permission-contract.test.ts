import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { backendRoot, readDocument, type UnknownRecord } from './openapi-contract-support.js';

test('both current Product contracts represent a retained conflict with no executable resolution and a typed reason', () => {
  const ajv = new Ajv2020({ strict: false });
  for (const document of [readDocument(), readDocument(join(backendRoot, 'openapi/colp-server-v1.yaml'))]) {
    const properties = document.components.schemas.SyncConflictSummary!.properties as UnknownRecord;
    const menu = ajv.compile(properties.allowedResolutions as object);
    assert.equal(menu([]), true);
    assert.equal(menu(['server']), true);
    assert.equal(menu(['server', 'server']), false);
    const reason = ajv.compile(properties.resolutionBlockedReason as object);
    assert.equal(reason('node_read_only'), true);
    assert.equal(reason('resource_not_found'), true);
    assert.equal(reason('anything_else'), false);
  }
  const old = readDocument(join(backendRoot, 'openapi/baselines/product-v1.1.99.0.yaml'));
  const previous = old.components.schemas.SyncConflictSummary!.properties as UnknownRecord;
  assert.equal(ajv.compile(previous.allowedResolutions as object)([]), false,
    'the versioned prior contract remains unchanged');
});

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { backendRoot, readDocument, type UnknownRecord } from './openapi-contract-support.js';

test('the current Product contract accepts exact empty bookmark titles while the frozen old response rejects them', () => {
  const current = readDocument();
  const old = readDocument(join(backendRoot, 'openapi/baselines/product-v1.1.98.0.yaml'));
  const ajv = new Ajv2020({ strict: false });
  for (const name of ['BookmarkNodeView', 'BookmarkCreate', 'NodeMergePatch']) {
    const properties = current.components.schemas[name]!.properties as UnknownRecord;
    const validate = ajv.compile(properties.title as object);
    assert.equal(validate(''), true, `${name} must preserve an empty title`);
    assert.equal(validate(null), false);
    assert.equal(validate('x'.repeat(513)), false);
  }
  for (const name of ['FolderNodeView', 'FolderCreate']) {
    const properties = current.components.schemas[name]!.properties as UnknownRecord;
    assert.equal(ajv.compile(properties.title as object)(''), false, `${name} remains named`);
  }
  const oldProperties = old.components.schemas.BookmarkNodeView!.properties as UnknownRecord;
  assert.equal(ajv.compile(oldProperties.title as object)(''), false);
});

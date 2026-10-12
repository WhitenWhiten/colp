import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const installed = resolve(root, 'node_modules/@know-n/colp/package.json');
const protocolPackage = installed;
const protocolRequire = createRequire(protocolPackage);
const { collectionProtocolSchema, collectionProtocolSchemaV02, createAjv } = protocolRequire('@know-n/colp/schema');
const standaloneCode = protocolRequire('ajv/dist/standalone/index.js').default;
const ajv = createAjv({ code: { source: true, esm: true, optimize: true }, allErrors: true });
ajv.addSchema(collectionProtocolSchema, collectionProtocolSchema.$id);
const definition = (name) => {
  const id = `https://known.example/extension/generated/${name}`;
  ajv.addSchema({ $id: id, $ref: `${collectionProtocolSchema.$id}#/$defs/${name}` }, id);
  return id;
};
const standalone = standaloneCode(ajv, {
  operation: definition('operation'),
  createNodeOperationPayload: definition('createNodeOperationPayload'),
  nodeContentUpdateOperationPayload: definition('nodeContentUpdateOperationPayload'),
  moveOperationPayload: definition('moveOperationPayload'),
  deleteOperationPayload: definition('deleteOperationPayload'),
});
// ajv-formats exposes `uri` as a function, while Ajv's overwritten-format standalone reference treats it as
// a FormatDefinition object. Normalize that known source reference without weakening format validation.
const generated = `${standalone.replaceAll('formats0.validate(', 'formats0(')}\n`;
const output = resolve(root, 'src/generated/bookmark-operation-validators.js');
const importPreviewGenerated = `${standaloneCode(ajv, {
  bookmarkUrl: definition('bookmarkUrl'), conversionPreview: definition('conversionPreview'),
}).replaceAll('formats0.validate(', 'formats0(')}\n`;
const importPreviewOutput = resolve(root, 'src/generated/import-preview-validators.js');
const pullAjv = createAjv({ code: { source: true, esm: true, optimize: true }, allErrors: true });
pullAjv.addSchema(collectionProtocolSchema, collectionProtocolSchema.$id);
pullAjv.addSchema(collectionProtocolSchemaV02, collectionProtocolSchemaV02.$id);
const pullDefinition = (name) => {
  const id = `https://known.example/extension/generated/${name}`;
  pullAjv.addSchema({ $id: id, $ref: `${collectionProtocolSchemaV02.$id}#/$defs/${name}` }, id); return id;
};
const pullBaseDefinition = (name) => {
  const id = `https://known.example/extension/generated/${name}`;
  pullAjv.addSchema({ $id: id, $ref: `${collectionProtocolSchema.$id}#/$defs/${name}` }, id); return id;
};
const pullGenerated = `${standaloneCode(pullAjv, {
  syncPullV02: pullDefinition('syncPullV02'), syncSnapshotV02: pullDefinition('syncSnapshotV02'),
  authoritativeEffectPage: pullDefinition('authoritativeEffectPage'),
  syncAckResult: pullBaseDefinition('syncAckResult'),
}).replaceAll('formats0.validate(', 'formats0(')}\n`;
const pullOutput = resolve(root, 'src/generated/pull-effect-validators.js');
if (process.argv.includes('--check')) {
  const existing = await readFile(output, 'utf8').catch(() => '');
  assert.equal(existing, generated, 'bookmark Operation validators do not match the public COLP schema');
  const existingPull = await readFile(pullOutput, 'utf8').catch(() => '');
  assert.equal(existingPull, pullGenerated, 'Pull effect validators do not match the public COLP 0.2 schema');
  const existingImportPreview = await readFile(importPreviewOutput, 'utf8').catch(() => '');
  assert.equal(existingImportPreview, importPreviewGenerated, 'import preview validators do not match the public COLP schema');
} else {
  await mkdir(dirname(output), { recursive: true }); await writeFile(output, generated); await writeFile(pullOutput, pullGenerated);
  await writeFile(importPreviewOutput, importPreviewGenerated);
}

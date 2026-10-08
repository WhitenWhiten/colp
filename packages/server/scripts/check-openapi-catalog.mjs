import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDocument, resolveLocalRef } from './openapi-utils.mjs';

const file = process.argv[2] ?? 'openapi/product-v1.yaml';
const document = await readDocument(file);
const methods = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(
  path.join(repositoryRoot, 'generated/openapi/product-v1.routes.json'),
  'utf8',
));
const expected = new Map(manifest.map((route) => [
  `${route.method} ${route.path}`,
  route.operationId,
]));
const errors = [];

const generatedBundle = await readDocument(
  path.join(repositoryRoot, 'generated/openapi/product-v1.bundle.yaml'),
);
if (document.info?.version !== generatedBundle.info?.version) {
  errors.push(
    `info.version must match openapi:drift generated bundle ${generatedBundle.info?.version ?? '<missing>'}, got ${document.info?.version ?? '<missing>'}`,
  );
}
if (document.openapi !== '3.1.0') {
  errors.push(`OpenAPI version must be 3.1.0, got ${document.openapi ?? '<missing>'}`);
}

const actual = new Map();
const operationIds = new Set();
for (const [route, pathItem] of Object.entries(document.paths ?? {})) {
  for (const [method, operation] of Object.entries(pathItem ?? {})) {
    if (!methods.has(method)) continue;
    const key = `${method.toUpperCase()} ${route}`;
    if (typeof operation.operationId !== 'string' || operation.operationId.length === 0) {
      errors.push(`${key} has no operationId`);
      continue;
    }
    if (operationIds.has(operation.operationId)) {
      errors.push(`Duplicate operationId: ${operation.operationId}`);
    }
    operationIds.add(operation.operationId);
    const excludedFromManifest = operation['x-known-route-manifest'] === false;
    if (excludedFromManifest
        && !((route === '/api/v1/feed' || route === '/api/v1/me/feed')
          && (method === 'get' || method === 'head'))) {
      errors.push(`Only Product Feed GET/HEAD may be excluded from the route manifest: ${key}`);
    }
    if (!excludedFromManifest) actual.set(key, operation.operationId);
  }
}

for (const [key, operationId] of expected) {
  if (actual.get(key) !== operationId) {
    errors.push(`Expected ${key} to use operationId ${operationId}`);
  }
}
for (const key of actual.keys()) {
  if (!expected.has(key)) errors.push(`Unregistered Product operation: ${key}`);
}

function inspectRefs(value) {
  if (Array.isArray(value)) return value.forEach(inspectRefs);
  if (value === null || typeof value !== 'object') return;
  if (typeof value.$ref === 'string') {
    try {
      if (resolveLocalRef(document, value.$ref) === undefined) errors.push(`Unresolved reference: ${value.$ref}`);
    } catch (error) {
      errors.push(error.message);
    }
  }
  Object.values(value).forEach(inspectRefs);
}
inspectRefs(document);

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log(`OpenAPI catalog verified: ${actual.size} registered operations, ${operationIds.size} unique operationIds.`);
}

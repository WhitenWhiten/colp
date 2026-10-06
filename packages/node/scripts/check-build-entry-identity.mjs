import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const [esmRoot, esmPublisher, esmServer, esmClient] = await Promise.all([
  import('../dist/index.js'),
  import('../dist/publisher/index.js'),
  import('../dist/server/index.js'),
  import('../dist/client/index.js'),
]);

assert.deepEqual(Object.keys(esmRoot).sort(), [
  'packageStatus',
  'protocolVersion',
  'supportedProfiles',
]);
assert.equal(
  esmPublisher.ServerIdAlreadyReservedError,
  esmServer.ServerIdAlreadyReservedError,
  'ESM publisher and server subpaths must share error constructor identity',
);
assert.equal(
  esmClient.createUrlHash,
  esmServer.createUrlHash,
  'ESM client and server subpaths must share implementation identity',
);

const cjsRoot = require('../dist/index.cjs');
const cjsPublisher = require('../dist/publisher/index.cjs');
const cjsServer = require('../dist/server/index.cjs');
const cjsClient = require('../dist/client/index.cjs');

assert.deepEqual(Object.keys(cjsRoot).sort(), [
  'packageStatus',
  'protocolVersion',
  'supportedProfiles',
]);
assert.equal(
  cjsPublisher.ServerIdAlreadyReservedError,
  cjsServer.ServerIdAlreadyReservedError,
  'CJS publisher and server subpaths must share error constructor identity',
);
assert.equal(
  cjsClient.createUrlHash,
  cjsServer.createUrlHash,
  'CJS client and server subpaths must share implementation identity',
);

const distFiles = await readdir(new URL('../dist/', import.meta.url), {
  recursive: true,
});
assert.equal(
  distFiles.some((file) => file.endsWith('.map')),
  false,
  'production dist must not publish source maps',
);

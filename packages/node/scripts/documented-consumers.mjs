/** Compile exact shipped examples, then exercise their public behavior in ESM/CJS. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const examples = [
  {
    document: 'PUBLICATION_QUICKSTART.md', id: 'publication-read',
    check: async (example, assert) => {
      const value = { protocolVersion: '0.1', collections: [], nextCursor: null };
      const queries = [];
      const load = async (query) => {
        queries.push(query);
        return { value, revision: 'directory-r1', projectionKey: 'public',
          protocolVersion: '0.1', lastModified: new Date('2026-09-25T00:00:00Z'),
          cacheControl: 'public, max-age=60',
          headers: { Link: '<https://example.test/directory>; rel="self"' } };
      };
      const url = 'https://example.test/directory?limit=10';
      const get = await example.readPublicDirectory(new Request(url), load);
      assert.ok(get instanceof Response);
      assert.equal(get.status, 200);
      assert.deepEqual(await get.json(), value);
      assert.equal(queries[0].limit, 10);
      assert.equal(get.headers.get('cache-control'), 'public, max-age=60');
      assert.match(get.headers.get('link'), /rel="self"/);
      const etag = get.headers.get('etag');
      assert.ok(etag);
      const head = await example.readPublicDirectory(new Request(url, { method: 'HEAD' }), load);
      assert.equal(head.status, 200);
      assert.equal(head.body, null);
      assert.equal(head.headers.get('etag'), etag);
      const cached = await example.readPublicDirectory(new Request(url,
        { headers: { 'If-None-Match': etag } }), load);
      assert.equal(cached.status, 304);
      assert.equal(cached.body, null);
      assert.equal(cached.headers.get('etag'), etag);
      const invalid = await example.readPublicDirectory(
        new Request('https://example.test/directory?limit=invalid'), load);
      assert.equal(invalid.status, 400);
      assert.equal((await invalid.json()).code, 'invalid_query');
      const method = await example.readPublicDirectory(new Request(url, { method: 'POST' }), load);
      assert.equal(method.status, 405);
      assert.equal(method.headers.get('allow'), 'GET, HEAD');
      assert.equal(queries.length, 3, 'Invalid requests must not load representations.');
    },
  },
  {
    document: 'PUBLICATION_QUICKSTART.md', id: 'publication-cursor-keys',
    check: async (example, assert, loadPublicEntry) => {
      const api = await loadPublicEntry('@know-n/colp/server');
      const snapshotBytes = new Uint8Array(32).fill(17);
      const directoryBytes = new Uint8Array(32).fill(29);
      const first = example.restorePublicationCursorKeys(snapshotBytes, directoryBytes);
      const second = example.restorePublicationCursorKeys(snapshotBytes, directoryBytes);
      const snapshot = { revision: 'r1', principal: 'alice', pageSize: 10, nextPosition: 'node-2' };
      const directory = { principal: 'alice', filterDigest: api.createPublicationDirectoryFilterDigest(),
        sort: api.DEFAULT_PUBLICATION_DIRECTORY_SORT, limit: 10, protocolVersion: '0.1', nextPosition: 'c2' };
      const snapshotCursor = api.createPublicationSnapshotCursor(snapshot, first.snapshot);
      const directoryCursor = api.createPublicationDirectoryCursor(directory, first.directory);
      first.snapshot.destroy(); first.directory.destroy();
      try {
        assert.deepEqual(api.verifyPublicationSnapshotCursor(snapshotCursor, snapshot, second.snapshot),
          { valid: true, nextPosition: 'node-2' });
        assert.deepEqual(api.verifyPublicationDirectoryCursor(directoryCursor, directory, second.directory),
          { valid: true, nextPosition: 'c2' });
        assert.equal(api.verifyPublicationSnapshotCursor(snapshotCursor,
          { ...snapshot, principal: 'bob' }, second.snapshot).valid, false);
        assert.equal(api.verifyPublicationDirectoryCursor(directoryCursor,
          { ...directory, limit: 20 }, second.directory).valid, false);
        assert.equal(api.verifyPublicationSnapshotCursor(snapshotCursor, snapshot, first.snapshot).valid, false);
        assert.equal(api.verifyPublicationDirectoryCursor(directoryCursor, directory, first.directory).valid, false);
        assert.equal(api.verifyPublicationSnapshotCursor(snapshotCursor, snapshot,
          JSON.parse(JSON.stringify(second.snapshot))).valid, false);
      } finally {
        second.snapshot.destroy(); second.directory.destroy();
      }
    },
  },
  {
    document: 'HOST_INTEGRATION_BOUNDARY.md', id: 'mcp-deployment-binding',
    check: async (example, assert) => {
      const scope = example.mcpReadScopeFromInstalledPackage();
      assert.deepEqual(scope.profiles, ['core', 'mcp-read']);
      assert.equal(typeof scope.mcpConformance.packageVersion, 'string');
      assert.notEqual(scope.mcpConformance.packageVersion, '');
      assert.match(scope.mcpConformance.requirementsDigest, /^sha256:[0-9a-f]{64}$/);
      let calls = 0;
      const target = {
        async execute() { calls++; throw new Error('controlled test target'); },
        async restart() { throw new Error('Unexpected restart'); },
        async readDiagnostics() { throw new Error('Unexpected diagnostics'); },
      };
      await assert.rejects(example.checkMcpReadDeployment(target), /controlled test target/);
      assert.equal(calls, 1, 'A valid documented binding must reach the real target adapter.');
    },
  },
  {
    document: 'SYNC_HOST_COMPOSITION.md', id: 'sync-request-lifetime',
    check: async (example, assert) => {
      const binding = {
        principal: { type: 'user', id: 'alice' }, credential: { kind: 'token', id: 'token-1' },
        oauthClientId: null, origin: 'https://app.example.test', sessionScope: 'collection',
        protocolVersion: '0.1', collectionId: 'collection-1', purpose: null,
      };
      for (const reason of ['credential_revoked', 'scope_reduced', 'lease_expired']) {
        let record = { ...binding, sessionId: 'session-1', status: 'active',
          authorizationScopes: ['sync:push'], expiresAt: '2026-09-25T12:00:00Z' };
        let loads = 0;
        const store = {
          async create() { throw new Error('Verification must not create a Session.'); },
          async load() { loads++; return structuredClone(record); },
          async terminate(input) {
            record = { ...record, status: 'terminated', terminationReason: input.reason,
              terminatedAt: input.terminatedAt };
            return structuredClone(record);
          },
        };
        const input = { sessionId: 'session-1', binding,
          authorization: { credentialActive: true, authorizationScopes: ['sync:push'] },
          terminatedAt: '2026-09-25T11:00:00Z' };
        const hosts = [];
        const pushOwnershipVerifier = () => true;
        const handle = async (host) => {
          assert.ok(loads > hosts.length, 'Reload durable state before each request callback.');
          hosts.push(host);
          return 'handled';
        };
        assert.equal(await example.withSyncPushRequest(store, input, pushOwnershipVerifier, handle), 'handled');
        assert.equal(await example.withSyncPushRequest(store, input, pushOwnershipVerifier, handle), 'handled');
        assert.notEqual(hosts[0], hosts[1]);
        assert.notEqual(hosts[0].session, hosts[1].session);
        const denied = structuredClone(input);
        if (reason === 'credential_revoked') denied.authorization.credentialActive = false;
        if (reason === 'scope_reduced') denied.authorization.authorizationScopes = [];
        if (reason === 'lease_expired') denied.terminatedAt = record.expiresAt;
        await assert.rejects(example.withSyncPushRequest(store, denied, pushOwnershipVerifier, handle));
        assert.equal(hosts.length, 2, 'A denied request must not reach business work.');
        assert.ok(loads >= 3, 'The denied request must also recheck durable state.');
        assert.equal(record.terminationReason, reason);
      }
    },
  },
  {
    document: 'SECURITY_COMPOSITION.md', id: 'server-write-body',
    check: async (example, assert) => {
      const seen = [];
      const semantic = (value) => { seen.push(value); return { valid: true, issues: [] }; };
      assert.deepEqual(example.validateWriteBody('opaqueId', '"item-1"', semantic),
        { valid: true, value: 'item-1' });
      assert.deepEqual(seen, ['item-1']);
      assert.equal(example.validateWriteBody('opaqueId', '{}', semantic).stage, 'structural');
      assert.equal(example.validateWriteBody('opaqueId', '{', semantic).stage, 'parse');
      assert.deepEqual(seen, ['item-1'], 'Do not invoke domain logic for invalid wire input.');
      assert.deepEqual(example.validateWriteBody('opaqueId', '"item-2"',
        () => ({ valid: false, issues: ['domain-denied'] })),
      { valid: false, stage: 'semantic', issues: ['domain-denied'] });
    },
  },
  {
    document: 'SECURITY_COMPOSITION.md', id: 'security-transport',
    check: async (example, assert) => {
      assert.deepEqual(example.checkWriteTransport({}), { allowed: false, reason: 'invalid_evidence' });
    },
  },
  {
    document: 'API.md', id: 'api-validate',
    check: async (example, assert) => {
      const origin = 'https://example.test';
      const manifest = {
        protocol: 'https://know-n.com/colp/spec/0.1', protocolVersions: ['0.1'],
        serverId: origin + '/', serverUuid: '019b3c67-a03c-7f02-9c7e-1ee8d50a77de', title: 'Example',
        mounts: [{
          id: 'default', baseUrl: origin + '/collections/', profiles: ['core', 'publication'],
          endpoints: { directory: origin + '/collections', collection: origin + '/collections/c/{collectionId}',
            snapshot: origin + '/collections/c/{collectionId}/snapshot' },
          features: {}, auth: { anonymousRead: true, apiKeys: false, oauth: false },
          limits: { maxPageSize: 200, maxSnapshotNodes: 10000, minPollIntervalSeconds: 60,
            recommendedPollIntervalSeconds: 300 },
        }],
      };
      assert.equal(example.readManifest(JSON.stringify(manifest)).title, 'Example');
      assert.throws(() => example.readManifest('{"title":'), /^TypeError: Invalid Manifest \(parse\)/);
      assert.throws(() => example.readManifest('{}'), /Invalid Manifest \(structural\)/);
      const duplicate = { ...manifest, mounts: [manifest.mounts[0], manifest.mounts[0]] };
      assert.throws(() => example.readManifest(JSON.stringify(duplicate)),
        /Invalid Manifest \(semantic\): \/mounts\/1\/id /);
    },
  },
  {
    document: 'API.md', id: 'api-local-client',
    check: async (example, assert, loadPublicEntry) => {
      const { ColpClient } = await loadPublicEntry('@know-n/colp/client');
      assert.ok(example.createLocalClient() instanceof ColpClient);
      assert.ok(example.createLocalClient('http://localhost:3000') instanceof ColpClient);
      assert.throws(() => example.createLocalClient('https://alice.example'), RangeError);
    },
  },
  {
    document: 'API.md', id: 'api-serve-read',
    check: async (example, assert) => {
      const root = '019b3ca2-9a3f-7e07-8f18-cc4f2cb4bca8';
      const collectionId = '019b3ca2-8424-7cc2-9a61-4bf44c23f07a';
      const at = '2026-07-16T06:30:00Z';
      const snapshot = {
        protocolVersion: '0.1', snapshotId: 'snap_1', mode: 'publication', complete: true,
        collection: { schemaVersion: '0.1', id: collectionId, kind: 'knowledge_collection', title: 'Example',
          rootNodeId: root, visibility: 'public', createdAt: at, updatedAt: at, revision: 'r_1' },
        nodes: [{ id: root, collectionId, kind: 'root', parentId: null, position: null, folderRole: 'root',
          title: 'Example', createdAt: at, updatedAt: at, revision: 'r_1',
          constraints: { readOnly: false, reason: null }, extensions: {} }],
        annotations: [], attachments: [], relations: [], tombstones: [], revision: 'r_1', generatedAt: at,
        page: { nextCursor: null, hasMore: false, sequence: 1 }, warnings: [],
      };
      let loads = 0;
      const load = async () => { loads++; return snapshot; };
      const url = 'https://example.test/collections/c/' + collectionId + '/snapshot';
      const get = await example.serveSnapshot(new Request(url), load);
      assert.equal(get.status, 200);
      assert.equal(get.headers.get('content-type'), 'application/vnd.collection-protocol.snapshot+json;version=0.1');
      assert.equal(get.headers.get('cache-control'), 'public, max-age=60');
      assert.equal(get.headers.get('last-modified'), new Date(at).toUTCString());
      assert.equal((await get.json()).snapshotId, 'snap_1');
      const etag = get.headers.get('etag');
      assert.ok(etag);
      const head = await example.serveSnapshot(new Request(url, { method: 'HEAD' }), load);
      assert.equal(head.status, 200);
      assert.equal(head.body, null);
      const cached = await example.serveSnapshot(new Request(url, { headers: { 'If-None-Match': etag } }), load);
      assert.equal(cached.status, 304);
      const invalid = await example.serveSnapshot(new Request(url + '?unknown=1'), load);
      assert.equal(invalid.status, 400);
      assert.equal((await invalid.json()).code, 'invalid_query');
      const post = await example.serveSnapshot(new Request(url, { method: 'POST' }), load);
      assert.equal(post.status, 405);
      assert.equal(post.headers.get('allow'), 'GET, HEAD');
      assert.equal((await post.json()).code, 'method_not_allowed');
      assert.equal(loads, 3, 'Rejected requests must not load the Snapshot.');
    },
  },
];

export async function verifyDocumentedConsumers({ consumerRoot, installedPackage, packageRoot }) {
  const files = [];
  for (const example of examples) {
    const document = await readFile(resolve(installedPackage, 'docs', example.document), 'utf8');
    const marker = '<!-- colp-consumer: ' + example.id + ' -->';
    const sections = document.split(marker);
    assert.equal(sections.length, 2, 'Expected exactly one documented example: ' + example.id);
    const snippet = sections[1].match(/^\s*\x60{3}ts\r?\n([\s\S]*?)\r?\n\x60{3}/u)?.[1];
    assert.ok(snippet, 'Missing TypeScript example: ' + example.id);
    for (const extension of ['mts', 'cts']) {
      const file = example.id + '.' + extension;
      await writeFile(resolve(consumerRoot, file), snippet);
      files.push(file);
    }
  }
  const config = resolve(consumerRoot, 'documented-consumers.tsconfig.json');
  await writeFile(config, JSON.stringify({
    compilerOptions: {
      target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext',
      strict: true, skipLibCheck: true, types: [], noEmitOnError: true,
      outDir: './documented-consumers-dist',
    }, files,
  }));
  try {
    await exec(process.execPath, [resolve(packageRoot, 'node_modules/typescript/bin/tsc'), '-p', config]);
  } catch (error) {
    throw new Error('Packaged documentation failed compilation:\n' + (error.stdout ?? '')
      + (error.stderr ?? ''), { cause: error });
  }
  for (const example of examples) {
    for (const extension of ['mjs', 'cjs']) {
      const runner = resolve(consumerRoot, 'check-' + example.id + '-' + extension + '.mjs');
      await writeFile(runner, [
        "import assert from 'node:assert/strict';",
        "import { createRequire } from 'node:module';",
        'const require = createRequire(import.meta.url);',
        'const example = ' + (extension === 'mjs' ? 'await import' : 'require') + '(' +
          JSON.stringify('./documented-consumers-dist/' + example.id + '.' + extension) + ');',
        'const loadPublicEntry = (specifier) => ' +
          (extension === 'mjs' ? 'import(specifier)' : 'require(specifier)') + ';',
        'await (' + example.check.toString() + ')(example, assert, loadPublicEntry);',
      ].join('\n'));
      await exec(process.execPath, [runner], { cwd: consumerRoot });
    }
  }
  console.log('Checked ' + examples.length + ' packaged documentation examples in ESM/CJS consumers.');
}

import { describe, expect, it } from 'vitest';

import {
  projectPublicationPublicValue,
  PublicationPublicProjectionError,
} from '../../src/server/index.js';

const evidence = '[evidence:projection.public-safety]';
const publicNamespace = 'https://public.example/extensions/reading';
const privateNamespace = 'https://private.example/extensions/device-state';

function project(input: unknown, limits?: { readonly maxDepth?: number; readonly maxNodes?: number }) {
  return projectPublicationPublicValue(input, {
    publicExtensionNamespaces: [publicNamespace],
    ...(limits === undefined ? {} : { limits }),
  });
}

function expectProjectionError(action: () => unknown): void {
  expect(action).toThrow(PublicationPublicProjectionError);
}

describe(`PUB-0025 public projection safety ${evidence}`, () => {
  it(`projects ordinary public JSON without mutating or aliasing its input ${evidence}`, () => {
    const input = {
      protocolVersion: '0.1',
      title: 'Public reading list',
      summary: 'A useful, intentionally public collection.',
      available: true,
      count: 2,
      optional: null,
      creators: [{ name: 'Alice', homepage: 'https://alice.example/' }],
      tags: ['design', 'systems'],
    };

    const output = project(input);

    expect(output).toEqual(input);
    expect(output).not.toBe(input);
    expect((output as typeof input).creators).not.toBe(input.creators);
    expect((output as typeof input).creators[0]).not.toBe(input.creators[0]);
    expect((output as typeof input).tags).not.toBe(input.tags);
  });

  it(`removes native and profile identifiers plus local paths from source references at nested array boundaries ${evidence}`, () => {
    const input = {
      pages: [{
        nodes: [{
          id: 'node-public',
          sourceRefs: [{
            system: 'browser',
            adapterVersion: '4.2.0',
            replicaId: 'replica-public',
            nativeId: 'native-secret',
            profileId: 'profile-secret',
            nativeParentId: 'native-parent-secret',
            localPath: 'C:\\Users\\alice\\Bookmarks',
            filePath: '/home/alice/.config/browser/bookmarks.json',
            nativePath: '\\\\server\\alice-private',
            capturedAt: '2026-07-18T00:00:00Z',
          }],
        }],
      }],
      importMetadata: {
        label: 'Public import label',
        profileId: 'profile-secret-outside-source-ref',
        localPath: 'C:\\Users\\alice\\private',
        filePath: '/home/alice/private.json',
        nativePath: '\\\\server\\alice-private',
      },
    };

    expect(project(input)).toEqual({
      pages: [{ nodes: [{
        id: 'node-public',
        sourceRefs: [{
          system: 'browser',
          adapterVersion: '4.2.0',
          replicaId: 'replica-public',
          nativeParentId: 'native-parent-secret',
          capturedAt: '2026-07-18T00:00:00Z',
        }],
      }] }],
      importMetadata: { label: 'Public import label' },
    });
  });

  it(`removes private annotations while retaining public annotations and their public content ${evidence}`, () => {
    const output = project({
      annotations: [
        { id: 'annotation-public', visibility: 'public', type: 'summary', value: 'Safe summary' },
        { id: 'annotation-unlisted', visibility: 'unlisted', type: 'summary', value: 'Safe unlisted summary' },
        { id: 'annotation-protected', visibility: 'protected', type: 'note', value: 'Protected note' },
        { id: 'annotation-private', visibility: 'private', type: 'note', value: 'Private note' },
      ],
      included: {
        annotations: [
          { id: 'nested-private', visibility: 'private', value: 'Nested private note' },
          { id: 'nested-public', visibility: 'public', value: ['nested', { text: 'public' }] },
        ],
      },
    });

    expect(output).toEqual({
      annotations: [
        { id: 'annotation-public', visibility: 'public', type: 'summary', value: 'Safe summary' },
        { id: 'annotation-unlisted', visibility: 'unlisted', type: 'summary', value: 'Safe unlisted summary' },
      ],
      included: {
        annotations: [
          { id: 'nested-public', visibility: 'public', value: ['nested', { text: 'public' }] },
        ],
      },
    });
  });

  it(`filters singular annotation and attachment carriers using anonymous visibility semantics ${evidence}`, () => {
    expect(project({
      annotation: { id: 'protected-note', visibility: 'protected', value: 'not anonymous' },
      attachment: { id: 'private-file', visibility: 'private', url: 'file:///private' },
      nested: {
        annotation: { id: 'public-note', visibility: 'unlisted', value: 'anonymous' },
        attachment: { id: 'public-file', visibility: 'public', url: 'https://cdn.example/public' },
      },
    })).toEqual({
      nested: {
        annotation: { id: 'public-note', visibility: 'unlisted', value: 'anonymous' },
        attachment: { id: 'public-file', visibility: 'public', url: 'https://cdn.example/public' },
      },
    });
  });

  it(`removes private and protected annotations from the standard annotations carrier (F-04/F-28 regression) ${evidence}`, () => {
    expect(project({
      annotations: [
        { id: 'a-public', type: 'summary', visibility: 'public', value: 'public summary' },
        { id: 'a-unlisted', type: 'note', visibility: 'unlisted', value: 'unlisted note' },
        { id: 'a-protected', type: 'note', visibility: 'protected', value: 'protected note' },
        { id: 'a-private', type: 'tldr', visibility: 'private', value: 'private tldr' },
      ],
    })).toEqual({
      annotations: [
        { id: 'a-public', type: 'summary', visibility: 'public', value: 'public summary' },
        { id: 'a-unlisted', type: 'note', visibility: 'unlisted', value: 'unlisted note' },
      ],
    });
  });

  it(`removes private and protected annotation-shaped objects from items and notes carriers ${evidence}`, () => {
    expect(project({
      items: [
        { id: 'item-public', type: 'note', visibility: 'public', value: 'keep public item' },
        { id: 'item-private', type: 'note', visibility: 'private', value: 'drop private item' },
        { id: 'item-protected', type: 'summary', visibility: 'protected', value: 'drop protected item' },
        { id: 'item-unlisted', type: 'highlight', visibility: 'unlisted', value: 'keep unlisted item' },
      ],
      notes: [
        { id: 'note-private', type: 'note', visibility: 'private', text: 'secret note text' },
        { id: 'note-public', type: 'tldr', visibility: 'public', value: 'safe public tldr' },
        { id: 'note-protected', type: 'rating', visibility: 'protected', value: 5 },
        { id: 'note-body-private', visibility: 'private', body: 'content-only private body' },
      ],
    })).toEqual({
      items: [
        { id: 'item-public', type: 'note', visibility: 'public', value: 'keep public item' },
        { id: 'item-unlisted', type: 'highlight', visibility: 'unlisted', value: 'keep unlisted item' },
      ],
      notes: [
        { id: 'note-public', type: 'tldr', visibility: 'public', value: 'safe public tldr' },
      ],
    });
  });

  it(`removes private annotation-shaped objects from nested unconventional arrays ${evidence}`, () => {
    expect(project({
      payload: {
        groups: [{
          label: 'group-a',
          items: [
            { type: 'note', visibility: 'private', body: 'nested private body' },
            { type: 'note', visibility: 'public', body: 'nested public body' },
            { kind: 'annotation', visibility: 'protected', value: 'nested protected by kind' },
            { type: 'custom', visibility: 'unlisted', value: 'nested unlisted custom' },
          ],
        }],
      },
      deep: [[{ visibility: 'private', value: 'deep private' }, { visibility: 'public', value: 'deep public' }]],
    })).toEqual({
      payload: {
        groups: [{
          label: 'group-a',
          items: [
            { type: 'note', visibility: 'public', body: 'nested public body' },
            { type: 'custom', visibility: 'unlisted', value: 'nested unlisted custom' },
          ],
        }],
      },
      deep: [[{ visibility: 'public', value: 'deep public' }]],
    });
  });

  it(`drops singular private annotation-shaped fields on non-annotation object keys ${evidence}`, () => {
    expect(project({
      title: 'Carrier',
      sidecar: { type: 'note', visibility: 'private', value: 'private sidecar' },
      memo: { type: 'summary', visibility: 'protected', value: 'protected memo' },
      publicNote: { type: 'note', visibility: 'public', value: 'public note field' },
      unlistedNote: { type: 'tldr', visibility: 'unlisted', value: 'unlisted note field' },
      contentOnly: { visibility: 'private', text: 'private text content' },
    })).toEqual({
      title: 'Carrier',
      publicNote: { type: 'note', visibility: 'public', value: 'public note field' },
      unlistedNote: { type: 'tldr', visibility: 'unlisted', value: 'unlisted note field' },
    });
  });

  it(`does not delete private nodes or bookmarks merely because they declare visibility ${evidence}`, () => {
    const input = {
      nodes: [
        {
          id: 'bookmark-private',
          kind: 'bookmark',
          visibility: 'private',
          title: 'Private bookmark',
          url: 'https://private.example/page',
          parentId: 'root-1',
          position: 'a0',
        },
        {
          id: 'folder-private',
          kind: 'folder',
          visibility: 'private',
          title: 'Private folder',
          parentId: 'root-1',
          position: 'a1',
        },
        {
          id: 'node-stub-private',
          visibility: 'private',
          title: 'Node stub with parent',
          parentId: 'root-1',
        },
        {
          id: 'node-urlhash-private',
          visibility: 'private',
          title: 'Node with urlHash marker',
          urlHash: 'sha256:deadbeef',
        },
      ],
      collections: [{
        id: 'collection-private',
        kind: 'bookmarks',
        visibility: 'private',
        title: 'Private collection',
        rootNodeId: 'root-1',
      }],
      access: {
        visibility: 'private',
        revision: 'access-revision-private',
        entries: [],
      },
    };

    expect(project(input)).toEqual(input);
  });

  it(`retains public annotation shapes while still stripping non-public ones alongside private nodes ${evidence}`, () => {
    expect(project({
      nodes: [
        {
          id: 'bookmark-private',
          kind: 'bookmark',
          visibility: 'private',
          title: 'Still a node',
          parentId: 'root-1',
        },
      ],
      items: [
        { id: 'ann-public', type: 'note', visibility: 'public', value: 'public annotation item' },
        { id: 'ann-private', type: 'note', visibility: 'private', value: 'private annotation item' },
      ],
      annotations: [
        { id: 'top-public', type: 'summary', visibility: 'public', value: 'top public' },
        { id: 'top-protected', type: 'note', visibility: 'protected', value: 'top protected' },
      ],
    })).toEqual({
      nodes: [
        {
          id: 'bookmark-private',
          kind: 'bookmark',
          visibility: 'private',
          title: 'Still a node',
          parentId: 'root-1',
        },
      ],
      items: [
        { id: 'ann-public', type: 'note', visibility: 'public', value: 'public annotation item' },
      ],
      annotations: [
        { id: 'top-public', type: 'summary', visibility: 'public', value: 'top public' },
      ],
    });
  });

  it(`removes internal principal IDs from ACL entries without erasing public policy semantics ${evidence}`, () => {
    const output = project({
      access: {
        visibility: 'public',
        revision: 'access-revision-1',
        entries: [
          { principal: { type: 'user', id: 'user-internal-42' }, effect: 'allow', scopes: ['collection:read'] },
          { principal: { type: 'public', id: 'public-internal-sentinel' }, effect: 'allow', scopes: ['collection:read'] },
        ],
        publication: { listInDirectory: true, allowSearchIndexing: true, allowEmbedding: false },
      },
    });

    expect(output).toEqual({
      access: {
        visibility: 'public',
        revision: 'access-revision-1',
        entries: [
          { principal: { type: 'user' }, effect: 'allow', scopes: ['collection:read'] },
          { principal: { type: 'public' }, effect: 'allow', scopes: ['collection:read'] },
        ],
        publication: { listInDirectory: true, allowSearchIndexing: true, allowEmbedding: false },
      },
    });
  });

  it(`removes API key, token, and secret material while preserving only a key hint ${evidence}`, () => {
    const output = project({
      security: {
        keyHint: 'colp_live_...9Q2A',
        apiKey: 'api-key-secret',
        key: 'raw-key-secret',
        secret: 'raw-secret',
        token: 'bearer-token-secret',
        accessToken: 'access-token-secret',
        refreshToken: 'refresh-token-secret',
        clientSecret: 'oauth-client-secret',
        privateKey: 'private-key-secret',
        nested: [{ authorizationToken: 'nested-token-secret', label: 'removed credentials' }],
      },
    });

    expect(output).toEqual({
      security: {
        keyHint: 'colp_live_...9Q2A',
        nested: [{ label: 'removed credentials' }],
      },
    });
  });

  it.each([
    // camelCase
    ['camelCase apiKey', 'apiKey', 'api-key-secret'],
    ['camelCase privateKey', 'privateKey', 'private-key-secret'],
    ['camelCase accessToken', 'accessToken', 'access-token-secret'],
    ['camelCase clientSecret', 'clientSecret', 'oauth-client-secret'],
    ['camelCase passwordHash', 'passwordHash', 'password-hash-secret'],
    // snake_case
    ['snake_case api_key', 'api_key', 'api-key-secret'],
    ['snake_case private_key', 'private_key', 'private-key-secret'],
    ['snake_case access_token', 'access_token', 'access-token-secret'],
    ['snake_case client_secret', 'client_secret', 'oauth-client-secret'],
    ['snake_case password_hash', 'password_hash', 'password-hash-secret'],
    // kebab-case (valid JSON object keys)
    ['kebab-case api-key', 'api-key', 'api-key-secret'],
    ['kebab-case private-key', 'private-key', 'private-key-secret'],
    // weak aliases (must be stripped from public projections)
    ['weak alias passwd', 'passwd', 'passwd-secret'],
    ['weak alias pwd', 'pwd', 'pwd-secret'],
  ] as const)(
    `removes secret field naming variant at root and nested object paths: %s ${evidence}`,
    (_label, field, secretValue) => {
      const input = {
        title: 'Public title',
        [field]: secretValue,
        carrier: {
          label: 'carrier-safe',
          [field]: secretValue,
        },
      };

      expect(project(input)).toEqual({
        title: 'Public title',
        carrier: {
          label: 'carrier-safe',
        },
      });
    },
  );

  it(`removes snake_case secret fields nested inside objects and arrays ${evidence}`, () => {
    const output = project({
      title: 'Public collection',
      auth: {
        label: 'provider-metadata',
        api_key: 'auth-api-key',
        private_key: 'auth-private-key',
        access_token: 'auth-access-token',
        client_secret: 'auth-client-secret',
        password_hash: 'auth-password-hash',
        passwd: 'auth-passwd',
        pwd: 'auth-pwd',
        'api-key': 'auth-kebab-api-key',
        'private-key': 'auth-kebab-private-key',
      },
      nodes: [
        {
          id: 'node-1',
          title: 'Node remains',
          api_key: 'node-api-key',
          private_key: 'node-private-key',
          metadata: {
            note: 'public note',
            access_token: 'meta-access-token',
            client_secret: 'meta-client-secret',
            password_hash: 'meta-password-hash',
          },
        },
      ],
      entries: [
        {
          name: 'entry-a',
          api_key: 'entry-a-api-key',
          password_hash: 'entry-a-password-hash',
          details: [{ kind: 'leaf', private_key: 'entry-a-private-key', tag: 'safe-a' }],
        },
        {
          name: 'entry-b',
          access_token: 'entry-b-access-token',
          client_secret: 'entry-b-client-secret',
          details: [{ kind: 'leaf', passwd: 'entry-b-passwd', pwd: 'entry-b-pwd', tag: 'safe-b' }],
        },
      ],
    });

    expect(output).toEqual({
      title: 'Public collection',
      auth: {
        label: 'provider-metadata',
      },
      nodes: [
        {
          id: 'node-1',
          title: 'Node remains',
          metadata: {
            note: 'public note',
          },
        },
      ],
      entries: [
        {
          name: 'entry-a',
          details: [{ kind: 'leaf', tag: 'safe-a' }],
        },
        {
          name: 'entry-b',
          details: [{ kind: 'leaf', tag: 'safe-b' }],
        },
      ],
    });
  });

  it(`retains keyHint in credential containers while stripping secret naming variants ${evidence}`, () => {
    const output = project({
      apiKey: {
        keyHint: 'hint-apikey-container',
        secret: 'container-secret',
        token: 'container-token',
        passwordHash: 'container-password-hash',
        password_hash: 'container-password_hash',
        passwd: 'container-passwd',
        pwd: 'container-pwd',
      },
      credentials: {
        keyHint: 'hint-credentials-container',
        api_key: 'credentials-api_key',
        private_key: 'credentials-private_key',
        access_token: 'credentials-access_token',
        client_secret: 'credentials-client_secret',
        'api-key': 'credentials-api-key',
        'private-key': 'credentials-private-key',
      },
      credential: {
        keyHint: 'hint-credential-container',
        accessToken: 'credential-accessToken',
        clientSecret: 'credential-clientSecret',
        privateKey: 'credential-privateKey',
      },
      // Non-container object: keyHint stays alongside other safe fields.
      security: {
        keyHint: 'hint-security-object',
        label: 'security-label',
        apiKey: 'security-apiKey',
        api_key: 'security-api_key',
        private_key: 'security-private_key',
        access_token: 'security-access_token',
        client_secret: 'security-client_secret',
        password_hash: 'security-password_hash',
        passwd: 'security-passwd',
        pwd: 'security-pwd',
        'api-key': 'security-api-key',
        'private-key': 'security-private-key',
      },
    });

    expect(output).toEqual({
      apiKey: { keyHint: 'hint-apikey-container' },
      credentials: { keyHint: 'hint-credentials-container' },
      credential: { keyHint: 'hint-credential-container' },
      security: {
        keyHint: 'hint-security-object',
        label: 'security-label',
      },
    });
  });

  it(`removes a mixed-case secret payload that combines every naming variant in one object ${evidence}`, () => {
    const output = project({
      publicId: 'collection-public',
      summary: 'Safe public summary',
      payload: {
        apiKey: 'v-apiKey',
        privateKey: 'v-privateKey',
        accessToken: 'v-accessToken',
        clientSecret: 'v-clientSecret',
        passwordHash: 'v-passwordHash',
        api_key: 'v-api_key',
        private_key: 'v-private_key',
        access_token: 'v-access_token',
        client_secret: 'v-client_secret',
        password_hash: 'v-password_hash',
        'api-key': 'v-api-key',
        'private-key': 'v-private-key',
        passwd: 'v-passwd',
        pwd: 'v-pwd',
        keep: 'public-keep',
      },
    });

    expect(output).toEqual({
      publicId: 'collection-public',
      summary: 'Safe public summary',
      payload: {
        keep: 'public-keep',
      },
    });
  });

  /**
   * Table-driven freeze of the sensitive field contract.
   * - exact-only: redacted by exact-set membership (not simple suffix matching alone)
   * - suffix-covered: must remain redacted even if the exact set is pruned to rely on suffixes
   * Behavior is locked independent of secretKeys set size.
   */
  it.each([
    // --- exact-only (not covered by simple suffix alone) ---
    ['exact-only', 'accessKeys', 'exact-accessKeys-secret'],
    ['exact-only', 'access_keys', 'exact-access_keys-secret'],
    ['exact-only', 'access-keys', 'exact-access-keys-secret'],
    ['exact-only', 'apiKeys', 'exact-apiKeys-secret'],
    ['exact-only', 'api_keys', 'exact-api_keys-secret'],
    ['exact-only', 'api-keys', 'exact-api-keys-secret'],
    ['exact-only', 'authorization', 'exact-authorization-secret'],
    ['exact-only', 'cookies', 'exact-cookies-secret'],
    ['exact-only', 'pwd', 'exact-pwd-secret'],
    ['exact-only', 'secretKeys', 'exact-secretKeys-secret'],
    ['exact-only', 'secret_keys', 'exact-secret_keys-secret'],
    ['exact-only', 'secret-keys', 'exact-secret-keys-secret'],
    ['exact-only', 'secrets', 'exact-secrets-secret'],
    ['exact-only', 'session', 'exact-session-secret'],
    ['exact-only', 'signingKey', 'exact-signingKey-secret'],
    ['exact-only', 'signing_key', 'exact-signing_key-secret'],
    ['exact-only', 'signing-key', 'exact-signing-key-secret'],
    ['exact-only', 'tokens', 'exact-tokens-secret'],
    // --- suffix-covered (must still redact after exact-set pruning) ---
    ['suffix-covered', 'apiKey', 'suffix-apiKey-secret'],
    ['suffix-covered', 'privateKey', 'suffix-privateKey-secret'],
    ['suffix-covered', 'accessToken', 'suffix-accessToken-secret'],
    ['suffix-covered', 'clientSecret', 'suffix-clientSecret-secret'],
    ['suffix-covered', 'password', 'suffix-password-secret'],
    ['suffix-covered', 'cookie', 'suffix-cookie-secret'],
    ['suffix-covered', 'setCookie', 'suffix-setCookie-secret'],
    ['suffix-covered', 'set_cookie', 'suffix-set_cookie-secret'],
    ['suffix-covered', 'set-cookie', 'suffix-set-cookie-secret'],
    ['suffix-covered', 'sessionId', 'suffix-sessionId-secret'],
    ['suffix-covered', 'session_id', 'suffix-session_id-secret'],
    ['suffix-covered', 'session-id', 'suffix-session-id-secret'],
    ['suffix-covered', 'bearerToken', 'suffix-bearerToken-secret'],
    ['suffix-covered', 'bearer_token', 'suffix-bearer_token-secret'],
    ['suffix-covered', 'bearer-token', 'suffix-bearer-token-secret'],
    ['suffix-covered', 'secret', 'suffix-plain-secret'],
    ['suffix-covered', 'token', 'suffix-plain-token'],
  ] as const)(
    `freezes secret field contract (%s): strips %s at root and nested paths ${evidence}`,
    (_coverageClass, field, secretValue) => {
      const input = {
        title: 'Public title',
        keyHint: 'contract-key-hint',
        [field]: secretValue,
        carrier: {
          label: 'carrier-safe',
          keyHint: 'nested-contract-key-hint',
          [field]: secretValue,
        },
      };

      const output = project(input);

      expect(output).toEqual({
        title: 'Public title',
        keyHint: 'contract-key-hint',
        carrier: {
          label: 'carrier-safe',
          keyHint: 'nested-contract-key-hint',
        },
      });
      expect(Object.prototype.hasOwnProperty.call(output as object, field)).toBe(false);
      expect(Object.prototype.hasOwnProperty.call((output as { carrier: object }).carrier, field)).toBe(false);
      expect(JSON.stringify(output)).not.toContain(secretValue);
    },
  );

  it(`removes private conflict versions while retaining non-version conflict metadata ${evidence}`, () => {
    const output = project({
      events: [{
        kind: 'conflict',
        conflict: {
          id: 'conflict-1',
          collectionId: 'collection-1',
          targetId: 'node-1',
          type: 'content',
          field: 'description',
          base: { description: 'private base version' },
          server: { description: 'private server version' },
          incoming: { description: 'private incoming version' },
          incomingOpId: 'operation-1',
          createdAt: '2026-07-18T00:00:00Z',
          status: 'open',
          allowedResolutions: ['server', 'incoming'],
          revision: 'conflict-revision-1',
        },
      }],
    });

    expect(output).toEqual({
      events: [{
        kind: 'conflict',
        conflict: {
          id: 'conflict-1',
          collectionId: 'collection-1',
          targetId: 'node-1',
          type: 'content',
          field: 'description',
          incomingOpId: 'operation-1',
          createdAt: '2026-07-18T00:00:00Z',
          status: 'open',
          allowedResolutions: ['server', 'incoming'],
          revision: 'conflict-revision-1',
        },
      }],
    });
  });

  it(`keeps only explicitly public attachments and removes crawled bodies at every depth ${evidence}`, () => {
    const output = project({
      attachments: [
        { id: 'public-attachment', visibility: 'public', url: 'https://cdn.example/public.pdf', title: 'Public PDF' },
        { id: 'unlisted-attachment', visibility: 'unlisted', url: 'https://cdn.example/unlisted.pdf' },
        { id: 'private-attachment', visibility: 'private', url: 'file:///home/alice/private.pdf' },
        { id: 'protected-attachment', visibility: 'protected', url: 'https://cdn.example/protected.pdf' },
        { id: 'missing-visibility', url: 'https://cdn.example/ambiguous.pdf' },
      ],
      node: {
        id: 'node-1',
        title: 'Article metadata remains',
        crawledBody: 'private crawled full text',
        crawl: { body: 'nested private crawl', fetchedAt: '2026-07-17T00:00:00Z' },
        content: { crawledBody: ['private', { text: 'body' }], summary: 'Public summary' },
      },
    });

    expect(output).toEqual({
      attachments: [
        { id: 'public-attachment', visibility: 'public', url: 'https://cdn.example/public.pdf', title: 'Public PDF' },
        { id: 'unlisted-attachment', visibility: 'unlisted', url: 'https://cdn.example/unlisted.pdf' },
      ],
      node: {
        id: 'node-1',
        title: 'Article metadata remains',
        crawl: { fetchedAt: '2026-07-17T00:00:00Z' },
        content: { summary: 'Public summary' },
      },
    });
  });

  it(`preserves only exact public-safe extension namespaces on every extension carrier ${evidence}`, () => {
    const publicValue = { rating: 5, labels: ['carefully', { selected: true }] };
    const output = project({
      extensions: {
        [publicNamespace]: publicValue,
        [`${publicNamespace}/lookalike`]: { leak: 'not exact' },
        [privateNamespace]: { deviceId: 'device-secret' },
      },
      nodes: [{
        id: 'node-1',
        extensions: {
          [privateNamespace]: { localState: true },
          [publicNamespace]: { annotation: 'safe' },
        },
      }],
    });

    expect(output).toEqual({
      extensions: { [publicNamespace]: publicValue },
      nodes: [{ id: 'node-1', extensions: { [publicNamespace]: { annotation: 'safe' } } }],
    });
    expect((output as { extensions: Record<string, unknown> }).extensions[publicNamespace]).not.toBe(publicValue);
  });

  it(`defaults to excluding every extension when the exact allowlist is empty ${evidence}`, () => {
    expect(projectPublicationPublicValue(
      { title: 'Public title', extensions: { [publicNamespace]: { apparentlySafe: true } } },
      { publicExtensionNamespaces: [] },
    )).toEqual({ title: 'Public title' });
  });

  it(`deep-freezes a detached output and leaves caller-owned inputs mutable ${evidence}`, () => {
    const input = {
      title: 'Original',
      nested: { items: [{ label: 'first' }] },
      extensions: { [publicNamespace]: { flags: [true] } },
    };
    const output = project(input) as typeof input;

    input.title = 'Input changed';
    input.nested.items[0]!.label = 'caller mutation';
    input.extensions[publicNamespace]!.flags.push(false);

    expect(output.title).toBe('Original');
    expect(output.nested.items[0]!.label).toBe('first');
    expect(output.extensions[publicNamespace]!.flags).toEqual([true]);
    expect(Object.isFrozen(output)).toBe(true);
    expect(Object.isFrozen(output.nested)).toBe(true);
    expect(Object.isFrozen(output.nested.items)).toBe(true);
    expect(Object.isFrozen(output.nested.items[0])).toBe(true);
    expect(Object.isFrozen(output.extensions[publicNamespace])).toBe(true);
    expect(Object.isFrozen(output.extensions[publicNamespace]!.flags)).toBe(true);
  });

  it.each([
    ['undefined property', { safe: true, malformed: undefined }],
    ['bigint', { safe: true, malformed: 1n }],
    ['symbol key', Object.assign({ safe: true }, { [Symbol('hidden')]: 'secret' })],
    ['non-plain Date', { safe: true, malformed: new Date('2026-07-18T00:00:00Z') }],
    ['sparse array', { safe: true, malformed: new Array(2) }],
    ['non-finite number', { safe: true, malformed: Number.POSITIVE_INFINITY }],
  ] as const)(`fails closed for malformed JSON input: %s ${evidence}`, (_label, input) => {
    expectProjectionError(() => project(input));
  });

  it(`rejects accessors without invoking them ${evidence}`, () => {
    let invoked = false;
    const input = Object.defineProperty({ title: 'safe' }, 'secret', {
      enumerable: true,
      get() {
        invoked = true;
        return 'accessor-secret';
      },
    });

    expectProjectionError(() => project(input));
    expect(invoked).toBe(false);
  });

  it(`fails closed for cycles and hostile proxies ${evidence}`, () => {
    const cyclic: { title: string; self?: unknown } = { title: 'safe' };
    cyclic.self = cyclic;
    const proxy = new Proxy({ title: 'safe' }, {
      ownKeys() {
        throw new Error('proxy-secret-value');
      },
    });

    expectProjectionError(() => project(cyclic));
    expectProjectionError(() => project(proxy));
  });

  it(`enforces configured depth and node budgets before returning any partial projection ${evidence}`, () => {
    const deep = { level1: { level2: { level3: { value: 'too deep' } } } };
    const wide = { values: Array.from({ length: 12 }, (_, index) => ({ index })) };

    expectProjectionError(() => project(deep, { maxDepth: 2, maxNodes: 100 }));
    expectProjectionError(() => project(wide, { maxDepth: 10, maxNodes: 8 }));
  });

  it(`does not reflect secret input values or hostile proxy diagnostics in projection errors ${evidence}`, () => {
    const secret = 'COLP-SUPER-SECRET-9f70e6';
    const cyclic: { visible: string; secret: string; self?: unknown } = { visible: 'safe', secret };
    cyclic.self = cyclic;
    const proxy = new Proxy({}, {
      ownKeys() {
        throw new Error(`adapter exploded with ${secret}`);
      },
    });

    for (const input of [cyclic, proxy]) {
      let caught: unknown;
      try {
        project(input);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(PublicationPublicProjectionError);
      expect(String(caught)).not.toContain(secret);
      const cause = (caught as Error & { cause?: unknown }).cause;
      expect(cause === undefined ? '' : String(cause)).not.toContain(secret);
    }
  });

  it(`does not redact legitimate public content merely because names or text contain security words ${evidence}`, () => {
    const input = {
      title: 'API keys and token security',
      description: 'A public article about secret rotation and private-key cryptography.',
      keynote: 'Opening address',
      monkey: 'capuchin',
      secretary: 'Public office',
      tokensCount: 12,
      apiKeyboardLayout: 'standard',
      key: 'stable-public-map-key',
      keys: ['left', 'right'],
      url: 'https://public.example/articles/token-security',
      visibility: 'public',
    };

    expect(project(input)).toEqual(input);
  });

  it(`rejects non-index array properties instead of silently ignoring them ${evidence}`, () => {
    const input = ['safe'] as string[] & Record<string, unknown>;
    input['4294967295'] = 'hidden-extra-value';
    expectProjectionError(() => project(input));
  });
});

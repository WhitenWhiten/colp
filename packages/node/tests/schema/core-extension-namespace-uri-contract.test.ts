import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ColpClient } from '../../src/client/index.js';
import {
  collectionProtocolSchema,
  createValidatorRegistry,
  validateWireDocument,
} from '../../src/schema/index.js';
import { validateSnapshotSemantics } from '../../src/semantic/index.js';
import type { Snapshot } from '../../src/types/index.js';

const evidence = '[evidence:core.extension-namespace-uri]';
const fixturesRoot = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');
const manifestUrl = 'https://alice.example/.well-known/collection-protocol';
const collectionId = '019b3ca2-8424-7cc2-9a61-4bf44c23f07a';
const timestamp = '2026-07-16T06:30:00Z';
const validators = createValidatorRegistry();

function fixture(name: string): Record<string, any> {
  return JSON.parse(readFileSync(resolve(fixturesRoot, name), 'utf8')) as Record<string, any>;
}

function addSidecars(snapshot: Record<string, any>): void {
  snapshot.attachments.push({
    id: 'attachment-1',
    collectionId: snapshot.collection.id,
    subject: { type: 'node', id: snapshot.nodes[1].id },
    rel: 'alternate',
    url: 'https://example.com/attachment',
    visibility: 'public',
    createdAt: timestamp,
    updatedAt: timestamp,
    revision: 'attachment-revision',
  });
  snapshot.relations.push({
    id: 'relation-1',
    collectionId: snapshot.collection.id,
    type: 'related',
    fromNodeId: snapshot.nodes[0].id,
    toNodeId: snapshot.nodes[1].id,
    visibility: 'public',
    createdAt: timestamp,
    updatedAt: timestamp,
    revision: 'relation-revision',
  });
}

function clientFor(manifest: unknown, snapshot: unknown): { client: ColpClient; fetch: ReturnType<typeof vi.fn> } {
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    return url.pathname === '/.well-known/collection-protocol'
      ? Response.json(manifest)
      : Response.json(snapshot, { headers: { ETag: '"snapshot-1"' } });
  });
  return {
    client: new ColpClient({ manifestUrl, fetch: fetch as typeof globalThis.fetch }),
    fetch,
  };
}

describe('CORE-0011 HTTPS extension namespace URI contract', () => {
  it(`defines the canonical extension-key constraint ${evidence}`, () => {
    const definition = (collectionProtocolSchema.$defs as any).extensions;

    expect(definition).toEqual(expect.objectContaining({
      type: 'object',
      propertyNames: expect.objectContaining({ type: 'string', format: 'uri' }),
      additionalProperties: true,
    }));
    expect(new RegExp(definition.propertyNames.pattern, 'u').test('https://example.com/ns')).toBe(true);
    expect(new RegExp(definition.propertyNames.pattern, 'u').test('http://example.com/ns')).toBe(false);
  });

  it(`applies the shared constraint to every core extension-bearing definition ${evidence}`, () => {
    const extensionProperties = Object.entries(collectionProtocolSchema.$defs)
      .flatMap(([name, definition]) => {
        const property = (definition as any).properties?.extensions;
        return property === undefined ? [] : [{ name, property }];
      })
      .sort((left, right) => left.name.localeCompare(right.name));

    expect(extensionProperties.map(({ name }) => name)).toEqual([
      'annotation',
      'annotationCreate',
      'annotationMergePatch',
      'attachment',
      'attachmentCreate',
      'attachmentMergePatch',
      'collection',
      'collectionCreate',
      'collectionMergePatch',
      'directoryCollection',
      'extensionFeedEventData',
      'node',
      'nodeCreate',
      'nodeMergePatch',
      'operationSource',
      'relation',
      'relationCreate',
      'relationMergePatch',
      'release',
      'releaseCreate',
      'replica',
      'rootCreate',
    ]);
    for (const { property } of extensionProperties) {
      expect([
        { $ref: '#/$defs/extensions' },
        { oneOf: [{ type: 'null' }, { $ref: '#/$defs/extensions' }] },
      ]).toContainEqual(property);
    }
  });

  it.each([
    'https://example.com',
    'https://example.com/ns/v1',
    'HTTPS://EXAMPLE.com:8443/ns?v=1#contract',
    'https://127.0.0.1:9443/extensions/core',
    'https://[2001:db8::1]:443/extensions/v1',
    'https://example.com/a%2Fb?name=%7Evalue#section-1',
    "https://example.com/ns:part@v1!$&'()*+,;=",
  ])(`accepts absolute HTTPS namespace URI %s ${evidence}`, (namespace) => {
    expect(validators.validate('extensions', { [namespace]: true })).toEqual({ valid: true, errors: [] });
  });

  it.each([
    ['HTTP URI', 'http://example.com/ns'],
    ['non-HTTPS absolute URI', 'ftp://example.com/ns'],
    ['relative reference', '../extensions/ns'],
    ['scheme-relative reference', '//example.com/ns'],
    ['single-slash HTTPS reference', 'https:/example.com/ns'],
    ['opaque HTTPS URI', 'https:namespace'],
    ['missing HTTPS authority', 'https://'],
    ['empty HTTPS authority', 'https:///extensions/ns'],
    ['query without HTTPS authority', 'https://?namespace=v1'],
    ['fragment without HTTPS authority', 'https://#namespace-v1'],
    ['userinfo with a valid host', 'https://user:secret@example.com/ns'],
    ['empty userinfo with a valid host', 'https://@example.com/ns'],
    ['empty explicit port', 'https://example.com:'],
    ['empty explicit port before a path', 'https://example.com:/ns'],
    ['userinfo followed by an empty host and port', 'https://user@:443/ns'],
    ['empty userinfo followed by an empty host and port', 'https://@:443/ns'],
    ['multiple userinfo delimiters', 'https://user@@example.com/ns'],
    ['bad percent escape', 'https://example.com/%ZZ'],
    ['RFC 3986-invalid bracket path', 'https://example.com/[]'],
    ['space in URI', 'https://exa mple.com/ns'],
    ['line break in URI', 'https://example.com/ns\nnext'],
    ['empty key', ''],
    ['plain extension name', 'extension-name'],
  ])(`rejects %s: %s ${evidence}`, (_label, namespace) => {
    const result = validators.validate('extensions', { [namespace]: { arbitrary: true } });

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          instancePath: '',
          params: expect.objectContaining({ propertyName: namespace }),
        }),
      ]),
    );
    expect(result.errors.some(({ keyword }) => keyword === 'format' || keyword === 'pattern')).toBe(true);
  });

  it(`compares namespace keys by their exact original spelling ${evidence}`, () => {
    const upper = 'https://EXAMPLE.com:443/ns/%7Evalue';
    const lower = 'https://example.com/ns/~value';
    const extensions = { [upper]: { spelling: 'upper' }, [lower]: { spelling: 'lower' } };

    expect(validators.validate('extensions', extensions)).toEqual({ valid: true, errors: [] });
    expect(Object.keys(extensions)).toEqual([upper, lower]);
  });

  it(`accepts arbitrary nested payloads without mutating them during validation ${evidence}`, () => {
    const namespace = 'https://extensions.example/contracts/arbitrary/v1';
    const extensions = {
      [namespace]: {
        unknownName: {
          scalars: [null, true, false, 0, 42.5, 'text'],
          objects: [{ deeplyUnknown: { value: ['nested', { leaf: 1 }] } }],
        },
      },
    };
    const snapshot = fixture('collection-snapshot.json');
    addSidecars(snapshot);
    snapshot.collection.extensions = extensions;
    snapshot.nodes[0].extensions = extensions;
    snapshot.annotations[0].extensions = extensions;
    snapshot.attachments[0].extensions = extensions;
    snapshot.relations[0].extensions = extensions;
    const before = structuredClone(snapshot);

    expect(validators.validate('extensions', extensions)).toEqual({ valid: true, errors: [] });
    expect(validators.validate('snapshot', snapshot)).toEqual({ valid: true, errors: [] });
    expect(snapshot).toEqual(before);
  });

  it.each([
    ['Collection', (snapshot: any) => snapshot.collection, '/collection'],
    ['Node', (snapshot: any) => snapshot.nodes[0], '/nodes/0'],
    ['Annotation', (snapshot: any) => snapshot.annotations[0], '/annotations/0'],
    ['Attachment', (snapshot: any) => snapshot.attachments[0], '/attachments/0'],
    ['Relation', (snapshot: any) => snapshot.relations[0], '/relations/0'],
  ])(`reports a JSON-pointer-safe namespace path for %s ${evidence}`, (_label, select, path) => {
    const namespace = 'https:///invalid/ns/a~b';
    const snapshot = fixture('collection-snapshot.json');
    addSidecars(snapshot);
    snapshot.mode = 'sync';
    select(snapshot).extensions = { [namespace]: { arbitrary: true } };

    const result = validateSnapshotSemantics(snapshot as Snapshot);

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'invalid_extension_namespace',
          path: `${path}/extensions/https:~1~1~1invalid~1ns~1a~0b`,
        }),
      ]),
    );
  });

  it.each([
    [
      'userinfo',
      'https://user:secret@example.com/a~b',
      '/collection/extensions/https:~1~1user:secret@example.com~1a~0b',
    ],
    [
      'an empty explicit port',
      'https://example.com:/a~b',
      '/collection/extensions/https:~1~1example.com:~1a~0b',
    ],
  ])(`rejects %s in the semantic path ${evidence}`, (_label, namespace, expectedPath) => {
    const snapshot = fixture('collection-snapshot.json');
    snapshot.mode = 'sync';
    snapshot.collection.extensions = { [namespace]: true };

    const result = validateSnapshotSemantics(snapshot as Snapshot);

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'invalid_extension_namespace',
          path: expectedPath,
        }),
      ]),
    );
  });

  it(`keeps structural checks on clients and producer allowlists at producer boundaries ${evidence}`, async () => {
    const manifest = fixture('public-manifest.json');
    const structurallyInvalid = fixture('collection-snapshot.json');
    structurallyInvalid.collection.extensions = { 'https://user:secret@example.com/invalid/ns': true };
    const semantics = vi.fn((value: Snapshot) => validateSnapshotSemantics(value));

    const structural = validateWireDocument(
      validators,
      'snapshot',
      structurallyInvalid,
      semantics,
    );
    expect(structural).toMatchObject({ valid: false, stage: 'structural' });
    expect(semantics).not.toHaveBeenCalled();

    const structuralClient = clientFor(manifest, structurallyInvalid);
    await expect(structuralClient.client.getSnapshot(collectionId)).rejects.toThrow(
      'Response does not satisfy snapshot',
    );
    expect(structuralClient.fetch).toHaveBeenCalledTimes(2);

    const semanticallyInvalid = fixture('collection-snapshot.json');
    semanticallyInvalid.collection.extensions = { 'https://private.example/ns': true };
    const semantic = validateWireDocument(
      validators,
      'snapshot',
      semanticallyInvalid,
      (value: Snapshot) => validateSnapshotSemantics(value),
    );
    expect(semantic).toMatchObject({ valid: false, stage: 'semantic' });

    const semanticClient = clientFor(manifest, semanticallyInvalid);
    await expect(semanticClient.client.getSnapshot(collectionId)).resolves.toMatchObject({
      collection: { extensions: { 'https://private.example/ns': true } },
    });
    expect(semanticClient.fetch).toHaveBeenCalledTimes(2);
  });
});

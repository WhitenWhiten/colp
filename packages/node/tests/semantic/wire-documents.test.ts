import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import { createValidatorRegistry, type DefinitionName } from '../../src/schema/index.js';
import {
  createUrlHash,
  validateColpDocument,
  validateColpJsonDocument,
} from '../../src/semantic/index.js';
import type { Manifest, Snapshot } from '../../src/types/index.js';

const examples = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');
const source = (name: string): string => readFileSync(resolve(examples, name), 'utf8');
const example = <Value = Record<string, unknown>>(name: string): Value => JSON.parse(source(name)) as Value;

const wrongHash = createUrlHash('https://example.test/another-page');

describe('validateColpDocument', () => {
  it.each([
    ['manifest', 'public-manifest.json'],
    ['snapshot', 'collection-snapshot.json'],
    ['problem', 'problem.json'],
    ['nodeDetail', 'node-detail.json'],
    ['collectionDirectory', 'collection-directory.json'],
    ['collectionMetadata', 'collection-metadata.json'],
  ] as const)('accepts the %s example', (definition, file) => {
    const value = example(file);
    const result = validateColpDocument(definition, value);
    expect(result).toEqual({ valid: true, value });
  });

  it('types the validated value with its contract', () => {
    const result = validateColpDocument('manifest', example('public-manifest.json'));
    if (result.valid) expectTypeOf(result.value).toEqualTypeOf<Manifest>();
    const unknownDefinition = validateColpDocument('nodeMovedEffect' as DefinitionName, {});
    if (unknownDefinition.valid) expectTypeOf(unknownDefinition.value).toBeUnknown();
  });

  it('reports schema failures before any semantic check runs', () => {
    const validateSemantics = vi.fn(() => ({ valid: true, issues: [] }) as const);
    const result = validateColpDocument('manifest', { title: 'Not a Manifest' }, { validateSemantics });
    expect(result).toMatchObject({ valid: false, stage: 'structural' });
    expect(validateSemantics).not.toHaveBeenCalled();
  });

  it('checks Manifest rules a schema cannot express', () => {
    const manifest = example<Manifest>('public-manifest.json');
    const result = validateColpDocument('manifest', { ...manifest, mounts: [...manifest.mounts, manifest.mounts[0]] });
    expect(result).toMatchObject({
      valid: false,
      stage: 'semantic',
      issues: [expect.objectContaining({ code: 'duplicate_mount_id', path: '/mounts/1/id' })],
    });
  });

  describe('Snapshot defaults', () => {
    const snapshot = example<Snapshot>('collection-snapshot.json');
    const bookmark = snapshot.nodes[1]!;
    const withExtension = {
      ...snapshot,
      nodes: [snapshot.nodes[0], { ...bookmark, extensions: { 'https://example.test/ns': { pinned: true } } }],
    };

    it('preserves unknown extensions as a consumer unless producer mode is requested', () => {
      expect(validateColpDocument('snapshot', withExtension).valid).toBe(true);
      expect(validateColpDocument('snapshot', withExtension, {
        snapshot: { publicationExtensionMode: 'producer' },
      })).toMatchObject({
        valid: false,
        stage: 'semantic',
        issues: [expect.objectContaining({ code: 'unsafe_publication_extension' })],
      });
      expect(validateColpDocument('snapshot', withExtension, {
        snapshot: { publicationExtensionMode: 'producer', publicSafeExtensions: new Set(['https://example.test/ns']) },
      }).valid).toBe(true);
    });

    it('requires every reference to resolve in a complete Snapshot', () => {
      const orphan = { ...bookmark, parentId: '019b3ca2-9a3f-7e07-8f18-000000000000' };
      expect(validateColpDocument('snapshot', { ...snapshot, nodes: [snapshot.nodes[0], orphan] })).toMatchObject({
        valid: false,
        stage: 'semantic',
        issues: expect.arrayContaining([expect.objectContaining({ code: 'missing_parent' })]),
      });
    });

    it('defers references that may live on another page of a paged Snapshot', () => {
      const firstPage = {
        ...snapshot,
        complete: false,
        nodes: [bookmark],
        page: { nextCursor: 'page-2', hasMore: true, sequence: 1 },
      };
      expect(validateColpDocument('snapshot', firstPage).valid).toBe(true);
      expect(validateColpDocument('snapshot', firstPage, {
        snapshot: { referenceResolution: { mode: 'collection', resolveNode: () => undefined } },
      })).toMatchObject({ valid: false, stage: 'semantic' });
    });
  });

  describe('Problem defaults', () => {
    const problem = example('problem.json');

    it('checks the registry entry for the code', () => {
      expect(validateColpDocument('problem', { ...problem, status: 409 })).toMatchObject({
        valid: false,
        stage: 'semantic',
        issues: [expect.objectContaining({ code: 'problem_registry_status_mismatch' })],
      });
    });

    it('checks the response status and Content-Type when they are supplied', () => {
      expect(validateColpDocument('problem', problem, { problem: { httpStatus: 500 } })).toMatchObject({
        valid: false,
        issues: [expect.objectContaining({ code: 'problem_status_mismatch' })],
      });
      expect(validateColpDocument('problem', problem, { problem: { contentType: 'application/json' } }))
        .toMatchObject({ valid: false, issues: [expect.objectContaining({ code: 'problem_content_type_mismatch' })] });
      expect(validateColpDocument('problem', problem, {
        problem: { httpStatus: 412, contentType: 'application/problem+json; charset=utf-8' },
      }).valid).toBe(true);
    });
  });

  describe('Bookmark URL hashes', () => {
    const detail = example<{ node: Record<string, unknown> }>('node-detail.json');
    const bookmarkCreate = { kind: 'bookmark', title: 'Radix', url: 'https://github.com/radix-ui/primitives' };
    const createRequest = { parentId: '019b3ca2-9a3f-7e07-8f18-cc4f2cb4bca8', node: { ...bookmarkCreate, urlHash: wrongHash } };

    it.each([
      ['node', { ...detail.node, urlHash: wrongHash }, '/urlHash'],
      ['nodeDetail', { ...detail, node: { ...detail.node, urlHash: wrongHash } }, '/node/urlHash'],
      ['nodeCreate', { ...bookmarkCreate, urlHash: wrongHash }, '/urlHash'],
      ['nodeCreateRequest', createRequest, '/node/urlHash'],
      ['createNodeOperationPayload', createRequest, '/node/urlHash'],
    ] as const)('rejects a mismatched hash in %s', (definition, value, path) => {
      expect(validateColpDocument(definition, value)).toMatchObject({
        valid: false,
        stage: 'semantic',
        issues: [expect.objectContaining({ code: 'url_hash_mismatch', path })],
      });
    });

    it('accepts a matching hash', () => {
      expect(validateColpDocument('node', detail.node).valid).toBe(true);
      expect(validateColpDocument('nodeCreate', {
        ...bookmarkCreate,
        urlHash: createUrlHash(bookmarkCreate.url),
      }).valid).toBe(true);
    });
  });

  it('lets the caller replace the semantic checks', () => {
    const manifest = example<Manifest>('public-manifest.json');
    const issue = { code: 'host_rule', path: '/title', message: 'Title is reserved.' };
    const validateSemantics = vi.fn((value: Manifest) => (value.title === manifest.title
      ? { valid: false, issues: [issue] } as const
      : { valid: true, issues: [] } as const));
    expect(validateColpDocument('manifest', manifest, { validateSemantics })).toEqual({
      valid: false,
      stage: 'semantic',
      issues: [issue],
    });
    expect(validateSemantics).toHaveBeenCalledWith(manifest);
  });

  it('uses a caller-supplied validator registry', () => {
    const canonical = createValidatorRegistry();
    const validate = vi.fn((name: DefinitionName, value: unknown) => canonical.validate(name, value));
    const registry = { definitionNames: canonical.definitionNames, get: canonical.get, validate };
    expect(validateColpDocument('collectionDirectory', example('collection-directory.json'), {
      validators: registry,
    }).valid).toBe(true);
    expect(validate).toHaveBeenCalledWith('collectionDirectory', expect.anything());
  });

  it('rejects option objects a typo could weaken', () => {
    const manifest = example('public-manifest.json');
    expect(() => validateColpDocument('manifest', manifest, { snapshots: {} } as never))
      .toThrow('Unknown COLP document validation option: snapshots.');
    expect(() => validateColpDocument('manifest', manifest, { limits: {} } as never))
      .toThrow('Unknown COLP document validation option: limits.');
    expect(() => validateColpDocument('manifest', manifest, { [Symbol('x')]: true } as never))
      .toThrow('Unknown COLP document validation option');
    expect(() => validateColpDocument('manifest', manifest, new Proxy({}, {}))).toThrow('must be a plain object');
    expect(() => validateColpDocument('manifest', manifest, null as never)).toThrow('must be a plain object');
    expect(() => validateColpDocument('manifest', manifest, [] as never)).toThrow('must be a plain object');
    const accessor = Object.defineProperty({}, 'snapshot', { enumerable: true, get: () => ({}) });
    expect(() => validateColpDocument('manifest', manifest, accessor)).toThrow('must be a data property');
  });

  it('rejects an unknown definition name', () => {
    expect(() => validateColpDocument('notADefinition' as DefinitionName, {})).toThrow(RangeError);
  });
});

describe('validateColpJsonDocument', () => {
  it('parses and validates source text', () => {
    const result = validateColpJsonDocument('snapshot', source('collection-snapshot.json'));
    expect(result.valid).toBe(true);
    if (result.valid) expectTypeOf(result.value).toEqualTypeOf<Snapshot>();
  });

  it('reports the stage that rejected the document', () => {
    expect(validateColpJsonDocument('manifest', '{"title":')).toMatchObject({ valid: false, stage: 'parse' });
    expect(validateColpJsonDocument('manifest', '{}')).toMatchObject({ valid: false, stage: 'structural' });
    const problem = { ...example('problem.json'), status: 409 };
    expect(validateColpJsonDocument('problem', JSON.stringify(problem))).toMatchObject({
      valid: false,
      stage: 'semantic',
    });
  });

  it('applies the caller I-JSON limits', () => {
    expect(validateColpJsonDocument('manifest', source('public-manifest.json'), { limits: { maxDepth: 2 } }))
      .toMatchObject({ valid: false, stage: 'parse' });
  });
});

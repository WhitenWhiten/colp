import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it, vi } from 'vitest';

import {
  ColpClient,
  ColpWireValidationError,
  type ClientCache,
} from '../../src/client/index.js';
import {
  collectionProtocolSchema,
  createAjv,
  createValidatorRegistry,
  validateWireDocument,
  type ValidatorRegistry,
} from '../../src/schema/index.js';
import { validateSnapshotSemantics } from '../../src/semantic/index.js';
import { validateServerWireDocument } from '../../src/server/index.js';
import type { Snapshot } from '../../src/types/index.js';
import { problemJsonResponse } from '../helpers/http-responses.js';

const evidence = '[evidence:core.asserted-format-then-semantics]';
const fixturesRoot = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');
const manifestUrl = 'https://alice.example/.well-known/collection-protocol';
const collectionId = '019b3ca2-8424-7cc2-9a61-4bf44c23f07a';

function fixture(name: string): Record<string, any> {
  return JSON.parse(readFileSync(resolve(fixturesRoot, name), 'utf8')) as Record<string, any>;
}

describe(`CORE-0024 asserted formats followed by semantics ${evidence}`, () => {
  it('runs parse, structural format assertions, and semantics in order for a valid document', () => {
    const events: string[] = [];
    const delegate = createValidatorRegistry();
    const validators: ValidatorRegistry = {
      definitionNames: delegate.definitionNames,
      get: (name) => delegate.get(name),
      validate(name, value) {
        events.push('structure-and-format');
        return delegate.validate(name, value);
      },
    };
    const snapshot = fixture('collection-snapshot.json');
    const semantics = vi.fn((value: Snapshot) => {
      events.push('semantic');
      return validateSnapshotSemantics(value);
    });

    const result = validateServerWireDocument<Snapshot, { code: string }>(
      validators,
      'snapshot',
      JSON.stringify(snapshot),
      semantics,
    );

    expect(result).toEqual({ valid: true, value: snapshot });
    expect(events).toEqual(['structure-and-format', 'semantic']);
    expect(semantics).toHaveBeenCalledOnce();
  });

  const structuralFailures = [
    {
      label: 'wrong JSON type',
      definition: 'absoluteUri' as const,
      value: 42,
      keyword: 'type',
    },
    {
      label: 'missing required member',
      definition: 'manifest' as const,
      value: (() => {
        const manifest = fixture('public-manifest.json');
        delete manifest.protocol;
        return manifest;
      })(),
      keyword: 'required',
    },
    {
      label: 'unknown core member',
      definition: 'manifest' as const,
      value: { ...fixture('public-manifest.json'), futureCoreField: true },
      keyword: 'additionalProperties',
    },
    {
      label: 'invalid RFC 3339 date-time',
      definition: 'dateTime' as const,
      value: '2026-02-30T12:00:00Z',
      keyword: 'format',
    },
    {
      label: 'invalid absolute URI',
      definition: 'absoluteUri' as const,
      value: 'https://[::1',
      keyword: 'format',
    },
    {
      label: 'invalid Level 1 URI Template',
      definition: 'httpsUriTemplate' as const,
      value: 'https://api.example.test/c/{+collectionId}',
      keyword: 'format',
    },
  ] as const;

  it.each(structuralFailures)(
    'skips semantics after $label',
    ({ definition, value, keyword }) => {
      const semantics = vi.fn(() => ({ valid: true as const, issues: [] as const }));

      const result = validateWireDocument(
        createValidatorRegistry(),
        definition,
        value,
        semantics,
      );

      expect(result).toMatchObject({ valid: false, stage: 'structural' });
      if (result.valid || result.stage !== 'structural') return;
      expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ keyword })]));
      expect(semantics).not.toHaveBeenCalled();
    },
  );

  it('calls semantics exactly once only after valid structure and returns semantic details', () => {
    const issue = { code: 'semantic-test', message: 'semantic detail', path: '/value' } as const;
    const semantics = vi.fn(() => ({ valid: false as const, issues: [issue] as const }));

    const result = validateWireDocument(
      createValidatorRegistry(),
      'absoluteUri',
      'https://example.test/resource',
      semantics,
    );

    expect(result).toEqual({ valid: false, stage: 'semantic', issues: [issue] });
    expect(semantics).toHaveBeenCalledOnce();
    expect(semantics).toHaveBeenCalledWith('https://example.test/resource');
  });

  it('invokes a no-op semantic callback for a wire type with no additional semantic rules', () => {
    const semantics = vi.fn(() => ({ valid: true as const, issues: [] as const }));

    const result = validateWireDocument(
      createValidatorRegistry(),
      'dateTime',
      '2026-07-17T04:00:00Z',
      semantics,
    );

    expect(result).toEqual({ valid: true, value: '2026-07-17T04:00:00Z' });
    expect(semantics).toHaveBeenCalledOnce();
  });

  it('forces format assertions when supported Ajv construction requests validateFormats false', () => {
    const validators = createValidatorRegistry(createAjv({ validateFormats: false }));

    expect(validators.validate('dateTime', 'not-a-date').valid).toBe(false);
    expect(validators.validate('absoluteUri', 'https://[::1').valid).toBe(false);
    expect(validators.validate('httpsUriTemplate', 'https://example.test/{+id}').valid).toBe(false);
  });

  it('rejects a caller-supplied Ajv with format validation disabled', () => {
    expect(() =>
      createValidatorRegistry(new Ajv2020({ strict: false, validateFormats: false })),
    ).toThrow('requires format assertions');
  });

  it('replaces caller format overrides that would weaken protocol assertions', () => {
    const ajv = new Ajv2020({ strict: false, validateFormats: true });
    ajv.addFormat('date-time', () => true);
    ajv.addFormat('uri', () => true);
    ajv.addFormat('uri-template', () => true);

    const validators = createValidatorRegistry(ajv);

    expect(validators.validate('dateTime', 'not-a-date').valid).toBe(false);
    expect(validators.validate('absoluteUri', 'https://[::1').valid).toBe(false);
    expect(validators.validate('httpsUriTemplate', 'https://example.test/{+id}').valid).toBe(false);
  });

  it('eagerly compiles every definition on a supplied Ajv without trusting its validators', () => {
    class CallerAjv extends Ajv2020 {}
    const ajv = new CallerAjv({ strict: false, validateFormats: true });
    const permissive = Object.assign(() => true, {
      errors: null,
      schema: {},
      schemaEnv: {},
    }) as unknown as ReturnType<typeof ajv.compile>;
    const compile = vi.spyOn(ajv, 'compile').mockReturnValue(permissive);

    const validators = createValidatorRegistry(ajv);

    expect(compile).toHaveBeenCalledTimes(validators.definitionNames.length);
    expect(validators.validate('dateTime', 'not-a-date').valid).toBe(false);
  });

  it('is not weakened by caller Ajv mutation after registry construction', () => {
    const ajv = createAjv();
    const validators = createValidatorRegistry(ajv);
    ajv.removeSchema();
    ajv.addFormat('date-time', () => true);
    ajv.addFormat('uri', () => true);
    ajv.addFormat('uri-template', () => true);

    expect(validators.validate('dateTime', 'not-a-date').valid).toBe(false);
    expect(validators.validate('absoluteUri', 'https://[::1').valid).toBe(false);
    expect(validators.validate('httpsUriTemplate', 'https://example.test/{+id}').valid).toBe(false);
  });

  it('canonical validation rejects an invalid value before an untrusted wrapper can repair it', () => {
    const manifest = fixture('public-manifest.json');
    delete manifest.protocol;
    const semantics = vi.fn((_value: unknown) => ({ valid: true as const, issues: [] as const }));
    const validate = vi.fn((_name, value: any) => {
      value.protocol = 'collection-protocol';
      return { valid: true as const, errors: [] as const };
    });
    const delegate = createValidatorRegistry();
    const wrapper: ValidatorRegistry = {
      definitionNames: delegate.definitionNames,
      get: (name) => delegate.get(name),
      validate,
    };

    const result = validateWireDocument(wrapper, 'manifest', manifest, semantics);

    expect(result).toMatchObject({ valid: false, stage: 'structural' });
    expect(validate).not.toHaveBeenCalled();
    expect(semantics).not.toHaveBeenCalled();
  });

  it('canonical revalidation rejects mutation by an untrusted wrapper before semantics', () => {
    const snapshot = fixture('collection-snapshot.json');
    const semantics = vi.fn(() => ({ valid: true as const, issues: [] as const }));
    const delegate = createValidatorRegistry();
    const wrapper: ValidatorRegistry = {
      definitionNames: delegate.definitionNames,
      get: (name) => delegate.get(name),
      validate(_name, value: any) {
        value.generatedAt = '2026-02-30T12:00:00Z';
        return { valid: true, errors: [] };
      },
    };

    const result = validateWireDocument(wrapper, 'snapshot', snapshot, semantics);

    expect(result).toMatchObject({ valid: false, stage: 'structural' });
    if (result.valid || result.stage !== 'structural') return;
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ keyword: 'format', instancePath: '/generatedAt' }),
    ]));
    expect(semantics).not.toHaveBeenCalled();
  });

  it('rejects malformed validation results from an untrusted wrapper', () => {
    const snapshot = fixture('collection-snapshot.json');
    const delegate = createValidatorRegistry();
    const wrapper: ValidatorRegistry = {
      definitionNames: delegate.definitionNames,
      get: (name) => delegate.get(name),
      validate: () => ({ valid: true, errors: null } as never),
    };

    expect(() => validateWireDocument(
      wrapper,
      'snapshot',
      snapshot,
      () => ({ valid: true as const, issues: [] as const }),
    )).toThrow(/boolean valid and an errors array/u);
  });

  it('stops the server receive boundary at parse failure without semantics or dispatch', () => {
    const semantics = vi.fn((_value: unknown) => ({ valid: true as const, issues: [] as const }));
    const dispatch = vi.fn();

    const result = validateServerWireDocument(
      createValidatorRegistry(),
      'manifest',
      '{"duplicate":1,"duplicate":2}',
      (value) => {
        semantics(value);
        dispatch(value);
        return { valid: true as const, issues: [] as const };
      },
    );

    expect(result).toMatchObject({ valid: false, stage: 'parse' });
    expect(semantics).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('does not cache or dispatch a semantically invalid received Manifest', async () => {
    const manifest = fixture('public-manifest.json');
    manifest.mounts[0].endpoints.node = 'https://alice.example/n/{annotationId}';
    const cache: ClientCache = {
      get: vi.fn(() => undefined),
      set: vi.fn(),
      delete: vi.fn(),
    };
    const mountSelector = vi.fn(() => manifest.mounts[0].id as string);
    const fetch = vi.fn(async () =>
      Response.json(manifest, { headers: { ETag: '"invalid-manifest"' } }),
    );
    const client = new ColpClient({
      manifestUrl,
      fetch: fetch as typeof globalThis.fetch,
      cache,
      mountSelector,
    });

    await expect(client.discover()).rejects.toThrow('Manifest semantic validation failed');
    expect(cache.set).not.toHaveBeenCalled();
    expect(mountSelector).not.toHaveBeenCalled();
  });

  it('revalidates and evicts a semantically invalid cached representation before dispatch', async () => {
    const manifest = fixture('public-manifest.json');
    manifest.mounts[0].endpoints.node = 'https://alice.example/n/{annotationId}';
    const cache: ClientCache = {
      get: vi.fn(() => ({ etag: '"cached-manifest"', representation: manifest })),
      set: vi.fn(),
      delete: vi.fn(),
    };
    const mountSelector = vi.fn(() => manifest.mounts[0].id as string);
    const fetch = vi.fn(async () =>
      new Response(null, { status: 304, headers: { ETag: '"cached-manifest"' } }),
    );
    const client = new ColpClient({
      manifestUrl,
      fetch: fetch as typeof globalThis.fetch,
      cache,
      mountSelector,
    });

    await expect(client.discover()).rejects.toThrow('Cached manifest semantic validation failed');
    expect(cache.delete).toHaveBeenCalledOnce();
    expect(cache.set).not.toHaveBeenCalled();
    expect(mountSelector).not.toHaveBeenCalled();
  });

  it('does not follow pagination after semantic validation rejects the current page', async () => {
    const manifest = fixture('public-manifest.json');
    const snapshot = fixture('collection-snapshot.json');
    snapshot.page = { nextCursor: 'page-2', hasMore: true, sequence: 1 };
    snapshot.nodes[1]!.parentId = snapshot.nodes[1]!.id;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === '/.well-known/collection-protocol') return Response.json(manifest);
      return Response.json(snapshot, {
        headers: {
          ETag: '"snapshot-page-1"',
          Link: '<https://alice.example/page?pageCursor=page-2>; rel="next"',
        },
      });
    });
    const client = new ColpClient({ manifestUrl, fetch: fetch as typeof globalThis.fetch });

    await expect(client.getSnapshot(collectionId)).rejects.toThrow(
      'Snapshot semantic validation failed',
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('preserves client parse causes and complete structural and semantic diagnostics', async () => {
    const parseClient = new ColpClient({
      manifestUrl,
      fetch: vi.fn(async () => new Response('{"duplicate":1,"duplicate":2}')) as typeof globalThis.fetch,
    });
    const parseError = await parseClient.discover().catch((error: unknown) => error);
    expect(parseError).toBeInstanceOf(ColpWireValidationError);
    const parseValidationError = parseError as ColpWireValidationError;
    expect(parseValidationError).toMatchObject({ stage: 'parse', definition: 'manifest' });
    expect(parseValidationError.details).toBeInstanceOf(Error);
    expect(parseValidationError.cause).toBe(parseValidationError.details);

    const malformedManifest = fixture('public-manifest.json');
    malformedManifest.serverId = 'https://[::1';
    const structuralClient = new ColpClient({
      manifestUrl,
      fetch: vi.fn(async () => Response.json(malformedManifest)) as typeof globalThis.fetch,
    });
    const structuralError = await structuralClient.discover().catch((error: unknown) => error);
    expect(structuralError).toBeInstanceOf(ColpWireValidationError);
    const structuralValidationError = structuralError as ColpWireValidationError;
    expect(structuralValidationError).toMatchObject({ stage: 'structural', definition: 'manifest' });
    expect(structuralValidationError.details).toEqual(expect.arrayContaining([
      expect.objectContaining({ keyword: 'format', instancePath: '/serverId' }),
    ]));
    expect(structuralValidationError.cause).toBeUndefined();

    const semanticManifest = fixture('public-manifest.json');
    semanticManifest.mounts[0].endpoints.node = 'https://alice.example/n/{annotationId}';
    const semanticClient = new ColpClient({
      manifestUrl,
      fetch: vi.fn(async () => Response.json(semanticManifest)) as typeof globalThis.fetch,
    });
    const semanticError = await semanticClient.discover().catch((error: unknown) => error);
    expect(semanticError).toBeInstanceOf(ColpWireValidationError);
    const semanticValidationError = semanticError as ColpWireValidationError;
    expect(semanticValidationError).toMatchObject({ stage: 'semantic', definition: 'manifest' });
    expect(semanticValidationError.details).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'invalid_endpoint_variables',
        path: '/mounts/0/endpoints/node',
      }),
    ]));
  });

  it('schema- and format-validates Problem Details before surfacing a protocol error', async () => {
    const problem = fixture('problem.json');
    problem.type = 'https://[::1';
    const client = new ColpClient({
      manifestUrl,
      fetch: vi.fn(async () => problemJsonResponse(problem, { status: 400 })) as typeof globalThis.fetch,
    });

    const error = await client.discover().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ColpWireValidationError);
    const validationError = error as ColpWireValidationError;
    expect(validationError).toMatchObject({ stage: 'structural', definition: 'problem' });
    expect(validationError.details).toEqual(expect.arrayContaining([
      expect.objectContaining({ keyword: 'format', instancePath: '/type' }),
    ]));
  });
});

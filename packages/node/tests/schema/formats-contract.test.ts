import { describe, expect, it } from 'vitest';

import { Ajv2020 } from 'ajv/dist/2020.js';

import {
  createAjv,
  createValidatorRegistry,
  isLevelOneUriTemplate,
  isRfc3339DateTime,
} from '../../src/schema/index.js';

describe('schema format assertion contracts', () => {
  const registry = createValidatorRegistry();

  it.each([
    '2026-07-16T07:00:00Z',
    '2024-02-29T23:59:59.999+14:00',
    '1990-12-31T23:59:60Z',
    '1991-01-01T00:59:60+01:00',
    '1990-12-31T22:59:60-01:00',
  ])('accepts RFC 3339 date-time %s', (value) => {
    expect(registry.validate('dateTime', value)).toEqual({ valid: true, errors: [] });
  });

  it.each([
    '2023-02-29T12:00:00Z',
    '2026-07-16T07:00:00',
    '2026-07-16T07:00:00+24:00',
    '2024-04-31T23:59:59Z',
    '2024-12-31T22:59:60Z',
    '2025-01-01T00:59:60Z',
    '2025-01-01T00:58:60+01:00',
    'not-a-date-time',
  ])('rejects invalid RFC 3339 date-time %s', (value) => {
    expect(registry.validate('dateTime', value).valid).toBe(false);
  });

  it.each([
    'https://example.test/collections/c-1?view=full#top',
    'urn:isbn:9780141036144',
    'https://example.test/a%20b',
  ])('accepts absolute RFC 3986 URI %s', (value) => {
    expect(registry.validate('absoluteUri', value)).toEqual({ valid: true, errors: [] });
  });

  it.each([
    '/collections/c-1',
    'collections/c-1',
    'https://[::1',
    'https://example.test/path with space',
    'https://example.test/%zz',
  ])('rejects relative or invalid URI %s', (value) => {
    expect(registry.validate('absoluteUri', value).valid).toBe(false);
  });

  it.each([
    'https://api.example.test/c/{collectionId}',
    'https://api.example.test/c/{collectionId}/nodes/{nodeId}',
    'http://127.0.0.1:3000/c/{collectionId}',
    "https://api.example.test/people/o'hara/{collection.id}",
  ])('accepts an absolute Level 1 service URI Template %s', (value) => {
    expect(registry.validate('httpsUriTemplate', value)).toEqual({ valid: true, errors: [] });
  });

  it.each([
    'https://api.example.test/c/{+collectionId}',
    'https://api.example.test/c/{collectionId:3}',
    'https://api.example.test/c/{collectionId',
    'https://user@example.test/c/{collectionId}',
    'http://api.example.test/c/{collectionId}',
    'https://api.example.test/c/{collection Id}',
    'https://api.example.test/c/{collection..id}',
    'https://api.example.test/c/{collection.}',
    'https://api.example.test/c/{.collection}',
  ])('rejects a higher-level, malformed, or unsafe service URI Template %s', (value) => {
    expect(registry.validate('httpsUriTemplate', value).valid).toBe(false);
  });

  it('keeps formats asserted through supported validator construction [evidence:schema.formats]', () => {
    const configuredRegistry = createValidatorRegistry(createAjv({ validateFormats: false }));

    expect(configuredRegistry.validate('dateTime', 'not-a-date-time').valid).toBe(false);
    expect(configuredRegistry.validate('absoluteUri', 'https://[::1').valid).toBe(false);
    expect(
      configuredRegistry.validate(
        'httpsUriTemplate',
        'https://api.example.test/c/{+collectionId}',
      ).valid,
    ).toBe(false);
  });

  it('installs assertions on a caller-supplied Ajv and refuses disabled formats', () => {
    const suppliedAjv = new Ajv2020({ strict: false, validateFormats: true });
    const suppliedRegistry = createValidatorRegistry(suppliedAjv);

    expect(suppliedRegistry.validate('dateTime', 'not-a-date-time').valid).toBe(false);
    expect(() =>
      createValidatorRegistry(new Ajv2020({ strict: false, validateFormats: false })),
    ).toThrow('requires format assertions');
  });

  it('asserts helpers at calendar and RFC 6570 grammar boundaries', () => {
    expect(isRfc3339DateTime('2024-06-30T23:59:60Z')).toBe(true);
    expect(isRfc3339DateTime('2024-06-29T23:59:60Z')).toBe(false);
    expect(isLevelOneUriTemplate('https://example.test/{one.two,%74hree}')).toBe(true);
    expect(isLevelOneUriTemplate('https://example.test/{one..two}')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import {
  preparePublicationQuery,
  PublicationQueryError,
} from '../../src/client/index.js';
import { createValidatorRegistry } from '../../src/schema/index.js';

const evidence = 'http.query-codec';
const STABLE_INVALID_QUERY = 'invalid_query: Publication query is invalid.';
const validators = createValidatorRegistry();

function prepare(
  endpoint: 'directory' | 'collection' | 'snapshot' | 'node',
  endpointUrl: string,
  query: unknown,
): URL {
  return preparePublicationQuery(endpoint, endpointUrl, query, validators);
}

function catchPrepare(
  endpoint: 'directory' | 'collection' | 'snapshot' | 'node',
  endpointUrl: string,
  query: unknown,
): unknown {
  try {
    prepare(endpoint, endpointUrl, query);
    return undefined;
  } catch (error) {
    return error;
  }
}

function expectStablePublicationQueryError(
  thrown: unknown,
  options?: {
    readonly issues?: readonly string[];
    readonly minIssues?: number;
    readonly secret?: string;
  },
): asserts thrown is PublicationQueryError {
  expect(thrown).toBeInstanceOf(PublicationQueryError);
  expect(thrown).toBeInstanceOf(TypeError);
  expect(thrown).toMatchObject({
    name: 'PublicationQueryError',
    message: STABLE_INVALID_QUERY,
    code: 'invalid_query',
  });

  const error = thrown as PublicationQueryError;
  expect(Array.isArray(error.issues)).toBe(true);
  expect(Object.isFrozen(error.issues)).toBe(true);
  expect(error.message).toBe(STABLE_INVALID_QUERY);
  expect(error.message).not.toMatch(/\bmust (?:be|match|have)\b/iu);
  expect(error.message).not.toContain('instancePath');
  expect(error.message).not.toContain('additionalProperties');

  for (const issue of error.issues) {
    expect(typeof issue).toBe('string');
    // Stable sanitized phrases only — never raw AJV schema dumps.
    expect(issue).not.toMatch(/\bmust (?:be|match|have)\b/iu);
    expect(issue).not.toMatch(/instancePath/iu);
    expect(issue).not.toMatch(/additionalProperties/iu);
    expect(issue).not.toMatch(/\$ref/iu);
  }

  if (options?.issues !== undefined) {
    expect([...error.issues]).toEqual([...options.issues]);
  }
  if (options?.minIssues !== undefined) {
    expect(error.issues.length).toBeGreaterThanOrEqual(options.minIssues);
  }
  if (options?.secret !== undefined) {
    const surface = JSON.stringify({
      message: error.message,
      code: error.code,
      issues: error.issues,
      name: error.name,
    });
    expect(surface).not.toContain(options.secret);
    expect(String(error)).not.toContain(options.secret);
  }
}

describe(`PublicationQueryError stable contract [evidence:${evidence}]`, () => {
  it('is a TypeError subclass with frozen issues and exact stable message [evidence:http.query-codec]', () => {
    const error = new PublicationQueryError(['Unknown query parameter.']);
    expect(error).toBeInstanceOf(TypeError);
    expect(error).toBeInstanceOf(PublicationQueryError);
    expect(error).toMatchObject({
      name: 'PublicationQueryError',
      message: STABLE_INVALID_QUERY,
      code: 'invalid_query',
    });
    expect(Object.isFrozen(error.issues)).toBe(true);
    expect([...error.issues]).toEqual(['Unknown query parameter.']);
  });

  it('defaults issues to a frozen empty array [evidence:http.query-codec]', () => {
    const error = new PublicationQueryError();
    expect(error.issues).toEqual([]);
    expect(Object.isFrozen(error.issues)).toBe(true);
  });

  it('rejects invalid DTO input with empty issues and no AJV/detail message suffix [evidence:http.query-codec]', () => {
    const thrown = catchPrepare('directory', 'https://api.example/directory', { unknown: 'value' });
    expectStablePublicationQueryError(thrown);
    expect(thrown.issues).toEqual([]);
  });

  it.each([
    [
      'unknown fixed key',
      'directory' as const,
      'https://api.example/directory?secret=fixed-secret-value',
      { q: 'ok' },
      'fixed-secret-value',
      ['Unknown query parameter.'] as const,
    ],
    [
      'malformed fixed percent',
      'directory' as const,
      'https://api.example/directory?q=%&token=percent-secret',
      {},
      'percent-secret',
      ['Publication query encoding is invalid.'] as const,
    ],
    [
      'no-query fixed query',
      'collection' as const,
      'https://api.example/collection?q=collection-secret',
      {},
      'collection-secret',
      ['This Publication endpoint does not accept a query.'] as const,
    ],
    [
      'caller duplicates fixed scalar',
      'directory' as const,
      'https://api.example/directory?limit=1&tag=dup-secret',
      { limit: 2 },
      'dup-secret',
      ['Query parameter must appear once.'] as const,
    ],
  ])(
    'decode-failure path %s exposes stable issues without reflecting secrets [evidence:http.query-codec]',
    (_name, endpoint, endpointUrl, query, secret, expectedIssues) => {
      const thrown = catchPrepare(endpoint, endpointUrl, query);
      expectStablePublicationQueryError(thrown, {
        issues: expectedIssues,
        secret,
      });
      // Message must remain exact even when issues carry sanitized detail.
      expect(thrown.message).toBe(STABLE_INVALID_QUERY);
      expect(thrown.message).not.toContain(expectedIssues[0]);
    },
  );

  it('rejects control characters in endpoint URL text with stable invalid_query [evidence:http.query-codec]', () => {
    const thrown = catchPrepare(
      'directory',
      'https://api.example/directory?q=before\tafter&token=tab-secret',
      {},
    );
    expectStablePublicationQueryError(thrown, { secret: 'tab-secret' });
  });

  it('never appends decoded detail onto the stable message [evidence:http.query-codec]', () => {
    const thrown = catchPrepare(
      'directory',
      'https://api.example/directory?secret=leak-me',
      { q: 'ok' },
    );
    expectStablePublicationQueryError(thrown, {
      minIssues: 1,
      secret: 'leak-me',
    });
    expect(thrown.message.endsWith('.')).toBe(true);
    expect(thrown.message.split('\n')).toHaveLength(1);
    expect(thrown.message).toBe(STABLE_INVALID_QUERY);
  });
});

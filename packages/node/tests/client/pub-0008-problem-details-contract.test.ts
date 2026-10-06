import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  ColpClient,
  ColpProblemError,
  ColpWireValidationError,
} from '../../src/client/index.js';

const evidence = '[evidence:http.problems]';
const manifestUrl = 'https://manifest.example/.well-known/collection-protocol';
const defaultEndpoint = 'https://api.example/publication/catalog.json';
const fixturesRoot = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');
const secret = 'Bearer publication-super-secret';

interface ProblemRun {
  readonly error: unknown;
  readonly requested: readonly string[];
}

interface RunOptions {
  readonly problem?: unknown;
  readonly rawBody?: string;
  readonly rawBytes?: Uint8Array;
  readonly httpStatus?: number;
  readonly contentType?: string | readonly string[] | null;
  readonly endpoint?: string;
}

function baseProblem(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    type: 'https://collectionprotocol.org/problems/resource-not-found',
    title: 'Resource not found',
    status: 404,
    code: 'resource_not_found',
    ...overrides,
  };
}

function requestUrl(input: string | URL | Request): URL {
  return new URL(input instanceof Request ? input.url : input.toString());
}

async function runProblem(options: RunOptions = {}): Promise<ProblemRun> {
  const manifest = JSON.parse(
    await readFile(resolve(fixturesRoot, 'public-manifest.json'), 'utf8'),
  ) as Record<string, any>;
  const endpoint = options.endpoint ?? defaultEndpoint;
  manifest.mounts[0].endpoints.directory = endpoint;
  const requested: string[] = [];
  const body = options.rawBody ?? JSON.stringify(options.problem ?? baseProblem());
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = requestUrl(input);
    requested.push(url.href);
    if (url.href === manifestUrl) return Response.json(manifest);
    if (url.href !== endpoint) throw new Error(`Undeclared endpoint requested: ${url.href}`);
    const headers = new Headers();
    if (options.contentType !== null) {
      const contentTypes = Array.isArray(options.contentType)
        ? options.contentType
        : [options.contentType ?? 'application/problem+json'];
      for (const contentType of contentTypes) headers.append('Content-Type', contentType);
    }
    return new Response(options.rawBytes ?? new TextEncoder().encode(body), {
      status: options.httpStatus ?? 404,
      headers,
    });
  });

  let error: unknown;
  try {
    await new ColpClient({
      manifestUrl,
      fetch: fetch as typeof globalThis.fetch,
    }).getDirectory();
  } catch (caught) {
    error = caught;
  }
  return { error, requested };
}

function expectSemanticProblemError(error: unknown): void {
  expect(error).toBeInstanceOf(ColpWireValidationError);
  expect(error).toMatchObject({ stage: 'semantic', definition: 'problem' });
}

function expectMediaParseProblemError(error: unknown): void {
  expect(error).toBeInstanceOf(ColpWireValidationError);
  expect(error).toMatchObject({ stage: 'parse', definition: 'problem' });
}

describe(`PUB-0008 client Problem Details contract ${evidence}`, () => {
  it.each([
    ['invalid_query', 400, false],
    ['authentication_required', 401, false],
    ['insufficient_scope', 403, false],
    ['resource_not_found', 404, false],
    ['service_unavailable', 503, true],
  ] as const)(
    `classifies registered %s from a real publication endpoint ${evidence}`,
    async (code, status, retryable) => {
      const { error, requested } = await runProblem({
        problem: baseProblem({ code, status, title: 'arbitrary human text' }),
        httpStatus: status,
      });

      expect(error).toBeInstanceOf(ColpProblemError);
      expect(error).toMatchObject({ code, status, known: true, retryable });
      expect((error as ColpProblemError).problem).toMatchObject({ code, status });
      expect(requested).toEqual([manifestUrl, defaultEndpoint]);
    },
  );

  it.each([
    'application/problem+json',
    'APPLICATION/PROBLEM+JSON',
    'application/problem+json; charset=utf-8',
    'Application/Problem+Json ; Charset="UTF-8"',
    'application/problem+json; profile="caf\u00e9"; charset=utf-8',
  ])(`accepts unambiguous Problem media type %s ${evidence}`, async (contentType) => {
    const { error } = await runProblem({ contentType });
    expect(error).toBeInstanceOf(ColpProblemError);
    expect(error).toMatchObject({ code: 'resource_not_found', status: 404 });
  });

  it.each([
    ['missing', null],
    ['ordinary JSON', 'application/json'],
    ['text JSON', 'text/plain'],
    ['suffix disguise', 'application/problem+json.evil'],
    ['non-UTF-8 charset', 'application/problem+json; charset=iso-8859-1'],
    ['repeated identical field', ['application/problem+json', 'application/problem+json']],
    ['repeated conflicting field', ['application/problem+json', 'text/plain']],
    ['unterminated quoted parameter', 'application/problem+json; charset="utf-8'],
    ['duplicate charset parameter', 'application/problem+json; charset=utf-8; CHARSET="UTF-8"'],
  ] as const)(`rejects %s Content-Type before reading Problem JSON ${evidence}`, async (_name, contentType) => {
    const { error } = await runProblem({ contentType });
    expectMediaParseProblemError(error);
  });

  it.each([
    ['HTTP differs from body', baseProblem({ status: 409 }), 404],
    ['body differs from HTTP', baseProblem({ status: 404 }), 409],
    ['known code differs from registry', baseProblem({ status: 500 }), 500],
    ['known retryable differs from registry', baseProblem({ retryable: true }), 404],
  ] as const)(`rejects %s without reclassifying the failure ${evidence}`, async (_name, problem, httpStatus) => {
    const { error } = await runProblem({ problem, httpStatus });
    expectSemanticProblemError(error);
    expect(error).not.toBeInstanceOf(ColpProblemError);
  });

  it.each([
    ['https://vendor.example/problems/quota', 429, true],
    ['HTTPS://vendor.example/problems/custom-conflict', 409, undefined],
  ] as const)(
    `classifies HTTPS extension code %s without a core registry lookup ${evidence}`,
    async (code, status, retryable) => {
      const { error } = await runProblem({
        problem: baseProblem({ code, status, retryable }),
        httpStatus: status,
      });
      expect(error).toBeInstanceOf(ColpProblemError);
      expect(error).toMatchObject({ code, status, known: false, retryable });
    },
  );

  it(`rejects an HTTPS extension namespace containing user information ${evidence}`, async () => {
    const { error } = await runProblem({
      problem: baseProblem({ code: 'https://private@vendor.example/problems/custom' }),
    });
    expectSemanticProblemError(error);
  });

  it.each([
    ['invalid JSON', '{'],
    ['duplicate I-JSON member', '{"type":"https://errors.example/x","title":"x","status":404,"status":409,"code":"resource_not_found"}'],
    ['unsafe I-JSON member', '{"type":"https://errors.example/x","title":"x","status":404,"code":"resource_not_found","__proto__":{}}'],
    ['missing type', JSON.stringify({ title: 'x', status: 404, code: 'resource_not_found' })],
    ['invalid type format', JSON.stringify(baseProblem({ type: 'not an absolute URI' }))],
    ['missing title', JSON.stringify({ type: 'https://errors.example/x', status: 404, code: 'resource_not_found' })],
    ['missing status', JSON.stringify({ type: 'https://errors.example/x', title: 'x', code: 'resource_not_found' })],
    ['missing code', JSON.stringify({ type: 'https://errors.example/x', title: 'x', status: 404 })],
    ['unknown field', JSON.stringify(baseProblem({ unauthorized: true }))],
    ['unregistered short code', JSON.stringify(baseProblem({ code: 'not_registered' }))],
  ])(`preserves the original wire stage for %s ${evidence}`, async (name, rawBody) => {
    const { error } = await runProblem({
      rawBody,
      contentType: name === 'invalid JSON' ? 'text/plain' : 'application/problem+json',
    });
    expect(error).toBeInstanceOf(ColpWireValidationError);
    const parseFailure = name === 'invalid JSON'
      || name === 'duplicate I-JSON member'
      || name === 'unsafe I-JSON member';
    expect(error).toMatchObject({
      stage: parseFailure ? 'parse' : 'structural',
      definition: 'problem',
    });
  });

  it(`rejects non-UTF-8 Problem bytes at the parse stage without exposing bytes ${evidence}`, async () => {
    const { error } = await runProblem({ rawBytes: Uint8Array.of(0x7b, 0xff, 0x7d) });
    expect(error).toBeInstanceOf(ColpWireValidationError);
    expect(error).toMatchObject({ stage: 'parse', definition: 'problem' });
    expect((error as Error).message).not.toContain('\ufffd');
  });

  it.each([
    ['empty text', '', ''],
    ['localized text', '\u8d44\u6e90\u4e0d\u5b58\u5728', '\u6b64\u6587\u672c\u4e0d\u5f97\u53c2\u4e0e\u673a\u5668\u5206\u7c7b'],
    ['CRLF text', 'line one\r\nline two', 'detail\r\nX-Fake: value'],
    ['sensitive text', secret, `private note body; principal:internal-admin; ${secret}`],
  ])(`ignores title/detail variant %s for routing and recovery ${evidence}`, async (_name, title, detail) => {
    const { error } = await runProblem({ problem: baseProblem({ title, detail }) });
    expect(error).toBeInstanceOf(ColpProblemError);
    const classified = error as ColpProblemError;
    expect({
      code: classified.code,
      status: classified.status,
      known: classified.known,
      retryable: classified.retryable,
      recovery: classified.recovery,
    }).toEqual({
      code: 'resource_not_found',
      status: 404,
      known: true,
      retryable: false,
      recovery: {},
    });
  });

  it(`follows a declared cross-Origin endpoint before classifying its Problem ${evidence}`, async () => {
    const endpoint = 'https://errors.cdn.example/opaque/problems/catalog';
    const { error, requested } = await runProblem({ endpoint });

    expect(error).toBeInstanceOf(ColpProblemError);
    expect(error).toMatchObject({ code: 'resource_not_found', status: 404 });
    expect(requested).toEqual([manifestUrl, endpoint]);
  });

  it(`extracts only documented recovery fields from the production error path ${evidence}`, async () => {
    const recovery = {
      currentRevision: 'r_18',
      currentEtag: 'collection-r_18',
      expectedSequence: 19,
      supportedVersions: ['0.1'],
      retryAfterSeconds: 7,
      snapshotUrl: 'https://cdn.example/snapshots/current.json',
      conflictId: 'conflict_19',
      errors: [{ path: '/nodes/0/title', keyword: 'minLength', message: 'must not be empty' }],
      links: { current: 'https://api.example/collections/one' },
    };
    const { error } = await runProblem({
      problem: baseProblem({ code: 'precondition_failed', status: 412, ...recovery }),
      httpStatus: 412,
    });

    expect(error).toBeInstanceOf(ColpProblemError);
    expect((error as ColpProblemError).recovery).toEqual(recovery);
    expect(Object.isFrozen((error as ColpProblemError).recovery)).toBe(true);
    expect(Object.isFrozen((error as ColpProblemError).recovery.supportedVersions)).toBe(true);
    expect(Object.isFrozen((error as ColpProblemError).recovery.links)).toBe(true);
    expect(Object.isFrozen((error as ColpProblemError).recovery.errors)).toBe(true);
    expect(Object.isFrozen((error as ColpProblemError).recovery.errors?.[0])).toBe(true);
  });

  it(`keeps sensitive human text out of classification and error messages ${evidence}`, async () => {
    const signedUrl = 'https://private.example/file?X-Amz-Signature=full-private-signature';
    const { error } = await runProblem({
      problem: baseProblem({
        title: secret,
        detail: `${signedUrl}; private note body; principal:internal-admin`,
      }),
    });

    expect(error).toBeInstanceOf(ColpProblemError);
    const classified = error as ColpProblemError;
    expect(classified.message).toBe('resource_not_found (HTTP 404)');
    expect(JSON.stringify(classified.recovery)).not.toContain(secret);
    expect(JSON.stringify(classified.recovery)).not.toContain('X-Amz-Signature');
    expect(JSON.stringify(classified.recovery)).not.toContain('private note body');
    expect(JSON.stringify(classified.recovery)).not.toContain('principal:internal-admin');
  });

  it(`freezes and isolates the exposed Problem and machine classification ${evidence}`, async () => {
    const { error: first } = await runProblem({
      problem: baseProblem({ supportedVersions: ['0.1'], links: { current: defaultEndpoint } }),
    });
    const { error: second } = await runProblem({
      problem: baseProblem({ supportedVersions: ['0.1'], links: { current: defaultEndpoint } }),
    });

    expect(first).toBeInstanceOf(ColpProblemError);
    expect(second).toBeInstanceOf(ColpProblemError);
    const firstError = first as ColpProblemError;
    const secondError = second as ColpProblemError;
    expect(firstError.problem).not.toBe(secondError.problem);
    expect(firstError.recovery).not.toBe(secondError.recovery);
    expect(Object.isFrozen(firstError.problem)).toBe(true);
    expect(Object.isFrozen(firstError.problem.supportedVersions)).toBe(true);
    expect(Object.isFrozen(firstError.problem.links)).toBe(true);
    expect(firstError.recovery).toEqual(secondError.recovery);
  });
});

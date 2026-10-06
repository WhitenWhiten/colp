import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createCanonicalRequestDigest,
  createPublisherIdempotencyBinding,
  executeIdempotentPublisherWrite,
  executePublisherIdempotencyBoundary,
  mapPublisherIdempotencyResult,
  normalizePublisherMediaType,
  verifyPublisherIdempotencyRetention,
  type IdempotencyBinding,
  type IdempotencyClaim,
  type PublisherIdempotencyRequest,
  type PublisherTransaction,
  type PublisherUnitOfWork,
  type StoredPublisherResponse,
} from '../../src/publisher/index.js';
import { DEFAULT_I_JSON_PARSE_LIMITS } from '../../src/schema/index.js';

const evidence = 'publisher.idempotency-binding';
const fixturePath = resolve(
  import.meta.dirname,
  '..',
  '..',
  'fixtures',
  'protocol',
  'examples',
  'public-manifest.json',
);

const request: PublisherIdempotencyRequest = {
  principalId: 'principal-sensitive-alice',
  protocolVersion: '0.1',
  method: 'post',
  endpointKey: 'nodes',
  resourceIdentity: 'collection-sensitive-one',
  idempotencyKey: 'key-sensitive-one',
  decodedQuery: {},
  mediaType: 'Application/JSON ; Charset = UTF-8',
  body: { kind: 'folder', title: 'A title' },
};

const response: StoredPublisherResponse = {
  status: 201,
  headers: { Location: '/collections/c/one/nodes/node-one', ETag: '"revision-one"' },
  body: { id: 'node-one', revision: 'revision-one' },
};

function transactionWith(
  claim: (binding: IdempotencyBinding) => Promise<IdempotencyClaim>,
  complete = async (_binding: IdempotencyBinding, _response: StoredPublisherResponse) => undefined,
) {
  return {
    resources: {},
    idReservations: { reserveAll: async () => ({ state: 'reserved' as const }) },
    idempotency: { claim, complete },
    operations: { append: async () => undefined },
    audit: { append: async () => undefined },
    outbox: { append: async () => undefined },
  } as unknown as PublisherTransaction;
}

function unitOfWork(transaction: PublisherTransaction): PublisherUnitOfWork {
  return { execute: async (work) => work(transaction) };
}

async function manifestFixture(): Promise<Record<string, any>> {
  return JSON.parse(await readFile(fixturePath, 'utf8')) as Record<string, any>;
}

describe(`PUBLISH-0010 complete idempotency binding [evidence:${evidence}]`, () => {
  it(`binds principal, normalized method, Manifest Endpoint Key, resource, version, key, and canonical digest [evidence:${evidence}]`, () => {
    const binding = createPublisherIdempotencyBinding(request);

    expect(binding).toEqual({
      principalId: request.principalId,
      protocolVersion: request.protocolVersion,
      method: 'POST',
      endpointKey: request.endpointKey,
      resourceIdentity: request.resourceIdentity,
      key: request.idempotencyKey,
      requestDigest: expect.stringMatching(/^sha-256:[A-Za-z0-9_-]{43}$/u),
    });
    expect(Object.isFrozen(binding)).toBe(true);
  });

  it.each([
    ['principalId', 'principal-bob'],
    ['protocolVersion', '0.2'],
    ['method', 'PUT'],
    ['endpointKey', 'annotations'],
    ['resourceIdentity', 'collection-two'],
    ['key', 'key-two'],
  ] as const)(`isolates a claim when %s changes [evidence:${evidence}]`, async (field, value) => {
    const original = createPublisherIdempotencyBinding(request);
    const identity = (item: IdempotencyBinding) => [
      item.principalId,
      item.protocolVersion,
      item.method,
      item.endpointKey,
      item.resourceIdentity,
      item.key,
    ].join('\u001f');
    const digestDimension = field === 'key' ? {} : { [field]: value };
    const changed: IdempotencyBinding = {
      ...original,
      [field]: value,
      requestDigest: createCanonicalRequestDigest({
        principalId: request.principalId,
        protocolVersion: request.protocolVersion,
        method: request.method,
        endpointKey: request.endpointKey,
        resourceIdentity: request.resourceIdentity,
        query: request.decodedQuery,
        mediaType: request.mediaType,
        body: request.body,
        ...digestDimension,
      }),
    };
    const claimed = new Set<string>();
    const transaction = transactionWith(
      async function claim(binding) {
        const claimIdentity = identity(binding);
        if (claimed.has(claimIdentity)) return { state: 'replay', response };
        claimed.add(claimIdentity);
        return { state: 'claimed' };
      },
    );
    const write = vi.fn(async () => response);

    expect(identity(changed)).not.toBe(identity(original));
    await expect(executeIdempotentPublisherWrite(unitOfWork(transaction), original, write))
      .resolves.toMatchObject({ state: 'committed' });
    await expect(executeIdempotentPublisherWrite(unitOfWork(transaction), changed, write))
      .resolves.toMatchObject({ state: 'committed' });
    expect(write).toHaveBeenCalledTimes(2);
    if (field !== 'key') expect(changed.requestDigest).not.toBe(original.requestDigest);
  });

  it(`normalizes method case without splitting the binding or digest [evidence:${evidence}]`, () => {
    const lower = createPublisherIdempotencyBinding(request);
    const upper = createPublisherIdempotencyBinding({ ...request, method: 'POST' });

    expect(lower).toEqual(upper);
    expect(lower.method).toBe('POST');
  });

  it(`binds an authenticated If-Match value when a conditional operation supplies one [evidence:${evidence}]`, () => {
    const first = createPublisherIdempotencyBinding({ ...request, ifMatch: '"revision-one"' });
    const second = createPublisherIdempotencyBinding({ ...request, ifMatch: '"revision-two"' });

    expect(first.requestDigest).not.toBe(second.requestDigest);
  });

  it.each(['not-an-endpoint', 'Nodes', '/collections/c/one/nodes'])(
    `rejects non-Manifest Endpoint Key %s [evidence:${evidence}]`,
    (endpointKey) => {
      expect(() => createPublisherIdempotencyBinding({
        ...request,
        endpointKey: endpointKey as PublisherIdempotencyRequest['endpointKey'],
      })).toThrow(/Manifest Endpoint key/u);
    },
  );

  it.each([
    ['raw query string', 'page=1'],
    ['URLSearchParams', new URLSearchParams('page=1')],
    ['DTO fields prohibited by the Endpoint contract', { page: 1 }],
  ] as const)(`rejects %s at the Publisher request boundary [evidence:${evidence}]`, (_label, decodedQuery) => {
    expect(() => createPublisherIdempotencyBinding({
      ...request,
      decodedQuery: decodedQuery as never,
    })).toThrow(/decodedQuery|does not accept query parameters/u);
  });

  it(`validates a decoded query DTO against the matching Publisher operation [evidence:${evidence}]`, () => {
    const recursive = createPublisherIdempotencyBinding({
      ...request,
      method: 'DELETE',
      endpointKey: 'node',
      resourceIdentity: 'collection-sensitive-one/node-sensitive-one',
      decodedQuery: { recursive: true },
      body: null,
    });
    const nonRecursive = createPublisherIdempotencyBinding({
      ...request,
      method: 'DELETE',
      endpointKey: 'node',
      resourceIdentity: 'collection-sensitive-one/node-sensitive-one',
      decodedQuery: { recursive: false },
      body: null,
    });

    expect(recursive.requestDigest).not.toBe(nonRecursive.requestDigest);
    expect(() => createPublisherIdempotencyBinding({
      ...request,
      method: 'DELETE',
      endpointKey: 'node',
      decodedQuery: { recursive: 'yes' } as never,
      body: null,
    })).toThrow(/decodedQuery does not satisfy the Endpoint contract/u);
  });

  it(`rejects a method with no matching Publisher operation [evidence:${evidence}]`, () => {
    expect(() => createPublisherIdempotencyBinding({
      ...request,
      method: 'GET',
    })).toThrow(/not a Publisher operation/u);
  });
});

describe(`PUBLISH-0010 canonical request digest [evidence:${evidence}]`, () => {
  const digest = (overrides: Partial<Parameters<typeof createCanonicalRequestDigest>[0]> = {}) =>
    createCanonicalRequestDigest({
      principalId: 'principal-one',
      protocolVersion: '0.1',
      method: 'POST',
      endpointKey: 'nodes',
      resourceIdentity: 'collection-one',
      query: { decoded: 'a b', filters: { z: 2, a: 1 } },
      mediaType: 'application/json',
      body: { z: 0.000001, a: ['é', true, null] },
      ...overrides,
    });

  it(`uses RFC 8785 for body and Canonical JSON for the decoded query DTO [evidence:${evidence}]`, () => {
    const reordered = digest({
      query: { filters: { a: 1, z: 2 }, decoded: 'a b' },
      body: { a: ['é', true, null], z: 1e-6 },
    });

    expect(reordered).toBe(digest());
    expect(digest({ query: { decoded: 'a+b', filters: { z: 2, a: 1 } } })).not.toBe(digest());
    expect(digest({ body: { z: 0.000001, a: ['e', true, null] } })).not.toBe(digest());
  });

  it(`treats equivalent decoded query values alike regardless of wire spelling [evidence:${evidence}]`, () => {
    const fromPercentEncoding = { search: decodeURIComponent('hello%20world'), tags: ['a', 'b'] };
    const fromPlusDecoding = { tags: ['a', 'b'], search: 'hello world' };

    expect(digest({ query: fromPercentEncoding })).toBe(digest({ query: fromPlusDecoding }));
    expect(digest({ query: { ...fromPlusDecoding, tags: ['b', 'a'] } })).not.toBe(
      digest({ query: fromPlusDecoding }),
    );
  });

  it(`binds If-Match preconditions into the canonical digest [evidence:${evidence}]`, () => {
    expect(digest({ ifMatch: '"revision-one"' })).not.toBe(digest({ ifMatch: '"revision-two"' }));
    expect(digest({ ifMatch: '  "revision-one"  ' })).toBe(digest({ ifMatch: ['"revision-one"'] }));
    expect(digest({ ifMatch: null })).toBe(digest());
  });

  it(`normalizes only list separators outside opaque ETags [evidence:${evidence}]`, () => {
    expect(digest({ ifMatch: ' "first,tag" \t,\t "second" ' }))
      .toBe(digest({ ifMatch: ['"first,tag"', '"second"'] }));
    // Invalid whitespace inside a tag must not replay a successful request
    // with a different, valid precondition.
    expect(digest({ ifMatch: '"first, tag"' })).not.toBe(digest({ ifMatch: '"first,tag"' }));
    expect(digest({ ifMatch: '"first\t,tag"' })).not.toBe(digest({ ifMatch: '"first,tag"' }));
    expect(digest({ ifMatch: '"unterminated, tag' })).not.toBe(digest({ ifMatch: '"unterminated,tag' }));
  });

  it.each([
    ['raw query string', 'search=hello%20world'],
    ['URLSearchParams', new URLSearchParams('search=hello%20world')],
    ['array', ['search', 'hello world']],
    ['Date instance', new Date('2026-01-01T00:00:00Z')],
    ['non-finite number', { page: Number.NaN }],
    ['undefined member', { page: undefined }],
    ['BigInt member', { page: 1n }],
    ['lone surrogate', { search: '\uD800' }],
  ] as const)(`rejects %s instead of digesting a non-decoded/non-I-JSON query [evidence:${evidence}]`, (_label, query) => {
    expect(() => digest({ query: query as never })).toThrow(/decoded I-JSON object/u);
  });

  it(`rejects cyclic and accessor-backed query structures [evidence:${evidence}]`, () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const accessor = Object.defineProperty({}, 'page', { enumerable: true, get: () => 1 });

    expect(() => digest({ query: cyclic })).toThrow(/decoded I-JSON object/u);
    expect(() => digest({ query: accessor })).toThrow(/decoded I-JSON object/u);
  });

  it(`rejects unsafe numbers, prototype-polluting keys, and excessive nesting [evidence:${evidence}]`, () => {
    const polluted = JSON.parse('{"constructor":"attacker"}') as Record<string, unknown>;
    let deeplyNested: Record<string, unknown> = {};
    for (let depth = 0; depth < 130; depth += 1) deeplyNested = { child: deeplyNested };

    expect(() => digest({ body: { value: Number.MAX_SAFE_INTEGER + 1 } })).toThrow(/I-JSON/u);
    expect(() => digest({ body: polluted })).toThrow(/I-JSON/u);
    expect(() => digest({ body: deeplyNested })).toThrow(/I-JSON/u);
  });

  it(`accepts exact I-JSON budgets and rejects the first excess member or depth [evidence:${evidence}]`, () => {
    const nested = (depth: number): Record<string, unknown> => {
      let value: Record<string, unknown> = {};
      for (let index = 0; index < depth; index += 1) value = { child: value };
      return value;
    };
    const arrayAtLimit = Array.from(
      { length: DEFAULT_I_JSON_PARSE_LIMITS.maxMembers },
      () => null,
    );
    const arrayOverLimit = [...arrayAtLimit, null];
    const objectAtLimit = Object.fromEntries(Array.from(
      { length: DEFAULT_I_JSON_PARSE_LIMITS.maxMembers },
      (_, index) => [`member-${index}`, null],
    ));
    const objectOverLimit = { ...objectAtLimit, excess: null };

    expect(() => digest({ body: nested(DEFAULT_I_JSON_PARSE_LIMITS.maxDepth) })).not.toThrow();
    expect(() => digest({ body: nested(DEFAULT_I_JSON_PARSE_LIMITS.maxDepth + 1) })).toThrow(/I-JSON/u);
    expect(() => digest({ body: arrayAtLimit })).not.toThrow();
    expect(() => digest({ body: arrayOverLimit })).toThrow(/I-JSON/u);
    expect(() => digest({ body: objectAtLimit })).not.toThrow();
    expect(() => digest({ body: objectOverLimit })).toThrow(/I-JSON/u);
  });
});

describe(`PUBLISH-0010 media type canonicalization [evidence:${evidence}]`, () => {
  it.each([
    ['Application/JSON', 'application/json'],
    [' Application/JSON ; Charset = UTF-8\t', 'application/json;charset=utf-8'],
    ['TEXT/PLAIN;note="A B"', 'text/plain;note="a b"'],
  ] as const)(`lowercases and removes ignorable OWS from %s [evidence:${evidence}]`, (input, expected) => {
    expect(normalizePublisherMediaType(input)).toBe(expected);
  });

  it(`preserves quoted whitespace because it is not ignorable OWS [evidence:${evidence}]`, () => {
    expect(normalizePublisherMediaType('text/plain;note="A B"')).toBe('text/plain;note="a b"');
    expect(normalizePublisherMediaType('text/plain;note="A B"')).not.toBe(
      normalizePublisherMediaType('text/plain;note="AB"'),
    );
  });

  it.each([
    '',
    'application',
    'application/json; charset',
    'application/json; charset=',
    'application/json; note="unterminated',
    'application/json; note="bad\\"',
    'application/json\r\nX-Evil: yes',
    'application/json\0',
  ])(`rejects malformed, control-bearing, or invalid quoted value %j [evidence:${evidence}]`, (value) => {
    expect(() => normalizePublisherMediaType(value)).toThrow(TypeError);
  });
});

describe(`PUBLISH-0010 replay and conflict boundary [evidence:${evidence}]`, () => {
  it(`replays the same key and digest without running the write [evidence:${evidence}]`, async () => {
    const write = vi.fn(async () => response);
    const transaction = transactionWith(async () => ({ state: 'replay', response }));

    await expect(executePublisherIdempotencyBoundary(unitOfWork(transaction), request, write)).resolves.toEqual({
      state: 'replayed',
      response,
    });
    expect(write).not.toHaveBeenCalled();
  });

  it(`maps same-key different-digest reuse to a stable non-leaking 409 [evidence:${evidence}]`, async () => {
    const transaction = transactionWith(async () => ({
      state: 'conflict',
      storedRequestDigest: `sha-256:${'A'.repeat(43)}`,
    }));
    const result = await executePublisherIdempotencyBoundary(
      unitOfWork(transaction),
      { ...request, body: { kind: 'folder', title: 'Meaningfully different' } },
      async () => response,
    );

    expect(result).toEqual({
      state: 'rejected',
      status: 409,
      code: 'idempotency_key_reused',
      retryable: false,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(request.idempotencyKey);
    expect(serialized).not.toContain(request.principalId);
    expect(serialized).not.toContain(request.resourceIdentity);
    expect(serialized).not.toContain('sha-256:');
  });

  it(`maps an in-progress claim to a stable retryable non-leaking 409 [evidence:${evidence}]`, async () => {
    const result = mapPublisherIdempotencyResult({ state: 'in-progress' });

    expect(result).toEqual({
      state: 'rejected',
      status: 409,
      code: 'idempotency_in_progress',
      retryable: true,
    });
    expect(Object.keys(result).sort()).toEqual(['code', 'retryable', 'state', 'status']);
  });

  it(`returns an immutable in-progress store state without invoking the write [evidence:${evidence}]`, async () => {
    const write = vi.fn(async () => response);
    const transaction = transactionWith(async () => ({ state: 'in-progress' }));

    const result = await executeIdempotentPublisherWrite(
      unitOfWork(transaction),
      createPublisherIdempotencyBinding(request),
      write,
    );

    expect(result).toEqual({ state: 'in-progress' });
    expect(Object.isFrozen(result)).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown claim', transactionWith(async () => ({ state: 'future' } as never)), 'unknown claim state'],
    ['claim port rejection', transactionWith(async () => { throw new Error('claim unavailable'); }), 'claim unavailable'],
    ['completion port rejection', transactionWith(async () => ({ state: 'claimed' }), async () => { throw new Error('complete unavailable'); }), 'complete unavailable'],
  ] as const)(`fails closed on %s without a false success [evidence:${evidence}]`, async (_label, transaction, message) => {
    await expect(executePublisherIdempotencyBoundary(
      unitOfWork(transaction),
      request,
      async () => response,
    )).rejects.toThrow(message);
  });

  it(`fails closed when the write or transaction commit outcome is unknown [evidence:${evidence}]`, async () => {
    const claimed = unitOfWork(transactionWith(async () => ({ state: 'claimed' })));
    await expect(executePublisherIdempotencyBoundary(claimed, request, async () => {
      throw new Error('write outcome unknown');
    })).rejects.toThrow('write outcome unknown');

    const unknownCommit: PublisherUnitOfWork = {
      execute: async () => { throw new Error('commit outcome unknown'); },
    };
    await expect(executePublisherIdempotencyBoundary(unknownCommit, request, async () => response))
      .rejects.toThrow('commit outcome unknown');
  });

  it(`rejects a UnitOfWork that skips, repeats, or replaces its callback result [evidence:${evidence}]`, async () => {
    const transaction = transactionWith(async () => ({ state: 'in-progress' }));
    const skipped: PublisherUnitOfWork = {
      execute: async () => ({ state: 'in-progress' } as never),
    };
    const repeated: PublisherUnitOfWork = {
      execute: async (work) => {
        const first = await work(transaction);
        await work(transaction);
        return first;
      },
    };
    const replaced: PublisherUnitOfWork = {
      execute: async (work) => {
        await work(transaction);
        return { state: 'in-progress' } as never;
      },
    };

    await expect(executePublisherIdempotencyBoundary(skipped, request, async () => response))
      .rejects.toThrow(/did not durably return/u);
    await expect(executePublisherIdempotencyBoundary(repeated, request, async () => response))
      .rejects.toThrow(/more than once/u);
    await expect(executePublisherIdempotencyBoundary(replaced, request, async () => response))
      .rejects.toThrow(/did not durably return/u);
  });

  it(`rejects a UnitOfWork callback invoked after execute has settled [evidence:${evidence}]`, async () => {
    let captured: ((transaction: PublisherTransaction) => Promise<unknown>) | undefined;
    const late: PublisherUnitOfWork = {
      execute: async (work) => {
        captured = work as (transaction: PublisherTransaction) => Promise<unknown>;
        return undefined as never;
      },
    };

    await expect(executePublisherIdempotencyBoundary(late, request, async () => response))
      .rejects.toThrow(/did not durably return/u);
    if (captured === undefined) throw new Error('Expected the UnitOfWork callback to be captured.');
    await expect(captured(transactionWith(async () => ({ state: 'in-progress' }))))
      .rejects.toThrow(/more than once or too late/u);
  });

  it(`rejects non-functions and Proxy write callbacks before opening the UnitOfWork [evidence:${evidence}]`, async () => {
    const execute = vi.fn(async () => ({ state: 'in-progress' } as never));
    const unit: PublisherUnitOfWork = { execute };
    const trap = vi.fn(() => { throw new Error('write trap must not execute'); });
    const proxyWrite = new Proxy(async () => response, { apply: trap });
    const binding = createPublisherIdempotencyBinding(request);

    await expect(executeIdempotentPublisherWrite(unit, binding, null as never)).rejects.toThrow(TypeError);
    await expect(executeIdempotentPublisherWrite(unit, binding, proxyWrite)).rejects.toThrow(TypeError);
    expect(trap).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it(`stores and returns one detached immutable response snapshot [evidence:${evidence}]`, async () => {
    const mutableResponse = {
      status: 201,
      headers: { Location: '/before' },
      body: { node: { id: 'node-before' } },
    };
    let completed: StoredPublisherResponse | undefined;
    const transaction = transactionWith(
      async () => ({ state: 'claimed' }),
      async (_binding, stored) => { completed = stored; },
    );

    const result = await executeIdempotentPublisherWrite(
      unitOfWork(transaction),
      createPublisherIdempotencyBinding(request),
      async () => mutableResponse,
    );
    mutableResponse.headers.Location = '/after';
    mutableResponse.body.node.id = 'node-after';

    expect(result).toEqual({
      state: 'committed',
      response: { status: 201, headers: { Location: '/before' }, body: { node: { id: 'node-before' } } },
    });
    if (result.state !== 'committed') throw new Error('Expected a committed response.');
    expect(completed).toBe(result.response);
    expect(Object.isFrozen(result.response)).toBe(true);
    expect(Object.isFrozen(result.response.headers)).toBe(true);
    expect(Object.isFrozen(result.response.body)).toBe(true);
  });

  it.each([
    ['header injection', { status: 201, headers: { Location: '/ok\r\nX-Evil: yes' }, body: {} }],
    ['case-insensitive duplicate headers', { status: 201, headers: { Location: '/one', location: '/two' }, body: {} }],
    ['invalid header name', { status: 201, headers: { 'Bad Header': 'value' }, body: {} }],
    ['non-string header value', { status: 201, headers: { Location: 42 }, body: {} }],
    ['array headers', { status: 201, headers: [], body: {} }],
    ['unknown response field', { status: 201, headers: {}, body: {}, secret: 'leak' }],
    ['non-I-JSON response body', { status: 201, headers: {}, body: { value: Number.POSITIVE_INFINITY } }],
  ] as const)(`rejects %s before idempotency completion [evidence:${evidence}]`, async (_label, candidate) => {
    const complete = vi.fn(async () => undefined);
    const transaction = transactionWith(async () => ({ state: 'claimed' }), complete);
    await expect(executeIdempotentPublisherWrite(
      unitOfWork(transaction),
      createPublisherIdempotencyBinding(request),
      async () => candidate as StoredPublisherResponse,
    )).rejects.toThrow(/response|headers|I-JSON/u);
    expect(complete).not.toHaveBeenCalled();
  });

  it.each([100, 599])(`accepts stored HTTP status boundary %d [evidence:${evidence}]`, async (status) => {
    const candidate = { status, headers: {}, body: {} };
    const transaction = transactionWith(async () => ({ state: 'claimed' }));
    await expect(executeIdempotentPublisherWrite(
      unitOfWork(transaction),
      createPublisherIdempotencyBinding(request),
      async () => candidate,
    )).resolves.toMatchObject({ state: 'committed', response: candidate });
  });

  it.each([99, 600])(`rejects stored HTTP status outside boundary %d [evidence:${evidence}]`, async (status) => {
    const complete = vi.fn(async () => undefined);
    const transaction = transactionWith(async () => ({ state: 'claimed' }), complete);
    await expect(executeIdempotentPublisherWrite(
      unitOfWork(transaction),
      createPublisherIdempotencyBinding(request),
      async () => ({ status, headers: {}, body: {} }),
    )).rejects.toThrow(/status/u);
    expect(complete).not.toHaveBeenCalled();
  });

  it(`rejects hostile claim shapes and non-native Promise ports [evidence:${evidence}]`, async () => {
    const binding = createPublisherIdempotencyBinding(request);
    const accessorClaim = Object.defineProperty({}, 'state', { enumerable: true, get: () => 'claimed' });
    const extraClaim = transactionWith(async () => ({ state: 'claimed', extra: true } as never));
    const syncClaim = transactionWith((() => ({ state: 'claimed' })) as never);

    await expect(executeIdempotentPublisherWrite(
      unitOfWork(transactionWith(async () => accessorClaim as never)), binding, async () => response,
    )).rejects.toThrow(/data properties/u);
    await expect(executeIdempotentPublisherWrite(unitOfWork(extraClaim), binding, async () => response))
      .rejects.toThrow(/unknown or missing/u);
    await expect(executeIdempotentPublisherWrite(unitOfWork(syncClaim), binding, async () => response))
      .rejects.toThrow(/native Promise/u);
    await expect(executeIdempotentPublisherWrite(
      { execute: (() => Promise.resolve({ state: 'in-progress' })) as never },
      binding,
      async () => response,
    )).rejects.toThrow(/did not durably return/u);
  });

  it(`rejects malformed adapter conflict data without exposing the binding [evidence:${evidence}]`, async () => {
    const binding = createPublisherIdempotencyBinding(request);
    const invalid = transactionWith(async () => ({ state: 'conflict', storedRequestDigest: request.idempotencyKey }));

    let thrown: unknown;
    try {
      await executeIdempotentPublisherWrite(unitOfWork(invalid), binding, async () => response);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect(String(thrown)).not.toContain(request.idempotencyKey);
    expect(String(thrown)).not.toContain(request.principalId);
    expect(String(thrown)).not.toContain(request.resourceIdentity);
  });
});

describe(`PUBLISH-0010 Manifest retention declaration [evidence:${evidence}]`, () => {
  it.each([
    ['exactly matches', 86_400],
    ['exceeds declaration', 86_401],
  ] as const)(`accepts a store guarantee that %s [evidence:${evidence}]`, async (_label, guaranteed) => {
    const manifest = await manifestFixture();
    const port = { getMinimumRetentionSeconds: vi.fn(async () => guaranteed) };

    await expect(verifyPublisherIdempotencyRetention(manifest, 'default', port)).resolves.toMatchObject({
      mountId: 'default',
      declaredRetentionSeconds: 86_400,
      guaranteedRetentionSeconds: guaranteed,
    });
    expect(port.getMinimumRetentionSeconds).toHaveBeenCalledWith('default');
  });

  it(`rejects a store guarantee one second below the declaration [evidence:${evidence}]`, async () => {
    await expect(verifyPublisherIdempotencyRetention(
      await manifestFixture(),
      'default',
      { getMinimumRetentionSeconds: async () => 86_399 },
    )).rejects.toThrow(/below the Manifest declaration/u);
  });

  it.each([undefined, null, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    `rejects invalid Manifest retention declaration %s [evidence:${evidence}]`,
    async (declared) => {
      const manifest = await manifestFixture();
      if (declared === undefined) delete manifest.mounts[0].limits.idempotencyRetentionSeconds;
      else manifest.mounts[0].limits.idempotencyRetentionSeconds = declared;

      await expect(verifyPublisherIdempotencyRetention(
        manifest,
        'default',
        { getMinimumRetentionSeconds: async () => 86_400 },
      )).rejects.toThrow(/valid Manifest|positive idempotency retention minimum/u);
    },
  );

  it(`rejects a valid Manifest whose requested mount lacks Publisher [evidence:${evidence}]`, async () => {
    const manifest = await manifestFixture();
    manifest.mounts[0].profiles = ['core', 'publication', 'sync', 'mcp-read'];
    delete manifest.mounts[0].limits.idempotencyRetentionSeconds;

    await expect(verifyPublisherIdempotencyRetention(
      manifest,
      'default',
      { getMinimumRetentionSeconds: async () => 86_400 },
    )).rejects.toThrow(/declare the Publisher Profile/u);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    `rejects invalid store guarantee %s [evidence:${evidence}]`,
    async (guaranteed) => {
      await expect(verifyPublisherIdempotencyRetention(
        await manifestFixture(),
        'default',
        { getMinimumRetentionSeconds: async () => guaranteed },
      )).rejects.toThrow(/below the Manifest declaration/u);
    },
  );

  it.each([
    ['missing', undefined],
    ['null', null],
    ['wrong method type', { getMinimumRetentionSeconds: 86_400 }],
  ] as const)(`rejects a %s retention port [evidence:${evidence}]`, async (_label, port) => {
    await expect(verifyPublisherIdempotencyRetention(
      await manifestFixture(),
      'default',
      port as never,
    )).rejects.toThrow(/retention port is required/u);
  });

  it(`propagates a throwing retention port and never returns verification [evidence:${evidence}]`, async () => {
    await expect(verifyPublisherIdempotencyRetention(
      await manifestFixture(),
      'default',
      { getMinimumRetentionSeconds: async () => { throw new Error('retention backend unavailable'); } },
    )).rejects.toThrow('retention backend unavailable');
  });
});

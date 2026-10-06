import { describe, expect, it } from 'vitest';

import { evaluatePublisherIdempotencyKeyRequirement } from '../../src/publisher/index.js';
import { getProblemDefinition } from '../../src/shared/problems.js';

const evidence = 'publisher.idempotency-key-required';
const binding = {
  principalId: 'principal-0009',
  protocolVersion: '0.1',
  endpointKey: 'nodes',
  resourceIdentity: 'collection-0009',
  requestDigest: `sha-256:${'A'.repeat(43)}`,
} as const;

describe(`PUBLISH-0009 retryable POST Idempotency-Key gate [evidence:${evidence}]`, () => {
  it.each([
    ['missing', undefined, 'missing'],
    ['blank', '', 'blank'],
    ['whitespace-only', '   ', 'blank'],
    ['multiple', ['publish-0009-a', 'publish-0009-b'], 'multiple'],
    ['comma-combined multiple', 'publish-0009-a,publish-0009-b', 'multiple'],
    ['control character', 'publish-0009\r\ninjected: value', 'invalid'],
    ['NUL control character', 'publish-0009\0value', 'invalid'],
    ['DEL control character', 'publish-0009\x7fvalue', 'invalid'],
    ['surrounding whitespace', ' publish-0009 ', 'invalid'],
    ['oversized', 'k'.repeat(256), 'invalid'],
  ] as const)(
    `rejects a retryable POST with a %s Idempotency-Key [evidence:${evidence}]`,
    (_label, idempotencyKey, reason) => {
      const result = evaluatePublisherIdempotencyKeyRequirement({
        method: 'POST',
        retryable: true,
        idempotencyKey,
        binding,
      });

      expect(result).toEqual({
        state: 'rejected',
        required: true,
        reason,
        status: 428,
        code: 'precondition_required',
        retryable: true,
      });
      if (result.state !== 'rejected') throw new Error('Expected a rejected key requirement.');
      expect({ status: result.status, retryable: result.retryable }).toEqual(
        getProblemDefinition('precondition_required'),
      );
      expect(JSON.stringify(result)).not.toContain('principal-0009');
      expect(JSON.stringify(result)).not.toContain('collection-0009');
      if (typeof idempotencyKey === 'string' && idempotencyKey.length > 0) {
        expect(JSON.stringify(result)).not.toContain(idempotencyKey);
      }
    },
  );

  it(`accepts one valid Idempotency-Key on a retryable POST [evidence:${evidence}]`, () => {
    expect(evaluatePublisherIdempotencyKeyRequirement({
      method: 'post',
      retryable: true,
      idempotencyKey: 'publish-0009:key_123',
      binding,
    })).toEqual({
      state: 'satisfied',
      required: true,
      key: 'publish-0009:key_123',
      binding: {
        ...binding,
        method: 'POST',
        key: 'publish-0009:key_123',
      },
    });
  });

  it(`snapshots the key gate envelope and binding without invoking getters or Proxy traps [evidence:${evidence}]`, () => {
    let methodReads = 0;
    const accessor = Object.defineProperty({
      method: 'POST',
      retryable: true,
      idempotencyKey: 'publish-0009-safe',
      binding,
    }, 'method', {
      configurable: true,
      enumerable: true,
      get: () => {
        methodReads += 1;
        return 'POST';
      },
    });
    expect(() => evaluatePublisherIdempotencyKeyRequirement(accessor as never)).toThrow(/data properties/u);
    expect(methodReads).toBe(0);

    expect(() => evaluatePublisherIdempotencyKeyRequirement(new Proxy({
      method: 'POST',
      retryable: true,
      idempotencyKey: 'publish-0009-safe',
      binding,
    }, {}))).toThrow(/plain object|evaluation input/u);

    const bindingAccessor = Object.defineProperty({ ...binding }, 'requestDigest', {
      configurable: true,
      enumerable: true,
      get: () => binding.requestDigest,
    });
    expect(() => evaluatePublisherIdempotencyKeyRequirement({
      method: 'POST',
      retryable: true,
      idempotencyKey: 'publish-0009-safe',
      binding: bindingAccessor as never,
    })).toThrow(/members must be enumerable data properties/u);
  });

  it(`accepts a visible-ASCII Idempotency-Key at the length boundary [evidence:${evidence}]`, () => {
    const key = 'k'.repeat(255);
    expect(evaluatePublisherIdempotencyKeyRequirement({
      method: 'POST',
      retryable: true,
      idempotencyKey: key,
      binding,
    })).toMatchObject({ state: 'satisfied', required: true, key });
  });

  it(`accepts a single raw field value and emits only the complete canonical binding [evidence:${evidence}]`, () => {
    const result = evaluatePublisherIdempotencyKeyRequirement({
      method: 'post',
      retryable: true,
      idempotencyKey: ['publish-0009-single'],
      binding: { ...binding, internalSecret: 'must-not-cross-boundary' } as typeof binding,
    });

    expect(result).toMatchObject({ state: 'satisfied', key: 'publish-0009-single' });
    if (result.state !== 'satisfied') throw new Error('Expected a satisfied key requirement.');
    expect(result.binding).toEqual({
      ...binding,
      method: 'POST',
      key: 'publish-0009-single',
    });
    expect(result.binding).not.toHaveProperty('internalSecret');
    expect(Object.isFrozen(result.binding)).toBe(true);
  });

  it.each([
    'principalId',
    'protocolVersion',
    'endpointKey',
    'resourceIdentity',
    'requestDigest',
  ] as const)(`fails closed when binding field %s is absent [evidence:${evidence}]`, (field) => {
    const incomplete = { ...binding } as Record<string, unknown>;
    delete incomplete[field];

    expect(() => evaluatePublisherIdempotencyKeyRequirement({
      method: 'POST',
      retryable: true,
      idempotencyKey: 'publish-0009-binding',
      binding: incomplete as typeof binding,
    })).toThrow(TypeError);
  });

  it.each([
    ['non-retryable POST', { method: 'POST', retryable: false }],
    ['retryable PUT', { method: 'PUT', retryable: true }],
    ['retryable GET', { method: 'GET', retryable: true }],
  ] as const)(
    `does not require Idempotency-Key for a %s [evidence:${evidence}]`,
    (_label, input) => {
      expect(evaluatePublisherIdempotencyKeyRequirement({ ...input, binding })).toEqual({
        state: 'not-required',
        required: false,
        reason: input.method === 'POST' ? 'not-retryable' : 'not-post',
      });
    },
  );

  it(`does not inspect a malformed supplied key for a non-retryable POST [evidence:${evidence}]`, () => {
    expect(evaluatePublisherIdempotencyKeyRequirement({
      method: 'POST',
      retryable: false,
      idempotencyKey: ['duplicate-a', 'duplicate-b'],
      binding,
    })).toEqual({ state: 'not-required', required: false, reason: 'not-retryable' });
  });

  it(`does not reject a non-POST request merely because a supplied key is malformed [evidence:${evidence}]`, () => {
    expect(evaluatePublisherIdempotencyKeyRequirement({
      method: 'PATCH',
      retryable: true,
      idempotencyKey: ['duplicate-a', 'duplicate-b'],
      binding,
    })).toEqual({
      state: 'not-required',
      required: false,
      reason: 'not-post',
    });
  });
});

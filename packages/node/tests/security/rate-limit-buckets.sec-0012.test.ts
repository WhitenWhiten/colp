import { describe, expect, it, vi } from 'vitest';

import { classifyRateLimitBucket } from '../../src/security/index.js';

const evidence = '[evidence:security.rate-limit-buckets]';

const categories = {
  anonymousFeedRead: 'anonymous-feed-read',
  authenticatedRead: 'authenticated-read',
  syncPull: 'sync-pull',
  syncPush: 'sync-push',
  generalWrite: 'general-write',
  mcpToolCall: 'mcp-tool-call',
  adminKeyManagement: 'admin-key-management',
} as const;

type Category = (typeof categories)[keyof typeof categories];
type Authentication = 'anonymous' | 'authenticated';

function classify(operation: string, authentication: Authentication = 'authenticated') {
  return classifyRateLimitBucket({ operation, authentication });
}

function classified(category: Category, operationSubtype: string) {
  return {
    classified: true,
    bucketId: `publisher:${category}`,
    category,
    operationSubtype,
  } as const;
}

function rejected() {
  return { classified: false, reason: 'invalid_input' } as const;
}

describe(`${evidence} SEC-0012 publisher operation buckets`, () => {
  it(`${evidence} maps every authoritative operation to the seven fixed buckets`, () => {
    const cases = [
      ['feed-read', 'anonymous', categories.anonymousFeedRead],
      ['feed-read', 'authenticated', categories.authenticatedRead],
      ['read', 'authenticated', categories.authenticatedRead],
      ['sync-pull', 'authenticated', categories.syncPull],
      ['sync-push', 'authenticated', categories.syncPush],
      ['write', 'authenticated', categories.generalWrite],
      ['mcp-tool', 'authenticated', categories.mcpToolCall],
      ['admin', 'authenticated', categories.adminKeyManagement],
      ['key-management', 'authenticated', categories.adminKeyManagement],
    ] as const;

    for (const [operation, authentication, bucket] of cases) {
      expect(classify(operation, authentication), `${authentication}:${operation}`).toEqual(
        classified(bucket, operation),
      );
    }
  });

  it(`${evidence} exposes exactly seven distinct canonical bucket identifiers`, () => {
    const decisions = [
      classify('feed-read', 'anonymous'),
      classify('read'),
      classify('sync-pull'),
      classify('sync-push'),
      classify('write'),
      classify('mcp-tool'),
      classify('key-management'),
    ];

    expect(new Set(decisions.map((decision) => decision.classified && decision.bucketId))).toEqual(
      new Set(Object.values(categories).map((category) => `publisher:${category}`)),
    );
  });

  it(`${evidence} separates anonymous feed reads from authenticated feed and general reads`, () => {
    expect(classify('feed-read', 'anonymous')).toEqual(
      classified(categories.anonymousFeedRead, 'feed-read'),
    );
    expect(classify('feed-read')).toEqual(classified(categories.authenticatedRead, 'feed-read'));
    expect(classify('read')).toEqual(classified(categories.authenticatedRead, 'read'));
    expect(categories.anonymousFeedRead).not.toBe(categories.authenticatedRead);
  });

  it(`${evidence} keeps sync pull and sync push in separate buckets`, () => {
    expect(classify('sync-pull')).toEqual(classified(categories.syncPull, 'sync-pull'));
    expect(classify('sync-push')).toEqual(classified(categories.syncPush, 'sync-push'));
    expect(categories.syncPull).not.toBe(categories.syncPush);
  });

  it(`${evidence} never mixes general write, MCP tool call, or administration buckets`, () => {
    const decisions = [classify('write'), classify('mcp-tool'), classify('admin')];
    expect(decisions).toEqual([
      classified(categories.generalWrite, 'write'),
      classified(categories.mcpToolCall, 'mcp-tool'),
      classified(categories.adminKeyManagement, 'admin'),
    ]);
    expect(new Set(decisions.map((decision) => decision.classified && decision.bucketId)).size).toBe(3);
  });

  it(`${evidence} treats key management as administration and never as general write`, () => {
    const keyManagement = classify('key-management');
    const admin = classify('admin');
    expect(keyManagement).toEqual(classified(categories.adminKeyManagement, 'key-management'));
    expect(admin).toEqual(classified(categories.adminKeyManagement, 'admin'));
    expect(keyManagement.classified && keyManagement.bucketId).toBe(
      admin.classified && admin.bucketId,
    );
    expect(keyManagement.classified && keyManagement.operationSubtype).not.toBe(
      admin.classified && admin.operationSubtype,
    );
    expect(categories.adminKeyManagement).not.toBe(categories.generalWrite);
  });

  it(`${evidence} fails closed when anonymous callers claim authenticated or sensitive operations`, () => {
    for (const operation of [
      'read',
      'sync-pull',
      'sync-push',
      'write',
      'mcp-tool',
      'admin',
      'key-management',
    ]) {
      expect(classify(operation, 'anonymous'), operation).toEqual(rejected());
    }
  });

  it(`${evidence} rejects unknown, empty, case-variant, Unicode, and control-bearing classifications`, () => {
    for (const input of [undefined, null, {}, []]) {
      expect(classifyRateLimitBucket(input)).toEqual(rejected());
    }
    for (const operation of [
      '',
      'unknown',
      'READ',
      'Sync-Pull',
      're\u0430d',
      '\uff52ead',
      'read\u0000',
      'read\n',
      ' read',
    ]) {
      expect(classify(operation), JSON.stringify(operation)).toEqual(rejected());
    }
    for (const authentication of ['', 'Authenticated', 'auth\u00e9nticated', 'authenticated\u0000']) {
      expect(
        classifyRateLimitBucket({ operation: 'read', authentication }),
        JSON.stringify(authentication),
      ).toEqual(rejected());
    }
  });

  it(`${evidence} rejects forged bucket and bucket id hints`, () => {
    for (const input of [
      {
        operation: 'read',
        authentication: 'authenticated',
        bucket: categories.adminKeyManagement,
      },
      {
        operation: 'read',
        authentication: 'authenticated',
        bucketId: `publisher:${categories.generalWrite}`,
      },
      {
        operation: 'read',
        authentication: 'authenticated',
        id: `publisher:${categories.mcpToolCall}`,
      },
    ]) {
      expect(classifyRateLimitBucket(input)).toEqual(rejected());
    }
  });

  it(`${evidence} ignores or rejects forged authentication and classification hints`, () => {
    for (const input of [
      {
        operation: 'write',
        authentication: 'anonymous',
        authenticated: true,
        classification: 'authenticated',
      },
      {
        operation: 'key-management',
        authentication: 'anonymous',
        principalType: 'service',
        credentialEstablished: true,
      },
      {
        operation: 'mcp-tool',
        authentication: 'anonymous',
        operationClass: 'authenticated_read',
      },
    ]) {
      expect(classifyRateLimitBucket(input)).toEqual(rejected());
    }
  });

  it(`${evidence} rejects accessor-backed input without executing getters`, () => {
    const operation = vi.fn(() => 'read');
    const authentication = vi.fn(() => 'authenticated');
    const input = {};
    Object.defineProperties(input, {
      operation: { enumerable: true, get: operation },
      authentication: { enumerable: true, get: authentication },
    });

    expect(classifyRateLimitBucket(input)).toEqual(rejected());
    expect(operation).not.toHaveBeenCalled();
    expect(authentication).not.toHaveBeenCalled();
  });

  it(`${evidence} rejects Proxy input without executing traps`, () => {
    const get = vi.fn(() => 'read');
    const getOwnPropertyDescriptor = vi.fn(() => ({
      configurable: true,
      enumerable: true,
      value: 'read',
      writable: true,
    }));
    const ownKeys = vi.fn(() => ['operation', 'authentication']);
    const input = new Proxy({}, { get, getOwnPropertyDescriptor, ownKeys });

    expect(classifyRateLimitBucket(input)).toEqual(rejected());
    expect(get).not.toHaveBeenCalled();
    expect(getOwnPropertyDescriptor).not.toHaveBeenCalled();
    expect(ownKeys).not.toHaveBeenCalled();

    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(classifyRateLimitBucket(proxy)).toEqual(rejected());
  });

  it(`${evidence} rejects custom prototypes and inherited classification without executing them`, () => {
    const inheritedOperation = vi.fn(() => 'admin');
    const prototype = {};
    Object.defineProperty(prototype, 'operation', { get: inheritedOperation });
    Object.defineProperty(prototype, 'authentication', { value: 'authenticated' });

    const inherited = Object.create(prototype) as object;
    const customPrototype = Object.create(prototype) as object;
    Object.defineProperties(customPrototype, {
      operation: { configurable: true, enumerable: true, value: 'read', writable: true },
      authentication: {
        configurable: true,
        enumerable: true,
        value: 'authenticated',
        writable: true,
      },
    });

    expect(classifyRateLimitBucket(inherited)).toEqual(rejected());
    expect(classifyRateLimitBucket(customPrototype)).toEqual(rejected());
    expect(inheritedOperation).not.toHaveBeenCalled();
  });

  it(`${evidence} accepts exact own data properties on null-prototype and non-enumerable inputs`, () => {
    const nullPrototype = Object.create(null) as object;
    Object.defineProperties(nullPrototype, {
      operation: { configurable: true, enumerable: true, value: 'read', writable: true },
      authentication: {
        configurable: true,
        enumerable: true,
        value: 'authenticated',
        writable: true,
      },
    });
    const nonEnumerable = {};
    Object.defineProperties(nonEnumerable, {
      operation: { configurable: true, enumerable: false, value: 'feed-read', writable: true },
      authentication: {
        configurable: true,
        enumerable: false,
        value: 'anonymous',
        writable: true,
      },
    });

    expect(classifyRateLimitBucket(nullPrototype)).toEqual(
      classified(categories.authenticatedRead, 'read'),
    );
    expect(classifyRateLimitBucket(nonEnumerable)).toEqual(
      classified(categories.anonymousFeedRead, 'feed-read'),
    );
  });

  it(`${evidence} rejects symbols, extra authority hints, and conceptual duplicate fields`, () => {
    const symbolHint = {
      operation: 'read',
      authentication: 'authenticated',
      [Symbol('bucket')]: categories.adminKeyManagement,
    };
    const extraHints = [
      { operation: 'read', authentication: 'authenticated', auth: 'anonymous' },
      { operation: 'read', authentication: 'authenticated', principal: 'public' },
      { operation: 'read', authentication: 'authenticated', operationClass: 'admin' },
      { operation: 'read', authentication: 'authenticated', Operation: 'admin' },
      { operation: 'read', authentication: 'authenticated', AUTHENTICATION: 'anonymous' },
    ];

    expect(classifyRateLimitBucket(symbolHint)).toEqual(rejected());
    for (const input of extraHints) {
      expect(classifyRateLimitBucket(input)).toEqual(rejected());
    }
  });

  it(`${evidence} ignores Object.prototype pollution while requiring own classification fields`, () => {
    Object.defineProperties(Object.prototype, {
      operation: { configurable: true, get: () => 'admin' },
      authentication: { configurable: true, value: 'authenticated' },
      bucketId: { configurable: true, value: 'publisher:admin-key-management' },
    });

    try {
      expect(classifyRateLimitBucket({})).toEqual(rejected());

      const input = Object.create(null) as object;
      Object.defineProperties(input, {
        operation: { enumerable: true, value: 'read' },
        authentication: { enumerable: true, value: 'authenticated' },
      });
      expect(classifyRateLimitBucket(input)).toEqual(
        classified(categories.authenticatedRead, 'read'),
      );
    } finally {
      delete (Object.prototype as { operation?: unknown }).operation;
      delete (Object.prototype as { authentication?: unknown }).authentication;
      delete (Object.prototype as { bucketId?: unknown }).bucketId;
    }
  });

  it(`${evidence} rejects dynamic classification values without coercion or callback execution`, () => {
    const toString = vi.fn(() => 'read');
    const toPrimitive = vi.fn(() => 'read');
    const dynamicOperation = { toString, [Symbol.toPrimitive]: toPrimitive };

    expect(
      classifyRateLimitBucket({
        operation: dynamicOperation,
        authentication: 'authenticated',
      }),
    ).toEqual(rejected());
    expect(toString).not.toHaveBeenCalled();
    expect(toPrimitive).not.toHaveBeenCalled();
  });

  it(`${evidence} snapshots immutable decisions without principal or credential material`, () => {
    const input = {
      operation: 'read',
      authentication: 'authenticated',
    };
    const decision = classifyRateLimitBucket(input);
    const taintedDecision = classifyRateLimitBucket({
      ...input,
      principal: { type: 'user', id: 'private-principal-id' },
      credentialId: 'private-credential-id',
      credential: 'private-credential-secret',
    });

    input.operation = 'key-management';
    input.authentication = 'anonymous';

    expect(decision).toEqual(classified(categories.authenticatedRead, 'read'));
    expect(classifyRateLimitBucket(input)).toEqual(rejected());
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.keys(decision).sort()).toEqual([
      'bucketId',
      'category',
      'classified',
      'operationSubtype',
    ]);
    expect(JSON.stringify(decision)).not.toMatch(/principal|credential|private|mutated/u);
    expect(taintedDecision).toEqual(rejected());
    expect(Object.isFrozen(taintedDecision)).toBe(true);
    expect(JSON.stringify(taintedDecision)).not.toMatch(/principal|credential|private/u);
  });
});

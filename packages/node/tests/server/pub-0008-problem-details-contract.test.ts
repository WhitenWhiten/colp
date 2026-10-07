import { describe, expect, it } from 'vitest';

import {
  createPublicationProblemDescriptor,
  createPublicationProblemResponse,
  problemRegistry,
} from '../../src/server/index.js';

const evidence = '[evidence:http.problems]';
const secret = 'Bearer publication-super-secret';

function expectNoSensitiveText(value: unknown): void {
  expect(String(value)).not.toContain(secret);
  expect(String(value)).not.toContain('X-Amz-Signature=full-private-signature');
  expect(String(value)).not.toContain('private note body');
  expect(String(value)).not.toContain('principal:internal-admin');
}

describe(`PUB-0008 server Problem Details contract ${evidence}`, () => {
  it.each(Object.entries(problemRegistry))(
    `constructs a readable RFC 9457 Response for registered %s ${evidence}`,
    async (code, definition) => {
      const response = createPublicationProblemResponse({ code: code as keyof typeof problemRegistry });

      expect(response).toBeInstanceOf(Response);
      expect(response.status).toBe(definition.status);
      expect(response.headers.get('content-type')).toBe('application/problem+json');

      const body = await response.json() as Record<string, unknown>;
      expect(body).toEqual(expect.objectContaining({
        type: `https://know-n.com/colp/problems/${code.replaceAll('_', '-')}`,
        title: expect.any(String),
        status: definition.status,
        code,
        retryable: definition.retryable,
      }));
      expect(Object.keys(body)).toEqual(expect.arrayContaining(['type', 'title', 'status', 'code']));
      expect(JSON.stringify(body)).not.toContain('\r');
      expect(JSON.stringify(body)).not.toContain('\n');
    },
  );

  it.each([
    ['https://vendor.example/problems/quota', 429],
    ['HTTPS://vendor.example/problems/custom-conflict', 409],
  ] as const)(
    `constructs a readable Response for HTTPS extension code %s ${evidence}`,
    async (code, status) => {
      const response = createPublicationProblemResponse({ code, status });
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(status);
      expect(response.headers.get('content-type')).toBe('application/problem+json');
      expect(body).toMatchObject({ code, status });
      expect(typeof body.type).toBe('string');
      expect(typeof body.title).toBe('string');
    },
  );

  it(`copies and deeply freezes recovery data without sharing mutable state ${evidence}`, async () => {
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
    const descriptor = createPublicationProblemDescriptor({
      code: 'precondition_failed',
      recovery,
    });
    recovery.supportedVersions.push('mutated');
    recovery.links.current = 'https://attacker.example/';
    recovery.errors[0]!.message = 'mutated';

    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor.headers)).toBe(true);
    expect(Object.isFrozen(descriptor.problem)).toBe(true);
    expect(Object.isFrozen(descriptor.problem.supportedVersions)).toBe(true);
    expect(Object.isFrozen(descriptor.problem.links)).toBe(true);
    expect(Object.isFrozen(descriptor.problem.errors)).toBe(true);
    expect(Object.isFrozen(descriptor.problem.errors?.[0])).toBe(true);
    expect(descriptor.problem).toMatchObject({
      status: 412,
      code: 'precondition_failed',
      currentRevision: 'r_18',
      currentEtag: 'collection-r_18',
      expectedSequence: 19,
      supportedVersions: ['0.1'],
      retryAfterSeconds: 7,
      snapshotUrl: 'https://cdn.example/snapshots/current.json',
      conflictId: 'conflict_19',
      errors: [{ path: '/nodes/0/title', keyword: 'minLength', message: 'must not be empty' }],
      links: { current: 'https://api.example/collections/one' },
    });

    const first = createPublicationProblemResponse({ code: 'precondition_failed', recovery });
    const second = createPublicationProblemResponse({ code: 'precondition_failed', recovery });
    expect(first).not.toBe(second);
    expect(await first.json()).toEqual(await second.json());
  });

  it.each([
    ['unregistered short code', { code: 'not_registered' }],
    ['non-HTTPS extension', { code: 'http://vendor.example/problems/custom', status: 409 }],
    ['extension with user information', { code: 'https://private@vendor.example/problems/custom', status: 409 }],
    ['uppercase pseudo-short code', { code: 'RESOURCE_NOT_FOUND' }],
    ['control character in code', { code: 'https://vendor.example/problems/custom\u0000', status: 409 }],
    ['CRLF in code', { code: 'https://vendor.example/problems/custom\r\nX-Injected: yes', status: 409 }],
    ['core status override', { code: 'resource_not_found', status: 500 }],
    ['free-form title carrying a secret', { code: 'internal_error', title: secret }],
    ['free-form detail carrying a signed URL', {
      code: 'internal_error',
      detail: `https://private.example/file?X-Amz-Signature=full-private-signature&token=${secret}`,
    }],
    ['unknown private Note field', { code: 'internal_error', privateNote: 'private note body' }],
    [secret, { code: 'internal_error', [secret]: true }],
    ['unknown internal Principal recovery field', {
      code: 'internal_error',
      recovery: { internalPrincipal: 'principal:internal-admin' },
    }],
  ])(`rejects %s without echoing unauthorized text ${evidence}`, (name, input) => {
    let rejection: unknown;
    try {
      createPublicationProblemDescriptor(input as never);
    } catch (error) {
      rejection = error;
    }

    expect(rejection, `${name} must be rejected`).toBeInstanceOf(Error);
    expectNoSensitiveText((rejection as Error).message);
  });

  it.each([
    ['extension status below error range', { code: 'https://vendor.example/problems/custom', status: 399 }],
    ['extension status above error range', { code: 'https://vendor.example/problems/custom', status: 600 }],
    ['non-integer extension status', { code: 'https://vendor.example/problems/custom', status: 409.5 }],
    ['too many supported versions', {
      code: 'invalid_document',
      recovery: { supportedVersions: Array.from({ length: 65 }, (_, index) => `v${index}`) },
    }],
    ['invalid recovery field type', { code: 'invalid_document', recovery: { expectedSequence: 0 } }],
  ])(`rejects bounded invalid input %s ${evidence}`, (_name, input) => {
    expect(() => createPublicationProblemDescriptor(input as never)).toThrow();
  });

  it(`rejects an otherwise valid recovery payload above the Problem body limit ${evidence}`, () => {
    expect(() => createPublicationProblemDescriptor({
      code: 'unsupported_version',
      recovery: { supportedVersions: Array.from({ length: 64 }, () => 'x'.repeat(1_100)) },
    })).toThrow(/must not exceed 65536 bytes/u);
  });
});

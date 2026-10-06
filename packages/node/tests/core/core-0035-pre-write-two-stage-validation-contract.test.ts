import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { executeValidatedWrite } from '../../src/server/index.js';
import { executeValidatedWrite as executeServerValidatedWrite } from '../../src/server/index.js';
import {
  createValidatorRegistry,
  validateWireDocument,
  type DefinitionName,
  type ValidatorRegistry,
} from '../../src/schema/index.js';

const evidence = '[evidence:core.pre-write-two-stage-validation]';
const fixturesRoot = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');

function fixture(name: string): Record<string, any> {
  return JSON.parse(readFileSync(resolve(fixturesRoot, name), 'utf8')) as Record<string, any>;
}

function hostileParsedValues(): readonly (readonly [string, unknown])[] {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const symbolMember = { value: true } as Record<PropertyKey, unknown>;
  symbolMember[Symbol('hidden')] = true;
  const sparse = Array(2);
  const extraArray = [true] as unknown[] & { extra?: boolean };
  extraArray.extra = true;
  const accessor = {} as Record<string, unknown>;
  Object.defineProperty(accessor, 'secret', { enumerable: true, get: () => 'read' });
  const nonEnumerable = {} as Record<string, unknown>;
  Object.defineProperty(nonEnumerable, 'hidden', { value: true, enumerable: false });
  return [
    ['non-finite number', Number.NaN],
    ['non-JSON bigint', 1n],
    ['cycle', cyclic],
    ['non-plain object', new Date(0)],
    ['symbol member', symbolMember],
    ['sparse array', sparse],
    ['array extra member', extraArray],
    ['accessor member', accessor],
    ['non-enumerable member', nonEnumerable],
  ];
}

const validObjectFamilies = [
  ['annotation create', 'annotationCreate', 'publisher-annotation-create.json'],
  ['collection create request', 'collectionCreateRequest', 'publisher-collection-create.json'],
  ['node move request', 'nodeMoveRequest', 'publisher-node-move.json'],
  ['change plan request', 'changePlanRequest', 'change-plan-request.json'],
] as const satisfies readonly (readonly [string, DefinitionName, string])[];

describe(`CORE-0035 pre-write two-stage validation contract ${evidence}`, () => {
  it('publishes one production gate from the server surface', () => {
    expect(executeServerValidatedWrite).toBe(executeValidatedWrite);
  });

  it.each(validObjectFamilies)(
    'structurally and semantically validates a %s exactly once before its write',
    async (_label, definition, fixtureName) => {
      const events: string[] = [];
      const delegate = createValidatorRegistry();
      const validators: ValidatorRegistry = {
        definitionNames: delegate.definitionNames,
        get: (name) => delegate.get(name),
        validate(name, value) {
          events.push('structural');
          return delegate.validate(name, value);
        },
      };
      const input = fixture(fixtureName);
      let semanticValue: Readonly<Record<string, any>> | undefined;
      const semantics = vi.fn((value: Readonly<Record<string, any>>) => {
        events.push('semantic');
        semanticValue = value;
        return { valid: true as const, issues: [] as const };
      });
      const writer = vi.fn(async (value: Readonly<Record<string, any>>) => {
        events.push('write');
        expect(value).toBe(semanticValue);
        return { persisted: definition };
      });

      const result = await executeValidatedWrite(
        validators,
        definition,
        input,
        semantics,
        writer,
      );

      expect(result).toEqual({
        valid: true,
        value: input,
        result: { persisted: definition },
      });
      expect(events).toEqual(['structural', 'semantic', 'write']);
      expect(semantics).toHaveBeenCalledOnce();
      expect(writer).toHaveBeenCalledOnce();
    },
  );

  it.each(validObjectFamilies)(
    'rejects a structurally invalid %s without semantics or persistence',
    async (_label, definition) => {
      const semantics = vi.fn(() => ({ valid: true as const, issues: [] as const }));
      const writer = vi.fn(async () => 'unreachable');

      const result = await executeValidatedWrite(
        createValidatorRegistry(),
        definition,
        {},
        semantics,
        writer,
      );

      expect(result).toMatchObject({ valid: false, stage: 'structural' });
      if (result.valid || result.stage !== 'structural') return;
      expect(result.errors.length).toBeGreaterThan(0);
      expect(semantics).not.toHaveBeenCalled();
      expect(writer).not.toHaveBeenCalled();
    },
  );

  it('asserts canonical RFC 3339 format before semantics and persistence', async () => {
    const annotation = fixture('publisher-annotation-create.json');
    annotation.provenance.generatedAt = '2026-02-30T12:00:00Z';
    const semantics = vi.fn(() => ({ valid: true as const, issues: [] as const }));
    const writer = vi.fn(async () => 'unreachable');

    const result = await executeValidatedWrite(
      createValidatorRegistry(),
      'annotationCreate',
      annotation,
      semantics,
      writer,
    );

    expect(result).toMatchObject({ valid: false, stage: 'structural' });
    if (result.valid || result.stage !== 'structural') return;
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ keyword: 'format', instancePath: '/provenance/generatedAt' }),
    ]));
    expect(semantics).not.toHaveBeenCalled();
    expect(writer).not.toHaveBeenCalled();
  });

  it('returns semantic issues for a structurally valid object and never writes it', async () => {
    const issue = { code: 'injected-semantic-failure', message: 'Rejected by injected policy', path: '/root' };
    const semantics = vi.fn(() => ({ valid: false as const, issues: [issue] as const }));
    const writer = vi.fn(async () => 'unreachable');

    const result = await executeValidatedWrite(
      createValidatorRegistry(),
      'collectionCreateRequest',
      fixture('publisher-collection-create.json'),
      semantics,
      writer,
    );

    expect(result).toEqual({ valid: false, stage: 'semantic', issues: [issue] });
    expect(semantics).toHaveBeenCalledOnce();
    expect(writer).not.toHaveBeenCalled();
  });

  it('uses canonical validation before consulting a supplied registry that lies about invalid input', async () => {
    const delegate = createValidatorRegistry();
    const validate = vi.fn(() => ({ valid: true as const, errors: [] as const }));
    const hostile: ValidatorRegistry = {
      definitionNames: delegate.definitionNames,
      get: (name) => delegate.get(name),
      validate,
    };
    const semantics = vi.fn(() => ({ valid: true as const, issues: [] as const }));
    const writer = vi.fn(async () => 'unreachable');

    const result = await executeValidatedWrite(
      hostile,
      'dateTime',
      '2026-02-30T12:00:00Z',
      semantics,
      writer,
    );

    expect(result).toMatchObject({ valid: false, stage: 'structural' });
    expect(validate).not.toHaveBeenCalled();
    expect(semantics).not.toHaveBeenCalled();
    expect(writer).not.toHaveBeenCalled();
  });

  it('revalidates after an untrusted supplied registry and cannot be weakened by a lying result', async () => {
    const delegate = createValidatorRegistry();
    const hostile: ValidatorRegistry = {
      definitionNames: delegate.definitionNames,
      get: (name) => delegate.get(name),
      validate: vi.fn(() => ({ valid: true as const, errors: [] as const })),
    };
    const semantics = vi.fn(() => ({ valid: true as const, issues: [] as const }));
    const writer = vi.fn(async () => 'stored');

    const result = await executeValidatedWrite(
      hostile,
      'dateTime',
      '2026-07-17T04:00:00Z',
      semantics,
      writer,
    );

    expect(result).toEqual({ valid: true, value: '2026-07-17T04:00:00Z', result: 'stored' });
    expect(hostile.validate).toHaveBeenCalledOnce();
    expect(semantics).toHaveBeenCalledOnce();
    expect(writer).toHaveBeenCalledOnce();
  });

  it.each([
    ['null', null],
    ['array', []],
    ['missing errors', { valid: true }],
    ['extra member', { valid: true, errors: [], extra: true }],
    ['true with errors', { valid: true, errors: [{ keyword: 'injected' }] }],
    ['false without errors', { valid: false, errors: [] }],
  ] as const)('rejects a malformed structural validator result: %s', async (_label, structuralResult) => {
    const delegate = createValidatorRegistry();
    const hostile: ValidatorRegistry = {
      definitionNames: delegate.definitionNames,
      get: (name) => delegate.get(name),
      validate: () => structuralResult as never,
    };
    const semantics = vi.fn(() => ({ valid: true as const, issues: [] as const }));
    const writer = vi.fn(async () => 'unreachable');

    await expect(executeValidatedWrite(
      hostile,
      'dateTime',
      '2026-07-17T04:00:00Z',
      semantics,
      writer,
    )).rejects.toBeInstanceOf(TypeError);
    expect(semantics).not.toHaveBeenCalled();
    expect(writer).not.toHaveBeenCalled();
  });

  it('passes one detached deeply frozen validated value to semantics and the writer', async () => {
    const input = fixture('publisher-annotation-create.json');
    const originalValue = input.value;
    let semanticValue: Readonly<Record<string, any>> | undefined;
    const semantics = vi.fn((value: Readonly<Record<string, any>>) => {
      semanticValue = value;
      expect(Object.isFrozen(value)).toBe(true);
      expect(Object.isFrozen(value.provenance)).toBe(true);
      return { valid: true as const, issues: [] as const };
    });
    const writer = vi.fn(async (value: Readonly<Record<string, any>>) => {
      expect(value).toBe(semanticValue);
      expect(value).not.toBe(input);
      expect(value.provenance).not.toBe(input.provenance);
      expect(value.value).toBe(originalValue);
      return 'stored';
    });

    const pending = executeValidatedWrite(
      createValidatorRegistry(),
      'annotationCreate',
      input,
      semantics,
      writer,
    );
    input.value = 'mutated after invocation';
    input.provenance.generatedAt = 'not-a-date';

    const result = await pending;
    expect(result).toMatchObject({ valid: true, value: { value: originalValue }, result: 'stored' });
    expect(input.value).toBe('mutated after invocation');
  });

  it('rejects mutation attempted by semantics and never reaches the writer', async () => {
    const writer = vi.fn(async () => 'unreachable');
    const semantics = vi.fn((value: Readonly<Record<string, any>>) => {
      (value.provenance as Record<string, unknown>).generatedAt = '2026-01-01T00:00:00Z';
      return { valid: true as const, issues: [] as const };
    });

    await expect(executeValidatedWrite(
      createValidatorRegistry(),
      'annotationCreate',
      fixture('publisher-annotation-create.json'),
      semantics,
      writer,
    )).rejects.toBeInstanceOf(TypeError);
    expect(writer).not.toHaveBeenCalled();
  });

  it.each([
    ['unsafe integer', { value: Number.MAX_SAFE_INTEGER + 1 }],
    ['constructor', { constructor: { prototype: { polluted: true } } }],
    ['prototype', { prototype: { polluted: true } }],
  ] as const)('rejects nested parsed %s before semantics or persistence', async (_label, nested) => {
    const semantics = vi.fn(() => ({ valid: true as const, issues: [] as const }));
    const writer = vi.fn(async () => 'unreachable');
    const candidate = { 'https://example.com/extensions/strict-json': nested };

    await expect(executeValidatedWrite(
      createValidatorRegistry(),
      'extensions',
      candidate,
      semantics,
      writer,
    )).rejects.toBeInstanceOf(TypeError);
    expect(semantics).not.toHaveBeenCalled();
    expect(writer).not.toHaveBeenCalled();
  });

  it('rejects a nested own __proto__ member before cloning or persistence', async () => {
    const nested = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(nested, '__proto__', {
      value: { polluted: true },
      enumerable: true,
    });
    const writer = vi.fn(async () => 'unreachable');

    await expect(executeValidatedWrite(
      createValidatorRegistry(),
      'extensions',
      { 'https://example.com/extensions/strict-json': nested },
      () => ({ valid: true as const, issues: [] as const }),
      writer,
    )).rejects.toThrow('prototype-polluting');
    expect(writer).not.toHaveBeenCalled();
  });

  it.each(hostileParsedValues())(
    'rejects a nested %s as non-I-JSON data before persistence',
    async (_label, invalid) => {
      const writer = vi.fn(async () => 'unreachable');
      await expect(executeValidatedWrite(
        createValidatorRegistry(),
        'extensions',
        { 'https://example.com/extensions/strict-json': invalid },
        () => ({ valid: true as const, issues: [] as const }),
        writer,
      )).rejects.toBeInstanceOf(TypeError);
      expect(writer).not.toHaveBeenCalled();
    },
  );

  it('returns the writer result without reinterpretation in a frozen success envelope', async () => {
    const persisted = { revision: 'r-2', accepted: true };

    const result = await executeValidatedWrite(
      createValidatorRegistry(),
      'nodeMoveRequest',
      fixture('publisher-node-move.json'),
      () => ({ valid: true as const, issues: [] as const }),
      async () => persisted,
    );

    expect(result).toMatchObject({ valid: true, result: persisted });
    if (!result.valid) return;
    expect(result.result).toBe(persisted);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('propagates writer rejection after exactly one persistence attempt', async () => {
    const failure = new Error('storage unavailable');
    const writer = vi.fn(async () => Promise.reject(failure));

    await expect(executeValidatedWrite(
      createValidatorRegistry(),
      'changePlanRequest',
      fixture('change-plan-request.json'),
      () => ({ valid: true as const, issues: [] as const }),
      writer,
    )).rejects.toBe(failure);
    expect(writer).toHaveBeenCalledOnce();
  });

  it('rejects a synchronous non-Promise writer result under the asynchronous persistence contract', async () => {
    const writer = vi.fn(() => ({ stored: true }));

    await expect(executeValidatedWrite(
      createValidatorRegistry(),
      'dateTime',
      '2026-07-17T04:00:00Z',
      () => ({ valid: true as const, issues: [] as const }),
      writer as never,
    )).rejects.toThrow('Persistence writer must return a Promise');
    expect(writer).toHaveBeenCalledOnce();
  });

  it('rejects an arbitrary thenable without assimilating or executing it', async () => {
    const then = vi.fn();
    const writer = vi.fn(() => ({ then }));

    await expect(executeValidatedWrite(
      createValidatorRegistry(),
      'dateTime',
      '2026-07-17T04:00:00Z',
      () => ({ valid: true as const, issues: [] as const }),
      writer as never,
    )).rejects.toThrow('Persistence writer must return a Promise');
    expect(writer).toHaveBeenCalledOnce();
    expect(then).not.toHaveBeenCalled();
  });

  it.each([
    ['null', null],
    ['array', []],
    ['Promise', Promise.resolve({ valid: true, issues: [] })],
    ['missing issues', { valid: true }],
    ['extra member', { valid: true, issues: [], extra: true }],
    ['true with issues', { valid: true, issues: [{ code: 'contradiction' }] }],
    ['false without issues', { valid: false, issues: [] }],
  ] as const)('rejects a malformed semantic validator result: %s', async (_label, semanticResult) => {
    const writer = vi.fn(async () => 'unreachable');

    await expect(executeValidatedWrite(
      createValidatorRegistry(),
      'dateTime',
      '2026-07-17T04:00:00Z',
      () => semanticResult as never,
      writer,
    )).rejects.toBeInstanceOf(TypeError);
    expect(writer).not.toHaveBeenCalled();
  });

  it('propagates a throwing semantic validator and never calls the writer', async () => {
    const failure = new Error('semantic validator crashed');
    const writer = vi.fn(async () => 'unreachable');

    await expect(executeValidatedWrite(
      createValidatorRegistry(),
      'dateTime',
      '2026-07-17T04:00:00Z',
      () => {
        throw failure;
      },
      writer,
    )).rejects.toBe(failure);
    expect(writer).not.toHaveBeenCalled();
  });

  it('rejects a writer that attempts to mutate the immutable validated value', async () => {
    const writer = vi.fn(async (value: Readonly<Record<string, any>>) => {
      (value.root as Record<string, unknown>).title = 'rewritten';
      return 'unreachable';
    });

    await expect(executeValidatedWrite(
      createValidatorRegistry(),
      'collectionCreateRequest',
      fixture('publisher-collection-create.json'),
      () => ({ valid: true as const, issues: [] as const }),
      writer,
    )).rejects.toBeInstanceOf(TypeError);
    expect(writer).toHaveBeenCalledOnce();
  });

  it('preserves the existing validateWireDocument result and identity semantics', () => {
    const validators = createValidatorRegistry();
    const value = { 'https://example.com/ext/marker': 'caller-owned' };
    const semantics = vi.fn(() => ({ valid: true as const, issues: [] as const }));

    const valid = validateWireDocument(validators, 'extensions', value, semantics);
    const structural = validateWireDocument(validators, 'dateTime', 'not-a-date', semantics);
    const issue = { code: 'injected', message: 'semantic failure', path: '' };
    const semantic = validateWireDocument(
      validators,
      'dateTime',
      '2026-07-17T04:00:00Z',
      () => ({ valid: false as const, issues: [issue] as const }),
    );

    expect(valid).toEqual({ valid: true, value });
    if (!valid.valid) return;
    expect(valid.value).toBe(value);
    expect(Object.isFrozen(valid.value)).toBe(false);
    expect(structural).toMatchObject({ valid: false, stage: 'structural' });
    expect(semantic).toEqual({ valid: false, stage: 'semantic', issues: [issue] });
    expect(semantics).toHaveBeenCalledOnce();
  });
});

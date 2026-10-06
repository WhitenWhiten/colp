import { describe, expect, it, vi } from 'vitest';
import type { AnySchema } from 'ajv';

import { collectionProtocolSchema, createAjv } from '../../src/schema/index.js';
import {
  collectionsGetToolDefinition,
  createMcpReadToolGateway,
} from '../../src/mcp/collections-get.js';
import {
  collectionsGetSnapshotToolDefinition,
  createCollectionsGetSnapshotTool,
} from '../../src/mcp/collections-get-snapshot.js';
import { createCanonicalMcpSchemaReference, materializeClosedMcpToolSchema } from '../../src/mcp/schema-ref.js';

interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly outputSchema?: unknown;
  readonly [field: PropertyKey]: unknown;
}

interface ToolGateway {
  readonly listTools: () => readonly ToolDefinition[];
}


interface PublishedDefinition {
  readonly source: string;
  readonly definition: ToolDefinition;
}

const evidence = '[evidence:mcp.canonical-schema-refs]';
const canonicalPrefix = `${collectionProtocolSchema.$id}#/$defs/`;

const documentedCanonicalNames = Object.freeze([
  'opaqueId',
  'accessPolicy',
  'accessPolicyPatch',
  'apiKeyMetadata',
  'apiKeyCreateRequest',
  'apiKeyCreateResult',
  'apiKeyRotateRequest',
  'apiKeyRotateResult',
  'apiKeyDirectory',
  'rateLimitPolicy',
  'rateLimitPolicyPatch',
  'rateLimitDirectory',
  'auditEvent',
  'auditDirectory',
  'changePlanRequest',
  'changePlan',
  'changeCommitRequest',
  'changeCommitResult',
  'mcpToolsList',
] as const);


function requireDefinition(
  definition: ToolDefinition | undefined,
  name: string,
): ToolDefinition {
  expect(definition, `MCP-0015 requires the public ${name} definition`).toBeDefined();
  expect(definition?.name).toBe(name);
  return definition!;
}

function createGateway(): ToolGateway {
  return createMcpReadToolGateway({
    getCollection: () => {
      throw new Error('schema discovery must not invoke the read port');
    },
  }) as unknown as ToolGateway;
}

function publishedDefinitions(): readonly PublishedDefinition[] {
  const gatewayDefinitions = createGateway().listTools();
  const directGet = requireDefinition(collectionsGetToolDefinition, 'collections.get');
  const directSnapshot = requireDefinition(
    collectionsGetSnapshotToolDefinition,
    'collections.get_snapshot',
  );
  return Object.freeze([
    Object.freeze({ source: 'gateway collections.get', definition: gatewayDefinitions[0]! }),
    Object.freeze({ source: 'exported collections.get', definition: directGet }),
    Object.freeze({ source: 'exported collections.get_snapshot', definition: directSnapshot }),
  ]);
}

function ownDataValue(value: object, name: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  expect(descriptor, `${String(name)} must be an own property`).toBeDefined();
  expect(descriptor && 'value' in descriptor, `${String(name)} must be a data property`).toBe(true);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function assertCanonicalReferenceGraph(schema: unknown): void {
  const visit = (candidate: unknown, seen: Set<object>): void => {
    if (typeof candidate !== 'object' || candidate === null || seen.has(candidate)) return;
    seen.add(candidate);

    const prototype = Object.getPrototypeOf(candidate) as unknown;
    if (Array.isArray(candidate)) {
      expect(prototype).toBe(Array.prototype);
    } else {
      expect([Object.prototype, null]).toContain(prototype);
    }

    for (const key of Reflect.ownKeys(candidate)) {
      expect(typeof key, 'JSON Schema members must not use symbol keys').toBe('string');
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key)!;
      expect('value' in descriptor, `JSON Schema member ${String(key)} must not be an accessor`).toBe(true);
      if (!('value' in descriptor) || typeof key !== 'string') continue;

      expect(key).not.toBe('$defs');
      expect(key).not.toBe('$id');
      expect(key).not.toBe('$schema');
      if (key === '$ref') {
        expect(typeof descriptor.value).toBe('string');
        const reference = descriptor.value as string;
        expect(reference.startsWith(canonicalPrefix)).toBe(true);
        const definitionName = reference.slice(canonicalPrefix.length);
        expect(reference).toBe(`${canonicalPrefix}${definitionName}`);
        expect(definitionName).not.toMatch(/[%#?&/\\]/u);
        expect(definitionName.length).toBeGreaterThan(0);
        const canonicalDefinition = Object.getOwnPropertyDescriptor(
          collectionProtocolSchema.$defs,
          definitionName,
        );
        expect(canonicalDefinition, `${reference} must resolve to an own canonical $defs key`).toBeDefined();
        expect(canonicalDefinition && 'value' in canonicalDefinition).toBe(true);
      }
      visit(descriptor.value, seen);
    }
  };

  visit(schema, new Set<object>());
}

function assertDirectOpaqueCollectionId(schema: unknown): void {
  expect(typeof schema).toBe('object');
  expect(schema).not.toBeNull();
  const properties = ownDataValue(schema as object, 'properties');
  expect(typeof properties).toBe('object');
  expect(properties).not.toBeNull();
  const collectionId = ownDataValue(properties as object, 'collectionId');
  expect(collectionId).toEqual({ $ref: `${canonicalPrefix}opaqueId` });
  expect(Reflect.ownKeys(collectionId as object)).toEqual(['$ref']);
  expect(collectionId).not.toHaveProperty('type');
  expect(collectionId).not.toHaveProperty('pattern');
  expect(collectionId).not.toHaveProperty('format');
  expect(collectionId).not.toHaveProperty('minLength');
  expect(collectionId).not.toHaveProperty('maxLength');
}

function expectDeeplyFrozen(value: unknown, seen = new Set<object>()): void {
  if (typeof value !== 'object' || value === null || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    expect('value' in descriptor, 'published schemas must contain data properties only').toBe(true);
    if ('value' in descriptor) expectDeeplyFrozen(descriptor.value, seen);
  }
}

function compilePublishedSchema(schema: unknown): void {
  const closed = materializeClosedMcpToolSchema(schema as Record<string, unknown>);
  const ajv = createAjv({ ownProperties: true });
  expect(() => ajv.compile(closed as AnySchema)).not.toThrow();
  assertNoCollectionProtocolOrgRef(closed);
}

function assertNoCollectionProtocolOrgRef(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) assertNoCollectionProtocolOrgRef(entry);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === '$ref' && typeof child === 'string') {
      expect(child.includes('collectionprotocol.org')).toBe(false);
    }
    assertNoCollectionProtocolOrgRef(child);
  }
}

function expectInvalidHelperCall(args: readonly unknown[]): void {
  const helper = createCanonicalMcpSchemaReference;
  expect(() => Reflect.apply(helper, undefined, args)).toThrow();
}

describe(`MCP-0015 canonical MCP Tool schema references ${evidence}`, () => {
  it(`publishes one helper and the exact current read Tool definitions at both boundaries ${evidence}`, () => {
    const helper = createCanonicalMcpSchemaReference;
    expect(createCanonicalMcpSchemaReference).toBe(helper);
    expect(collectionsGetToolDefinition).toBe(collectionsGetToolDefinition);
    expect(collectionsGetSnapshotToolDefinition).toBe(
      collectionsGetSnapshotToolDefinition,
    );

    const gatewayDefinitions = createGateway().listTools();
    expect(gatewayDefinitions.map(({ name }) => name)).toEqual(['collections.get']);
    expect(gatewayDefinitions[0]).toBe(collectionsGetToolDefinition);

    const snapshotTool = createCollectionsGetSnapshotTool(
      { serverUuid: '123e4567-e89b-42d3-a456-426614174000' },
      { getCollectionSnapshotLinkMetadata: () => { throw new Error('not invoked'); } },
    );
    expect(snapshotTool.definition).toBe(collectionsGetSnapshotToolDefinition);
  });

  it(`recursively resolves and compiles every published input/output schema without cloned output DTOs ${evidence}`, () => {
    for (const { source, definition } of publishedDefinitions()) {
      const inputDescriptor = Object.getOwnPropertyDescriptor(definition, 'inputSchema');
      expect(inputDescriptor, `${source} must own inputSchema`).toBeDefined();
      expect(inputDescriptor && 'value' in inputDescriptor).toBe(true);
      assertCanonicalReferenceGraph(definition.inputSchema);
      assertDirectOpaqueCollectionId(definition.inputSchema);
      compilePublishedSchema(definition.inputSchema);

      const outputDescriptor = Object.getOwnPropertyDescriptor(definition, 'outputSchema');
      if (outputDescriptor === undefined) {
        expect(Reflect.ownKeys(definition)).not.toContain('outputSchema');
      } else {
        expect('value' in outputDescriptor).toBe(true);
        if ('value' in outputDescriptor) {
          assertCanonicalReferenceGraph(outputDescriptor.value);
          compilePublishedSchema(outputDescriptor.value);
        }
      }
    }
  });

  it(`keeps published schemas deeply frozen, detached, and identical to runtime publication ${evidence}`, () => {
    const definitions = publishedDefinitions();
    for (const { definition } of definitions) expectDeeplyFrozen(definition);
    expect(definitions[0]!.definition).toBe(definitions[1]!.definition);
    expect(definitions[2]!.definition).not.toBe(definitions[1]!.definition);
    expect(definitions[2]!.definition.inputSchema).not.toBe(definitions[1]!.definition.inputSchema);

    const getCollectionId = ownDataValue(
      ownDataValue(definitions[1]!.definition.inputSchema as object, 'properties') as object,
      'collectionId',
    );
    const snapshotCollectionId = ownDataValue(
      ownDataValue(definitions[2]!.definition.inputSchema as object, 'properties') as object,
      'collectionId',
    );
    expect(getCollectionId).not.toBe(snapshotCollectionId);
  });

  it(`does not expand the gateway or expose write, Plan, approval, key, or OAuth schemas ${evidence}`, () => {
    const definitions = publishedDefinitions();
    const exposed = definitions.flatMap(({ definition }) => [
      definition.name,
      definition.description,
      ...Reflect.ownKeys(definition).map(String),
      JSON.stringify(definition),
    ]).join(' ');
    expect(createGateway().listTools()).toHaveLength(1);
    expect(exposed).not.toMatch(
      /create|update|delete|move|write|plan|commit|approv|api.?key|oauth|secret/iu,
    );
  });

  it.each(documentedCanonicalNames)(
    `creates only an exact frozen canonical reference for %s ${evidence}`,
    (definitionName) => {
      const reference = createCanonicalMcpSchemaReference(definitionName);
      expect(reference).toEqual({ $ref: `${canonicalPrefix}${definitionName}` });
      expect(Reflect.ownKeys(reference as object)).toEqual(['$ref']);
      expect(Object.isFrozen(reference)).toBe(true);
      expect(reference).not.toBe(collectionProtocolSchema.$defs[definitionName]);
      expect(JSON.stringify(reference)).not.toContain(JSON.stringify(
        collectionProtocolSchema.$defs[definitionName],
      ));
    },
  );

  it.each([
    ['missing and extra arguments', () => {
      expectInvalidHelperCall([]);
      expectInvalidHelperCall(['opaqueId', 'unexpected']);
    }],
    ['nullish names', () => {
      expectInvalidHelperCall([undefined]);
      expectInvalidHelperCall([null]);
    }],
    ['non-string primitive names', () => {
      expectInvalidHelperCall([1]);
      expectInvalidHelperCall([true]);
      expectInvalidHelperCall([Symbol('opaqueId')]);
    }],
    ['an accessor-backed boxed name without evaluating it', () => {
      const getter = vi.fn(() => 'opaqueId');
      const boxed = Object.defineProperty({}, Symbol.toPrimitive, { get: getter });
      expectInvalidHelperCall([boxed]);
      expect(getter).not.toHaveBeenCalled();
    }],
    ['an unknown own name', () => expectInvalidHelperCall(['notCanonical'])],
    ['names inherited by ordinary objects', () => {
      for (const name of ['toString', 'constructor', '__proto__']) expectInvalidHelperCall([name]);
    }],
    ['encoded or structurally ambiguous names', () => {
      for (const name of ['opaque%49d', 'opaqueId#x', 'opaqueId?x', 'opaqueId/x']) {
        expectInvalidHelperCall([name]);
      }
    }],
  ] as const)(`rejects %s ${evidence}`, (_label, assertion) => assertion());

  it.each([
    ['relative and external references', () => {
      expect(() => assertCanonicalReferenceGraph({ $ref: '#/$defs/opaqueId' })).toThrow();
      expect(() => assertCanonicalReferenceGraph({ $ref: 'https://attacker.invalid/#/$defs/opaqueId' })).toThrow();
    }],
    ['encoded, query, and fragment ambiguity after the canonical prefix', () => {
      for (const suffix of ['opaque%49d', 'opaqueId?x', 'opaqueId#x', 'opaqueId/x']) {
        expect(() => assertCanonicalReferenceGraph({ $ref: `${canonicalPrefix}${suffix}` })).toThrow();
      }
    }],
    ['a local copied definition authority', () => {
      expect(() => assertCanonicalReferenceGraph({
        $defs: { opaqueId: { type: 'string' } },
        $ref: '#/$defs/opaqueId',
      })).toThrow();
    }],
    ['alternate id and dialect authorities', () => {
      expect(() => assertCanonicalReferenceGraph({ $id: collectionProtocolSchema.$id })).toThrow();
      expect(() => assertCanonicalReferenceGraph({ $schema: collectionProtocolSchema.$schema })).toThrow();
    }],
    ['an inherited reference', () => {
      expect(() => assertCanonicalReferenceGraph(Object.create({
        $ref: `${canonicalPrefix}opaqueId`,
      }))).toThrow();
    }],
    ['accessor and symbol references without evaluating the accessor', () => {
      const getter = vi.fn(() => `${canonicalPrefix}opaqueId`);
      const accessor = Object.defineProperty({}, '$ref', { enumerable: true, get: getter });
      expect(() => assertCanonicalReferenceGraph(accessor)).toThrow();
      expect(getter).not.toHaveBeenCalled();
      expect(() => assertCanonicalReferenceGraph({
        [Symbol('$ref')]: `${canonicalPrefix}opaqueId`,
      })).toThrow();
    }],
    ['an inline clone of the opaque ID body', () => {
      expect(() => assertDirectOpaqueCollectionId({
        properties: { collectionId: { type: 'string', minLength: 1, maxLength: 128 } },
      })).toThrow();
    }],
  ] as const)(`does not mistake %s for a canonical schema reference ${evidence}`, (_label, assertion) => {
    assertion();
  });

  it(`compiles materialized wire schemas without addSchema(canonical) and without collectionprotocol.org $ref ${evidence}`, () => {
    for (const { definition } of publishedDefinitions()) {
      const closed = materializeClosedMcpToolSchema(
        definition.inputSchema as Record<string, unknown>,
      );
      expect(closed.$defs).toBeDefined();
      expect(
        Object.prototype.hasOwnProperty.call(closed.$defs as object, 'opaqueId'),
      ).toBe(true);
      expect((closed.$defs as { opaqueId?: unknown }).opaqueId).toEqual(
        collectionProtocolSchema.$defs.opaqueId,
      );
      compilePublishedSchema(definition.inputSchema);
    }
  });
});

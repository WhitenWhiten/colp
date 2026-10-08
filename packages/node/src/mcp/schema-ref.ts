import { collectionProtocolSchema } from '../schema/index.js';
import type { McpToolSchema } from './tool-input.js';
import { isProxy } from 'node:util/types';

export interface CanonicalMcpSchemaReference extends McpToolSchema {
  readonly $ref: string;
}

const CANONICAL_SCHEMA_ID = collectionProtocolSchema.$id;
const CANONICAL_DEFS_HASH = '#/$defs/';
const LOCAL_DEFS_POINTER = '#/$defs/';
const MAX_SCHEMA_DEPTH = 64;
const MAX_SCHEMA_NODES = 10_000;
const MAX_SCHEMA_MEMBERS = 100_000;
const MAX_SCHEMA_WIDTH = 2_048;
const MAX_SCHEMA_BYTES = 8 * 1024 * 1024;

/** Creates an MCP schema reference without exposing or reproducing a canonical definition body. */
export function createCanonicalMcpSchemaReference(
  definitionName: unknown,
): CanonicalMcpSchemaReference {
  if (arguments.length !== 1 || typeof definitionName !== 'string') {
    throw new TypeError('A canonical Collection Protocol schema definition name is required.');
  }

  const schemaIdDescriptor = Object.getOwnPropertyDescriptor(collectionProtocolSchema, '$id');
  const definitionsDescriptor = Object.getOwnPropertyDescriptor(
    collectionProtocolSchema,
    '$defs',
  );
  if (
    schemaIdDescriptor === undefined
    || !('value' in schemaIdDescriptor)
    || typeof schemaIdDescriptor.value !== 'string'
    || definitionsDescriptor === undefined
    || !('value' in definitionsDescriptor)
    || typeof definitionsDescriptor.value !== 'object'
    || definitionsDescriptor.value === null
  ) {
    throw new TypeError('The canonical Collection Protocol schema boundary is invalid.');
  }

  const definitionDescriptor = Object.getOwnPropertyDescriptor(
    definitionsDescriptor.value,
    definitionName,
  );
  if (definitionDescriptor === undefined || !('value' in definitionDescriptor)) {
    throw new RangeError('Unknown canonical Collection Protocol schema definition.');
  }

  return Object.freeze({
    $ref: `${schemaIdDescriptor.value}#/$defs/${definitionName}`,
  });
}

/**
 * Rewrites absolute Collection Protocol `$ref` values to local `#/$defs/…`
 * pointers and copies the referenced package `$defs` into the document.
 * Wire `tools/list` must emit this closed form so clients never fetch
 * know-n.com/colp. Does not change package `$id` or Problem types.
 */
export function materializeClosedMcpToolSchema(
  schema: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    throw new TypeError('A JSON Schema object is required to materialize MCP tool schemas.');
  }
  assertSchemaWithinBudget(schema);
  const rewritten = rewriteCanonicalRefs(schema);
  const defs = referencedCanonicalDefs(rewritten);
  const closed = defs === undefined
    ? rewritten
    : { ...(rewritten as Record<string, unknown>), $defs: defs };
  assertNoCanonicalHttpRef(closed);
  return closed as Readonly<Record<string, unknown>>;
}

/** Reject hostile schema graphs before recursive ref rewriting can overflow or loop. */
function assertSchemaWithinBudget(root: object): void {
  const active = new WeakSet<object>();
  const visited = new WeakSet<object>();
  const stack: Array<{ value: object; depth: number; exit?: boolean }> = [{ value: root, depth: 0 }];
  let nodes = 0;
  let members = 0;
  let bytes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (isProxy(current.value)) throw new RangeError('MCP tool schema contains a Proxy.');
    if (current.exit) { active.delete(current.value); continue; }
    if (active.has(current.value)) throw new RangeError('MCP tool schema must not contain cycles.');
    if (visited.has(current.value)) continue;
    if (current.depth > MAX_SCHEMA_DEPTH) throw new RangeError('MCP tool schema exceeds maximum depth.');
    visited.add(current.value);
    active.add(current.value);
    stack.push({ value: current.value, depth: current.depth, exit: true });
    nodes += 1;
    if (nodes > MAX_SCHEMA_NODES) throw new RangeError('MCP tool schema exceeds node budget.');
    const keys = Reflect.ownKeys(current.value);
    if (keys.length > MAX_SCHEMA_WIDTH) throw new RangeError('MCP tool schema exceeds object width budget.');
    members += keys.length;
    if (members > MAX_SCHEMA_MEMBERS) throw new RangeError('MCP tool schema exceeds member budget.');
    for (const key of keys) {
      if (typeof key !== 'string') throw new TypeError('MCP tool schema must not contain symbol keys.');
      bytes += Buffer.byteLength(key, 'utf8');
      if (bytes > MAX_SCHEMA_BYTES) throw new RangeError('MCP tool schema exceeds byte budget.');
      const descriptor = Object.getOwnPropertyDescriptor(current.value, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError('MCP tool schema must contain enumerable data properties.');
      }
      const child = descriptor.value;
      if (typeof child === 'string') {
        bytes += Buffer.byteLength(child, 'utf8');
        if (bytes > MAX_SCHEMA_BYTES) throw new RangeError('MCP tool schema exceeds byte budget.');
      } else if (child !== null && typeof child === 'object') {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
}

function rewriteCanonicalRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rewriteCanonicalRefs);
  if (value === null || typeof value !== 'object') return value;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === '$ref' && typeof child === 'string') {
      const name = canonicalDefName(child);
      next[key] = name === undefined ? child : `${LOCAL_DEFS_POINTER}${name}`;
      continue;
    }
    next[key] = rewriteCanonicalRefs(child);
  }
  return next;
}

function referencedCanonicalDefs(schema: unknown): Record<string, unknown> | undefined {
  const roots = new Set<string>();
  collectDefNames(schema, roots);
  if (roots.size === 0) return undefined;
  const allDefs = collectionProtocolSchema.$defs as Readonly<Record<string, unknown>>;
  const needed = new Set<string>();
  const visit = (name: string): void => {
    if (needed.has(name)) return;
    needed.add(name);
    const def = allDefs[name];
    if (def === undefined) {
      throw new TypeError('Unknown Collection Protocol schema definition.');
    }
    const nested = new Set<string>();
    collectDefNames(def, nested);
    for (const child of nested) visit(child);
  };
  for (const name of roots) visit(name);
  const subset: Record<string, unknown> = {};
  for (const name of needed) {
    const def = allDefs[name];
    if (def === undefined) {
      throw new TypeError('Unknown Collection Protocol schema definition.');
    }
    subset[name] = rewriteCanonicalRefs(def);
  }
  return subset;
}

function collectDefNames(value: unknown, names: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectDefNames(entry, names);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === '$ref' && typeof child === 'string') {
      const name = canonicalDefName(child);
      if (name !== undefined) names.add(name);
      continue;
    }
    collectDefNames(child, names);
  }
}

function canonicalDefName(reference: string): string | undefined {
  if (reference.startsWith(LOCAL_DEFS_POINTER)) {
    const name = reference.slice(LOCAL_DEFS_POINTER.length);
    return name.length > 0 && !name.includes('/') ? name : undefined;
  }
  const absolutePrefix = `${CANONICAL_SCHEMA_ID}${CANONICAL_DEFS_HASH}`;
  if (reference.startsWith(absolutePrefix)) {
    const name = reference.slice(absolutePrefix.length);
    return name.length > 0 && !name.includes('/') ? name : undefined;
  }
  return undefined;
}

function assertNoCanonicalHttpRef(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) assertNoCanonicalHttpRef(entry);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === '$ref' && typeof child === 'string' && child.includes('know-n.com/colp')) {
      throw new TypeError('Closed MCP tool schemas must not $ref know-n.com/colp.');
    }
    assertNoCanonicalHttpRef(child);
  }
}


import { types as nodeTypes } from 'node:util';

/**
 * The closed own-data contract shared by MCP adapters.
 *
 * Every boundary that copies caller-supplied configuration or protocol input
 * must read only own data properties: no Proxy, no accessor, no inherited
 * property. Each adapter supplies its own failure factory so error codes stay
 * protocol-specific (`configError`, `resourceError`, `invalidParams`), while
 * the actual check exists exactly once.
 */
export interface OwnDataGuards {
  assertExactDataObject(value: unknown, required: readonly string[], optional?: readonly string[],
    fail?: () => Error): asserts value is object;
  readOwnValue(value: object, name: string, fail?: () => Error): unknown;
  readOwnData(value: object, name: string, fail?: () => Error): unknown;
  readOptionalData(value: unknown, name: string): unknown;
}

export function createOwnDataGuards(defaultFail: () => Error): OwnDataGuards {
  function assertExactDataObject(
    value: unknown,
    required: readonly string[],
    optional: readonly string[] = [],
    fail: () => Error = defaultFail,
  ): asserts value is object {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || nodeTypes.isProxy(value)) {
      throw fail();
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw fail();
    const allowed = new Set([...required, ...optional]);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string' || !allowed.has(key))) throw fail();
    if (required.some((key) => !keys.includes(key))) throw fail();
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor)) throw fail();
    }
  }

  function readOwnValue(value: object, name: string, fail: () => Error = defaultFail): unknown {
    if (nodeTypes.isProxy(value)) throw fail();
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor === undefined) return undefined;
    if (!('value' in descriptor)) throw fail();
    return descriptor.value;
  }

  function readOwnData(value: object, name: string, fail: () => Error = defaultFail): unknown {
    if (nodeTypes.isProxy(value)) throw fail();
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor === undefined || !('value' in descriptor)) throw fail();
    return descriptor.value;
  }

  function readOptionalData(value: unknown, name: string): unknown {
    if (typeof value !== 'object' || value === null || nodeTypes.isProxy(value)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor === undefined || !('value' in descriptor)) return undefined;
    return descriptor.value;
  }

  return Object.freeze({ assertExactDataObject, readOwnValue, readOwnData, readOptionalData });
}

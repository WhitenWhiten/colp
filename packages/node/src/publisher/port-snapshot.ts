import { types as nodeTypes } from 'node:util';

/**
 * Internal snapshot primitives shared by Publisher endpoint adapters.
 *
 * Ports are captured once, before any asynchronous work, so later mutations of
 * the adapter object cannot change which method a request runs. The same
 * snapshot also enforces the Publisher port contract: no Proxy at any level of
 * the lookup chain, no accessor that could run application code while reading,
 * and a native Promise result. These checks are deliberately independent of the
 * MCP own-data policy, which permits a different port shape.
 *
 * `label` is the caller's full description of the port or result being checked;
 * it is only used to build a TypeError message and never interpreted.
 */

export function assertPortObject(value: unknown, description: string): asserts value is object {
  if (value === null || typeof value !== 'object' || nodeTypes.isProxy(value)) {
    throw new TypeError(`${description} is required and cannot be a Proxy.`);
  }
}

export function findDataProperty(owner: object, name: string, label: string): PropertyDescriptor | undefined {
  let current: object | null = owner;
  while (current !== null) {
    if (nodeTypes.isProxy(current)) throw new TypeError(`${label} port prototype cannot be a Proxy.`);
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor !== undefined) {
      // Reject accessors before reading them: a getter must never run as part
      // of taking the snapshot, and a setter-only member is not a method.
      if (!('value' in descriptor)) throw new TypeError(`${label} ${name} must be a data property.`);
      return descriptor;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return undefined;
}

export function dataValue(owner: object, name: string, label: string): unknown {
  const descriptor = findDataProperty(owner, name, label);
  if (descriptor === undefined) throw new TypeError(`${label} ${name} must be a data property.`);
  return descriptor.value;
}

export function bindMethod<Method extends (...args: any[]) => unknown>(
  owner: object,
  name: string,
  label: string,
): Method {
  const descriptor = findDataProperty(owner, name, label);
  if (descriptor === undefined || typeof descriptor.value !== 'function' || nodeTypes.isProxy(descriptor.value)) {
    throw new TypeError(`${label} ${name} must be a non-Proxy data method.`);
  }
  const method = descriptor.value as Method;
  // Keep the receiver the port object supplied, not the wrapper's call site.
  return ((...args: Parameters<Method>) => Reflect.apply(method, owner, args)) as Method;
}

export function optionalMethod<Method extends ((...args: any[]) => unknown) | undefined>(
  owner: object,
  name: string,
  label: string,
): Method {
  const descriptor = findDataProperty(owner, name, label);
  if (descriptor === undefined) return undefined as Method;
  if (typeof descriptor.value !== 'function' || nodeTypes.isProxy(descriptor.value)) {
    throw new TypeError(`${label} ${name} must be a non-Proxy data method.`);
  }
  const method = descriptor.value;
  return ((...args: unknown[]) => Reflect.apply(method, owner, args)) as Method;
}

export function dataObject(owner: unknown, name: string, label: string): object {
  if (owner === null || typeof owner !== 'object' || nodeTypes.isProxy(owner)) {
    throw new TypeError(`${label} must be a non-Proxy object.`);
  }
  const descriptor = findDataProperty(owner, name, label);
  if (descriptor === undefined
    || descriptor.value === null || typeof descriptor.value !== 'object'
    || nodeTypes.isProxy(descriptor.value)) {
    throw new TypeError(`${label} ${name} must be a non-Proxy data object.`);
  }
  return descriptor.value;
}

export function requirePromise<Result>(candidate: Promise<Result>, label: string): Promise<Result> {
  if (!(candidate instanceof Promise)) throw new TypeError(`${label} must return a native Promise.`);
  return candidate;
}

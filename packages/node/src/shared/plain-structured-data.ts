import { types as nodeTypes } from 'node:util';
import { hasDenseArrayOwnKeys } from './dense-array-keys.js';

export function assertPlainStructuredSource(value: unknown, label = 'Node write input', visited = new WeakSet<object>()): void {
  if (value === null || typeof value !== 'object' || visited.has(value)) return;
  if (nodeTypes.isProxy(value)) throw new TypeError(`${label} cannot contain a Proxy.`);
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype && prototype !== null) {
      throw new TypeError(`${label} arrays must have a plain prototype.`);
    }
    const length = value.length;
    const keys = Reflect.ownKeys(value);
    if (!hasDenseArrayOwnKeys(keys, length)) {
      throw new TypeError(`${label} arrays must be dense and contain no extra properties.`);
    }
  } else if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must contain only plain structured data.`);
  }
  visited.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || descriptor === undefined || !('value' in descriptor)
      || (key !== 'length' && !descriptor.enumerable)) {
      throw new TypeError(`${label} cannot contain accessors.`);
    }
    if (key !== 'length') assertPlainStructuredSource(descriptor.value, label, visited);
  }
}

export function assertPlainStructuredData(value: unknown, label = 'Node write candidate', visited = new WeakSet<object>()): void {
  if (value === null || typeof value !== 'object' || visited.has(value)) return;
  if (nodeTypes.isProxy(value)) throw new TypeError(`${label} cannot contain a Proxy.`);
  visited.add(value);
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must contain only plain structured data.`);
  }
  for (const child of Object.values(value)) assertPlainStructuredData(child, label, visited);
}

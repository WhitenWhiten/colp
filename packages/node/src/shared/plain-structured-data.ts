import { types as nodeTypes } from 'node:util';
import { hasDenseArrayOwnKeys } from './dense-array-keys.js';

/** Shared ceilings for untrusted structured values before structuredClone/Ajv. */
export const PLAIN_STRUCTURED_DATA_LIMITS = Object.freeze({
  maxDepth: 256,
  maxNodes: 10_000,
  maxMembers: 100_000,
  maxBytes: 64 * 1024 * 1024,
});

type WalkItem = { readonly value: object; readonly depth: number };

/** Count UTF-8 bytes without allocating a copy of an untrusted string. */
function utf8Bytes(value: string, limit: number): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const width = code <= 0x7f
      ? 1
      : code <= 0x7ff
        ? 2
        : code >= 0xd800 && code <= 0xdbff
          && index + 1 < value.length
          && value.charCodeAt(index + 1) >= 0xdc00
          && value.charCodeAt(index + 1) <= 0xdfff
          ? (index += 1, 4)
          : 3;
    bytes += width;
    if (bytes > limit) return bytes;
  }
  return bytes;
}

function walkStructuredData(value: unknown, label: string, source: boolean): void {
  if (value === null || typeof value !== 'object') return;
  const visited = new WeakSet<object>();
  const pending: WalkItem[] = [{ value: value as object, depth: 0 }];
  let nodes = 0;
  let members = 0;
  let bytes = 0;

  const charge = (amount: number): void => {
    if (!Number.isSafeInteger(amount) || amount < 0 || bytes > PLAIN_STRUCTURED_DATA_LIMITS.maxBytes - amount) {
      throw new TypeError(`${label} exceeds the structured data byte budget.`);
    }
    bytes += amount;
  };
  const chargeText = (text: string): void => {
    charge(utf8Bytes(text, PLAIN_STRUCTURED_DATA_LIMITS.maxBytes - bytes));
  };

  while (pending.length > 0) {
    const item = pending.pop()!;
    if (visited.has(item.value)) continue;
    if (item.depth > PLAIN_STRUCTURED_DATA_LIMITS.maxDepth) {
      throw new TypeError(`${label} exceeds the structured data depth budget.`);
    }
    if (nodeTypes.isProxy(item.value)) throw new TypeError(`${label} cannot contain a Proxy.`);
    visited.add(item.value);
    nodes += 1;
    if (nodes > PLAIN_STRUCTURED_DATA_LIMITS.maxNodes) {
      throw new TypeError(`${label} exceeds the structured data node budget.`);
    }

    const prototype = Object.getPrototypeOf(item.value) as unknown;
    const array = Array.isArray(item.value);
    if (array) {
      if (prototype !== Array.prototype && prototype !== null) {
        throw new TypeError(`${label} arrays must have a plain prototype.`);
      }
      const lengthDescriptor = Object.getOwnPropertyDescriptor(item.value, 'length');
      const length = lengthDescriptor !== undefined && 'value' in lengthDescriptor
        ? lengthDescriptor.value
        : undefined;
      if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0
        || length > PLAIN_STRUCTURED_DATA_LIMITS.maxMembers) {
        throw new TypeError(`${label} arrays exceed the structured data member budget.`);
      }
      if (!hasDenseArrayOwnKeys(Reflect.ownKeys(item.value), length)) {
        throw new TypeError(`${label} arrays must be dense and contain no extra properties.`);
      }
    } else if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${label} must contain only plain structured data.`);
    }

    const keys = Reflect.ownKeys(item.value);
    members += array ? Math.max(0, keys.length - 1) : keys.length;
    if (members > PLAIN_STRUCTURED_DATA_LIMITS.maxMembers) {
      throw new TypeError(`${label} exceeds the structured data member budget.`);
    }
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(item.value, key);
      if (array && key === 'length') continue;
      if (typeof key !== 'string' || descriptor === undefined || !('value' in descriptor)
        || (source ? !descriptor.enumerable : false)) {
        throw new TypeError(`${label} cannot contain accessors or symbol properties.`);
      }
      chargeText(key);
      const child = descriptor.value;
      if (typeof child === 'string') chargeText(child);
      if (child !== null && typeof child === 'object') {
        pending.push({ value: child, depth: item.depth + 1 });
      }
    }
  }
}

export function assertPlainStructuredSource(value: unknown, label = 'Node write input'): void {
  walkStructuredData(value, label, true);
}

export function assertPlainStructuredData(value: unknown, label = 'Node write candidate'): void {
  walkStructuredData(value, label, false);
}

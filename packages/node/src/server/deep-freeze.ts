/**
 * Deep-freezes plain object/array graphs in place using a single server contract:
 * - null / non-objects returned unchanged
 * - cycle-safe via WeakSet visited
 * - walks Reflect.ownKeys (includes non-enumerable + symbol keys)
 * - freezes nested values only for own data properties (`'value' in descriptor`)
 * - does not invoke accessors
 * - skips array `length` key when walking
 * - freezes the object after children
 */
export function deepFreeze<Value>(value: Value, visited = new WeakSet<object>()): Readonly<Value> {
  if (value === null || typeof value !== 'object' || visited.has(value)) return value;
  visited.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && 'value' in descriptor) {
      deepFreeze(descriptor.value, visited);
    }
  }
  return Object.freeze(value);
}

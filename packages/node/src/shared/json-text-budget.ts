import { isProxy } from 'node:util/types';
import { TextByteBudget } from './text-budget.js';

/** Count serialized occurrences before stringify allocates the output string. */
export function assertJsonTextBudget(root: unknown, maxBytes: number): void {
  const bytes = new TextByteBudget(maxBytes, 'JSON output');
  const active = new WeakSet<object>();
  const stack: Array<{ value: unknown; depth: number; exit?: boolean }> = [{ value: root, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const { value, depth, exit } = stack.pop()!;
    if (exit) { active.delete(value as object); continue; }
    if (++nodes > 1_000_000 || depth > 512) throw new RangeError('JSON output exceeds graph budget');
    if (typeof value === 'string') { bytes.jsonString(value); continue; }
    if (value === null || typeof value === 'boolean') { bytes.charge(value === false ? 5 : 4); continue; }
    if (typeof value === 'number' && Number.isFinite(value)) { bytes.charge(String(value).length); continue; }
    if (typeof value !== 'object' || isProxy(value) || active.has(value)) throw new TypeError('Invalid JSON output');
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (!array && prototype !== Object.prototype && prototype !== null) throw new TypeError('Invalid JSON prototype');
    active.add(value);
    stack.push({ value, depth, exit: true });
    const keys = Reflect.ownKeys(value).filter(key => !array || key !== 'length');
    if (keys.length > 1_000_000 - nodes) throw new RangeError('JSON output exceeds member budget');
    if (array && value.length !== keys.length) throw new TypeError('Invalid JSON array');
    bytes.charge(2 + Math.max(0, keys.length - 1));
    for (const key of keys) {
      if (typeof key !== 'string') throw new TypeError('Invalid JSON member');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) throw new TypeError('Invalid JSON property');
      if (array && !/^(?:0|[1-9][0-9]*)$/u.test(key)) throw new TypeError('Invalid JSON array member');
      if (!array) { bytes.jsonString(key); bytes.charge(1); }
      stack.push({ value: descriptor.value, depth: depth + 1 });
    }
  }
}

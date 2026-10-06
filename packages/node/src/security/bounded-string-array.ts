import { isProxy } from 'node:util/types';
import { TextByteBudget } from '../shared/text-budget.js';

export interface StringArrayBudget {
  readonly maxEntries: number;
  readonly maxStringBytes: number;
  readonly maxTotalBytes: number;
  readonly allowEmpty?: boolean;
}

/** Reject over-limit length before enumerating properties or copying entries. */
export function snapshotBoundedStrings(
  value: unknown,
  label: string,
  limits: StringArrayBudget,
): readonly string[] {
  if (!Number.isSafeInteger(limits.maxEntries) || limits.maxEntries < 1) {
    throw new RangeError('String-array entry budget must be a positive safe integer.');
  }
  const total = new TextByteBudget(limits.maxTotalBytes, label);
  if (!Array.isArray(value) || isProxy(value)) throw new TypeError(`${label} must be a plain array.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Array.prototype && prototype !== null) throw new TypeError(`${label} has an unsafe prototype.`);
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value as unknown;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > limits.maxEntries) {
    throw new RangeError(`${label} exceeds the maximum entry count.`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1) throw new TypeError(`${label} must be dense without extra properties.`);
  const output: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const item = Object.getOwnPropertyDescriptor(value, String(index));
    if (!item || !item.enumerable || !('value' in item) || typeof item.value !== 'string'
      || (limits.allowEmpty !== true && item.value.length === 0)) {
      throw new TypeError(`${label} entries must be own string data properties.`);
    }
    const text = item.value as string;
    new TextByteBudget(limits.maxStringBytes, label).raw(text);
    total.raw(text);
    output.push(text);
  }
  return Object.freeze(output);
}

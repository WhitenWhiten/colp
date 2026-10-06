import { isProxy } from 'node:util/types';

import { parse } from 'lossless-json';

const prototypeKeys = new Set(['__proto__', 'constructor', 'prototype']);

/** Absolute safety ceiling; HTTP hosts may impose a smaller request budget. */
export const MAX_I_JSON_SOURCE_BYTES = 64 * 1024 * 1024;

export interface IJsonParseLimits {
  readonly maxDepth?: number;
  readonly maxMembers?: number;
  readonly maxBytes?: number;
}

export interface ResolvedIJsonParseLimits {
  readonly maxDepth: number;
  readonly maxMembers: number;
}

export const DEFAULT_I_JSON_PARSE_LIMITS: ResolvedIJsonParseLimits = Object.freeze({
  maxDepth: 128,
  maxMembers: 100_000,
});

export const MAX_I_JSON_PARSE_LIMITS: ResolvedIJsonParseLimits = Object.freeze({
  maxDepth: 512,
  maxMembers: 1_000_000,
});

export type IJsonLimitCode = 'max_depth' | 'max_members' | 'max_bytes';

export class IJsonLimitError extends RangeError {
  readonly code: IJsonLimitCode;
  readonly limit: number;

  constructor(code: IJsonLimitCode, limit: number) {
    super(
      code === 'max_depth'
        ? `I-JSON nesting depth exceeds the configured limit of ${limit}.`
        : code === 'max_members'
          ? `I-JSON member and array-item count exceeds the configured limit of ${limit}.`
          : `I-JSON data exceeds the configured byte limit of ${limit}.`,
    );
    this.name = 'IJsonLimitError';
    this.code = code;
    this.limit = limit;
  }
}

export function resolveIJsonParseLimits(
  limits: IJsonParseLimits = {},
): ResolvedIJsonParseLimits {
  // Keep this established depth/member result shape; the independent byte
  // budget is enforced before scanning, parsing, or cloning any input.
  resolveByteLimit(limits.maxBytes);
  return Object.freeze({
    maxDepth: boundedLimit(
      'maxDepth',
      limits.maxDepth,
      DEFAULT_I_JSON_PARSE_LIMITS.maxDepth,
      MAX_I_JSON_PARSE_LIMITS.maxDepth,
    ),
    maxMembers: boundedLimit(
      'maxMembers',
      limits.maxMembers,
      DEFAULT_I_JSON_PARSE_LIMITS.maxMembers,
      MAX_I_JSON_PARSE_LIMITS.maxMembers,
    ),
  });
}

export function assertIJsonSourceBytes(source: string, maxBytes = MAX_I_JSON_SOURCE_BYTES): void {
  const limit = resolveByteLimit(maxBytes);
  // UTF-16 length is a cheap lower bound for its UTF-8 representation.
  // Reject huge strings before a full byte count or parser pass.
  if (source.length > limit || Buffer.byteLength(source, 'utf8') > limit) {
    throw new IJsonLimitError('max_bytes', limit);
  }
}

export function parseIJson(source: string, limits: IJsonParseLimits = {}): unknown {
  if (typeof source !== 'string') {
    throw new TypeError('I-JSON source must be a string.');
  }
  assertIJsonSourceBytes(source, limits.maxBytes);
  assertIJsonBudget(source, resolveIJsonParseLimits(limits));
  const value = parse(
    source,
    (key, value) => {
      if (prototypeKeys.has(key)) throw prohibitedMemberNameError(key);
      return value;
    },
    {
      onDuplicateKey() {
        throw duplicateMemberError();
      },
      parseNumber(value) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) {
          throw new SyntaxError(`I-JSON number is not finite: ${value}`);
        }
        if (Number.isInteger(parsed) && !Number.isSafeInteger(parsed)) {
          throw new SyntaxError(`I-JSON integer is outside the safe range: ${value}`);
        }
        return parsed;
      },
    },
  );

  const inspect = (item: unknown): void => {
    if (typeof item !== 'object' || item === null) return;
    if (Array.isArray(item)) {
      item.forEach(inspect);
      return;
    }
    const prototype = Object.getPrototypeOf(item) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new SyntaxError('I-JSON object has an unsafe prototype.');
    }
    for (const [key, child] of Object.entries(item)) {
      if (prototypeKeys.has(key)) throw prohibitedMemberNameError(key);
      inspect(child);
    }
  };
  inspect(value);
  return value;
}

/** Clones bounded wire data without invoking getters, toJSON hooks, or custom prototypes. */
export function cloneAndFreezeJsonData<Value>(value: Value, limits: IJsonParseLimits = {}): Readonly<Value> {
  const ancestors = new WeakSet<object>();
  const bounds = resolveIJsonParseLimits({
    ...limits,
    maxDepth: limits.maxDepth ?? MAX_I_JSON_PARSE_LIMITS.maxDepth,
    maxMembers: limits.maxMembers ?? MAX_I_JSON_PARSE_LIMITS.maxMembers,
  });
  const maxBytes = resolveByteLimit(limits.maxBytes);
  let bytes = 0;
  let members = 0;
  const charge = (amount: number): void => {
    bytes += amount;
    if (bytes > maxBytes) throw new IJsonLimitError('max_bytes', maxBytes);
  };
  const chargeString = (text: string): void => {
    if (text.length + 2 > maxBytes - bytes) throw new IJsonLimitError('max_bytes', maxBytes);
    charge(2);
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code === 34 || code === 92 || [8, 9, 10, 12, 13].includes(code)) charge(2);
      else if (code < 32) charge(6);
      else if (code >= 0xd800 && code <= 0xdbff
        && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) {
        charge(4); index += 1;
      } else if (code >= 0xd800 && code <= 0xdfff) charge(6);
      else charge(code < 128 ? 1 : code < 2048 ? 2 : 3);
    }
  };
  const chargeMembers = (count: number): void => {
    members += count;
    if (members > bounds.maxMembers) throw new IJsonLimitError('max_members', bounds.maxMembers);
    charge(2 + Math.max(0, count - 1));
  };

  const clone = (current: unknown, path: string, depth: number): unknown => {
    if (current === null || typeof current === 'boolean') {
      charge(current === null || current === true ? 4 : 5);
      return current;
    }
    if (typeof current === 'string') { chargeString(current); return current; }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw jsonDataError(path, 'number must be finite');
      if (Number.isInteger(current) && !Number.isSafeInteger(current)) {
        throw jsonDataError(path, 'integer must be within the safe range');
      }
      charge(JSON.stringify(current).length);
      return current;
    }
    if (typeof current !== 'object' || isProxy(current)) throw jsonDataError(path, 'value is not JSON data');
    if (ancestors.has(current)) throw jsonDataError(path, 'cyclic references are not JSON data');
    if (depth >= bounds.maxDepth) throw new IJsonLimitError('max_depth', bounds.maxDepth);

    const isArray = Array.isArray(current);
    const prototype = Object.getPrototypeOf(current) as unknown;
    if (!isArray && prototype !== Object.prototype && prototype !== null) {
      throw jsonDataError(path, 'object must have a plain or null prototype');
    }

    ancestors.add(current);
    try {
      if (isArray) {
        chargeMembers(current.length);
        const keys = Reflect.ownKeys(current);
        if (keys.some((key) => typeof key !== 'string' || (key !== 'length' && !arrayIndex(key)))) {
          throw jsonDataError(path, 'array contains a non-index property');
        }
        const result: unknown[] = [];
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
            throw jsonDataError(`${path}/${index}`, 'array item must be an enumerable data property');
          }
          result.push(clone(descriptor.value, `${path}/${index}`, depth + 1));
        }
        return Object.freeze(result);
      }

      const keys = Reflect.ownKeys(current);
      chargeMembers(keys.length);
      const result: Record<string, unknown> = {};
      for (const key of keys) {
        if (typeof key !== 'string') throw jsonDataError(path, 'object contains a symbol property');
        if (prototypeKeys.has(key)) throw jsonDataError(path, 'object contains a prohibited member name');
        chargeString(key); charge(1);
        const descriptor = Object.getOwnPropertyDescriptor(current, key)!;
        if (!descriptor.enumerable || !('value' in descriptor)) {
          throw jsonDataError(`${path}/${key}`, 'member must be an enumerable data property');
        }
        result[key] = clone(descriptor.value, `${path}/${key}`, depth + 1);
      }
      return Object.freeze(result);
    } finally {
      ancestors.delete(current);
    }
  };

  return clone(value, '', 0) as Readonly<Value>;
}

function boundedLimit(
  name: keyof IJsonParseLimits,
  value: number | undefined,
  fallback: number,
  ceiling: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > ceiling) {
    throw new RangeError(`${name} must be a positive safe integer no greater than ${ceiling}.`);
  }
  return resolved;
}

function resolveByteLimit(value: number | undefined): number {
  return boundedLimit('maxBytes', value, MAX_I_JSON_SOURCE_BYTES, MAX_I_JSON_SOURCE_BYTES);
}

interface JsonBudgetFrame {
  readonly type: 'array' | 'object';
  arrayItemStarted: boolean;
  readonly memberNames?: Set<string>;
}

function assertIJsonBudget(source: string, limits: ResolvedIJsonParseLimits): void {
  const stack: JsonBudgetFrame[] = [];
  let inString = false;
  let escaped = false;
  let stringStart = -1;
  let members = 0;

  const countMember = (): void => {
    members += 1;
    if (members > limits.maxMembers) {
      throw new IJsonLimitError('max_members', limits.maxMembers);
    }
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') {
        inString = false;
        const current = stack.at(-1);
        if (current?.type === 'object' && nextNonWhitespace(source, index + 1) === ':') {
          const name = JSON.parse(source.slice(stringStart, index + 1)) as string;
          // lossless-json assigns members before its reviver, so a scalar __proto__
          // is not an own key and must be rejected from the decoded name here.
          if (prototypeKeys.has(name)) throw prohibitedMemberNameError(name);
          if (current.memberNames!.has(name)) throw duplicateMemberError();
          current.memberNames!.add(name);
        }
      }
      continue;
    }

    const current = stack.at(-1);
    if (character === '"') {
      inString = true;
      stringStart = index;
      if (current?.type === 'array') current.arrayItemStarted = true;
      continue;
    }
    if (character === '{' || character === '[') {
      if (current?.type === 'array') current.arrayItemStarted = true;
      stack.push({
        type: character === '[' ? 'array' : 'object',
        arrayItemStarted: false,
        ...(character === '{' ? { memberNames: new Set<string>() } : {}),
      });
      if (stack.length > limits.maxDepth) {
        throw new IJsonLimitError('max_depth', limits.maxDepth);
      }
      continue;
    }
    if (character === '}' || character === ']') {
      const completed = stack.pop();
      if (character === ']' && completed?.type === 'array' && completed.arrayItemStarted) {
        countMember();
      }
      continue;
    }
    if (character === ':' && current?.type === 'object') {
      countMember();
      continue;
    }
    if (character === ',' && current?.type === 'array') {
      if (current.arrayItemStarted) countMember();
      current.arrayItemStarted = false;
      continue;
    }
    if (current?.type === 'array' && !/\s/u.test(character)) {
      current.arrayItemStarted = true;
    }
  }
}

function nextNonWhitespace(source: string, start: number): string | undefined {
  for (let index = start; index < source.length; index += 1) {
    if (!/\s/u.test(source[index]!)) return source[index];
  }
  return undefined;
}

function prohibitedMemberNameError(name: string): SyntaxError {
  return new SyntaxError(`I-JSON member name is not allowed: ${name}`);
}

function duplicateMemberError(): SyntaxError {
  return new SyntaxError('I-JSON object contains a duplicate member name.');
}

function arrayIndex(key: string): boolean {
  return /^(?:0|[1-9][0-9]*)$/u.test(key) && Number(key) < 4_294_967_295;
}

function jsonDataError(path: string, reason: string): TypeError {
  return new TypeError(`Value at ${path === '' ? '/' : path} is not strict JSON data: ${reason}.`);
}

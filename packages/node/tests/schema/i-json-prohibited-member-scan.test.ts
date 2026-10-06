import { describe, expect, it, vi } from 'vitest';

import {
  ColpClient,
  ColpClientLimitError,
  ColpWireValidationError,
} from '../../src/client/index.js';
import { IJsonLimitError, parseIJson as parseSchemaIJson } from '../../src/schema/index.js';
import { parseIJson as parseServerIJson } from '../../src/server/index.js';
import {
  decodePublicationUtf8Json,
  readPublicationJsonRequest,
} from '../../src/server/publication-http-utf8.js';

const prohibitedKeys = ['__proto__', 'constructor', 'prototype'] as const;
const prohibitedValues = [
  'null',
  'true',
  'false',
  '0',
  '-2',
  '1.5',
  '""',
  '"text"',
  '[]',
  '{}',
  '[1,null]',
  '{"child":1}',
  '{"p19Polluted":true}',
] as const;

function unicodeEscape(name: string, uppercase = false): string {
  return `"${[...name].map((character) => {
    const hex = character.charCodeAt(0).toString(16).padStart(4, '0');
    return `\\u${uppercase ? hex.toUpperCase() : hex}`;
  }).join('')}"`;
}

function keyForms(name: string): readonly string[] {
  const pivot = Math.min(2, name.length - 1);
  const mixed = `"${name.slice(0, pivot)}\\u${name.charCodeAt(pivot).toString(16).padStart(4, '0')}${name.slice(pivot + 1)}"`;
  return [JSON.stringify(name), unicodeEscape(name), unicodeEscape(name, true), mixed];
}

function placements(form: string, value: string): readonly string[] {
  return [
    `{${form}:${value}}`,
    `{"outer":{${form}:${value}}}`,
    `{"list":[{${form}:${value}}]}`,
    `{"list":[[{${form}:${value}}]]}`,
    `{ "wrap" : [ { ${form} : ${value} } ] }`,
  ];
}

function expectRejected(source: string, key: string): void {
  const schemaMessage = `I-JSON member name is not allowed: ${key}`;
  expect(() => parseSchemaIJson(source)).toThrowError(expect.objectContaining({
    name: 'SyntaxError',
    message: schemaMessage,
  }));
  expect(() => decodePublicationUtf8Json(new TextEncoder().encode(source))).toThrowError(
    expect.objectContaining({ name: 'SyntaxError', message: schemaMessage }),
  );
  let serverError: unknown;
  try {
    parseServerIJson(source);
  } catch (error) {
    serverError = error;
  }
  expect(serverError).toEqual(expect.objectContaining({
    name: 'SyntaxError',
    message: 'I-JSON member name is not allowed.',
  }));
  expect((serverError as Error).message).not.toContain(key);
  expect(Object.hasOwn(Object.prototype, 'p19Polluted')).toBe(false);
}

describe('I-JSON prohibited member scan before object construction', () => {
  it.each(prohibitedKeys)('rejects every value, escape, nesting, and duplicate of %s', (key) => {
    for (const form of keyForms(key)) {
      for (const value of prohibitedValues) {
        for (const source of placements(form, value)) expectRejected(source, key);
      }
      expectRejected(`{${form}:1,${form}:2}`, key);
      expectRejected(`{${form}:1,${JSON.stringify(key)}:1}`, key);
      expectRejected(`{${form}:9007199254740992}`, key);
      expectRejected(`{${form}:1e999}`, key);
    }
  });

  it('accepts names and string values that only resemble prohibited keys', () => {
    const source = '{"__proto":1,"__PROTO__":2,"constructorId":3,"prototypeVersion":4,"note":"__proto__","items":["constructor","prototype"]}';
    const expected = {
      __proto: 1,
      __PROTO__: 2,
      constructorId: 3,
      prototypeVersion: 4,
      note: '__proto__',
      items: ['constructor', 'prototype'],
    };
    expect(parseSchemaIJson(source)).toEqual(expected);
    expect(parseServerIJson(source)).toEqual(expected);
    expect(decodePublicationUtf8Json(new TextEncoder().encode(source))).toEqual(expected);
    expect(Object.getPrototypeOf(parseSchemaIJson(source))).toBe(Object.prototype);
    expect(parseSchemaIJson('{"text":"{\\"__proto__\\":null}"}')).toEqual({ text: '{"__proto__":null}' });
  });

  it('still decodes legal escapes, duplicates, numbers, depth, and member budgets', () => {
    const escaped = parseSchemaIJson('{"a\\"\\\\\\/\\b\\f\\n\\r\\t\\u0062":1}') as Record<string, unknown>;
    expect(escaped['a"\\/\b\f\n\r\tb']).toBe(1);
    expect(parseServerIJson('{"\\ud83d\\ude00":1,"nested":{"id":2}}')).toEqual({
      '😀': 1,
      nested: { id: 2 },
    });
    expect(() => parseSchemaIJson('{"id":1,"id":2}')).toThrow(/duplicate member/u);
    expect(() => parseServerIJson('{"secret-token":1,"secret-token":2}')).toThrowError(
      expect.objectContaining({ message: 'I-JSON object contains a duplicate member name.' }),
    );
    expect(parseSchemaIJson('{"n":9007199254740991}')).toEqual({ n: Number.MAX_SAFE_INTEGER });
    expect(() => parseServerIJson('{"n":9007199254740992}')).toThrow(/outside the safe range/u);
    expect(() => parseSchemaIJson('{"n":1e999}')).toThrow(/not finite/u);
    expect(parseSchemaIJson('{"a":{"b":[]}}', { maxDepth: 3 })).toEqual({ a: { b: [] } });
    expect(() => parseServerIJson('{"a":{"b":[]}}', { maxDepth: 2 })).toThrowError(
      expect.objectContaining({ name: 'IJsonLimitError', code: 'max_depth', limit: 2 }),
    );
    expect(parseSchemaIJson('{"a":[1,{"b":2}],"c":[]}', { maxMembers: 5 })).toEqual({
      a: [1, { b: 2 }],
      c: [],
    });
    expect(() => parseServerIJson('{"a":1,"b":2,"c":3}', { maxMembers: 2 })).toThrow(IJsonLimitError);
  });

  it('does not JSON.parse the full source from schema, publication, or server', () => {
    const source = '{"audit":"single-pass","nested":{"ok":true}}';
    const parse = vi.spyOn(JSON, 'parse');
    try {
      expect(parseServerIJson(source)).toEqual(parseSchemaIJson(source));
      expect(decodePublicationUtf8Json(new TextEncoder().encode(source))).toEqual({
        audit: 'single-pass',
        nested: { ok: true },
      });
      for (const call of parse.mock.calls) {
        expect(call[0]).not.toBe(source);
        expect(call[0] as string).toMatch(/^"/u);
        expect(call[1]).toBeUndefined();
      }
    } finally {
      parse.mockRestore();
    }
  });

  it('keeps publication byte and timeout budgets outside the member scan', async () => {
    const prohibited = '{"__proto__":null}';
    const oversized = new Request('https://example.test/', {
      method: 'POST',
      body: prohibited,
      duplex: 'half',
    } as RequestInit);
    await expect(readPublicationJsonRequest(oversized, { maxBytes: 4 })).rejects.toBeInstanceOf(RangeError);
    const stalled = new Request('https://example.test/', {
      method: 'POST',
      body: new ReadableStream(),
      duplex: 'half',
    } as RequestInit);
    await expect(readPublicationJsonRequest(stalled, { timeoutMs: 15 })).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    const accepted = new Request('https://example.test/', {
      method: 'POST',
      body: '{"ok":true}',
      duplex: 'half',
    } as RequestInit);
    await expect(readPublicationJsonRequest(accepted, { maxBytes: 11, timeoutMs: 1000 })).resolves.toEqual({
      ok: true,
    });
  });

  it('rejects prohibited members on the client success body and keeps client budgets', async () => {
    const manifestUrl = 'https://manifest.example/.well-known/collection-protocol';
    const respond = (body: string): typeof globalThis.fetch => (async () => new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json', etag: '"p19"' },
    })) as typeof globalThis.fetch;

    const legal = new ColpClient({ manifestUrl, fetch: respond('{"a":1}') });
    await expect(legal.discover()).rejects.toMatchObject({ stage: 'structural', definition: 'manifest' });

    for (const source of [
      '{"__proto__":null}',
      '{"__proto__":"text"}',
      '{"__proto__":[1]}',
      '{"__proto__":{"p19Polluted":true}}',
      '{"outer":{"\\u005f\\u005fproto\\u005f\\u005f":null}}',
      '{"__proto__":1,"__proto__":2}',
      '{"constructor":true}',
      '{"prototype":{}}',
    ]) {
      const client = new ColpClient({ manifestUrl, fetch: respond(source) });
      try {
        await client.discover();
        expect.unreachable(`client accepted ${source}`);
      } catch (error) {
        expect(error).toBeInstanceOf(ColpWireValidationError);
        expect(error).toMatchObject({ stage: 'parse', definition: 'manifest' });
        expect((error as ColpWireValidationError).message).toContain('I-JSON member name is not allowed:');
      }
    }
    expect(Object.hasOwn(Object.prototype, 'p19Polluted')).toBe(false);

    const limited = new ColpClient({
      manifestUrl,
      fetch: respond('{"a":1}'),
      requestLimits: { maxBytes: 4 },
    });
    await expect(limited.discover()).rejects.toBeInstanceOf(ColpClientLimitError);

    const stalled = vi.fn((_: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal === undefined || signal === null) {
        reject(new Error('client success path did not forward an abort signal'));
        return;
      }
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })) as typeof globalThis.fetch;
    const timed = new ColpClient({
      manifestUrl,
      fetch: stalled,
      requestLimits: { timeoutMs: 20 },
    });
    await expect(timed.discover()).rejects.toBeInstanceOf(ColpClientLimitError);
  });
});

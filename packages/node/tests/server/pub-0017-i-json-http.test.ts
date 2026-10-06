import { describe, expect, it } from 'vitest';
import {
  createPublicationJsonResponse,
  decodePublicationUtf8Json,
  publicationUtf8JsonBytes,
  readPublicationJsonRequest,
} from '../../src/server/publication-http-utf8.js';

const evidence = '[evidence:http.i-json]';

describe(`PUB-0017 Publication I-JSON HTTP boundary ${evidence}`, () => {
  it(`accepts ordinary JSON request bodies ${evidence}`, async () => {
    const request = new Request('https://example.test', { method: 'POST', body: '{"ok":true}' });
    await expect(readPublicationJsonRequest(request)).resolves.toEqual({ ok: true });
  });

  it(`accepts UTF-8 request text and supplementary characters ${evidence}`, async () => {
    const request = new Request('https://example.test', { method: 'POST', body: '{"text":"caf\u00e9 \ud83d\ude00"}' });
    await expect(readPublicationJsonRequest(request)).resolves.toEqual({ text: 'caf\u00e9 \ud83d\ude00' });
  });

  it(`rejects duplicate object members ${evidence}`, async () => {
    for (const source of ['{"a":1,"a":2}', '{"nested":{"x":1,"x":2}}']) {
      await expect(readPublicationJsonRequest(new Request('https://example.test', { method: 'POST', body: source }))).rejects.toThrow(/duplicate/i);
    }
  });

  it(`rejects unsafe binary64 integers ${evidence}`, () => {
    for (const source of ['{"n":9007199254740992}', '{"n":-9007199254740992}', '[9007199254740992]']) {
      expect(() => decodePublicationUtf8Json(new TextEncoder().encode(source))).toThrow(/safe range|outside/i);
    }
  });

  it(`rejects non-finite numeric input ${evidence}`, () => {
    for (const source of ['{"n":1e400}', '{"n":-1e400}', '{"n":1e999}']) {
      expect(() => decodePublicationUtf8Json(new TextEncoder().encode(source))).toThrow(/not finite/i);
    }
  });

  it(`rejects non-UTF-8 request bytes before JSON dispatch ${evidence}`, () => {
    expect(() => decodePublicationUtf8Json(Uint8Array.from([0xff, 0xfe]))).toThrow();
  });

  it(`rejects non-UTF-8 charset declarations ${evidence}`, async () => {
    const request = new Request('https://example.test', {
      method: 'POST',
      body: '{"ok":true}',
      headers: { 'content-type': 'application/json; charset=iso-8859-1' },
    });
    await expect(readPublicationJsonRequest(request)).rejects.toThrow(/UTF-8/i);
  });

  it(`accepts case-insensitive UTF-8 charset declarations ${evidence}`, async () => {
    const request = new Request('https://example.test', {
      method: 'POST',
      body: '{"ok":true}',
      headers: { 'content-type': 'application/json; charset="UTF-8"' },
    });
    await expect(readPublicationJsonRequest(request)).resolves.toEqual({ ok: true });
  });

  it(`serializes ordinary response JSON as bytes ${evidence}`, () => {
    expect(new TextDecoder().decode(publicationUtf8JsonBytes({ ok: true }))).toBe('{"ok":true}');
  });

  it(`serializes response text without lossy numeric coercion ${evidence}`, () => {
    expect(new TextDecoder().decode(publicationUtf8JsonBytes({ text: 'caf\u00e9' }))).toContain('caf\u00e9');
  });

  it(`rejects non-finite response numbers ${evidence}`, () => {
    for (const number of [NaN, Infinity, -Infinity]) expect(() => publicationUtf8JsonBytes({ number })).toThrow(/finite/i);
  });

  it(`rejects unsafe response integers ${evidence}`, () => {
    for (const number of [Number.MAX_SAFE_INTEGER + 1, -(Number.MAX_SAFE_INTEGER + 1)]) expect(() => publicationUtf8JsonBytes({ number })).toThrow(/safe range/i);
  });

  it(`rejects cyclic response data instead of emitting null ${evidence}`, () => {
    const value: { self?: unknown } = {};
    value.self = value;
    expect(() => publicationUtf8JsonBytes(value)).toThrow(/cyclic/i);
  });

  it(`returns byte-accurate response metadata ${evidence}`, async () => {
    const response = createPublicationJsonResponse({ text: 'caf\u00e9 \ud83d\ude00' });
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(response.headers.get('content-length')).toBe(String(bytes.byteLength));
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(decodePublicationUtf8Json(bytes)).toEqual({ text: 'caf\u00e9 \ud83d\ude00' });
  });
});

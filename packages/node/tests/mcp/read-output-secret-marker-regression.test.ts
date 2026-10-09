import { describe, expect, it, vi } from 'vitest';

import { createMcp20260728ReadToolAdapter } from '../../src/mcp/2026-07-28/tools.js';
import { normalizeMcp20260728Error } from '../../src/mcp/2026-07-28/results.js';
import { createMcpStatelessToolCore } from '../../src/mcp/shared/tools.js';
import { containsRawSecretMarker } from '../../src/mcp/shared/authorization.js';
import { containsOutputSecretMarker } from '../../src/mcp/shared/secret-markers.js';
import { authenticatedBinding } from './authenticated-binding-fixture.js';
import { createContext } from './mcp-2026-07-28-write-adapter-fixture.js';

const cursor = Buffer.from(JSON.stringify({ offset: 1 })).toString('base64url');
const context = createContext(authenticatedBinding(), { scope: ['collections:read'] });
const joseHeader = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
const jwt = `${joseHeader}.${cursor}.signature`;

function adapter(result: object) {
  const toolCore = createMcpStatelessToolCore({ tools: [{
    definition: { name: 'bookmarks.list', description: 'List bookmarks',
      inputSchema: { type: 'object', additionalProperties: false } },
    invoke: () => result,
  }] });
  return createMcp20260728ReadToolAdapter({ toolCore, serverInfo: { name: 'regression', version: '1' } });
}

describe('Read Tool output distinguishes data from credential formats', () => {
  it.each([
    'Basic Syntax | Markdown Guide', 'Basic Syntax', 'Bearer of Good News',
    'AKIA guide', 'sk-short-label', cursor, `${cursor}.page.cursor`,
  ])('returns ordinary business text %s unchanged', async (title) => {
    const result = { structuredContent: { bookmarks: [{ title }], nextCursor: cursor },
      content: [{ type: 'text', text: title }] };
    await expect(adapter(result).callTool(context, { name: 'bookmarks.list', arguments: {} }))
      .resolves.toMatchObject(result);
  });

  it.each([
    { nested: { access_token: 'opaque-token' } },
    { password: 'secret' }, { apiKey: 'sk-secret-123' },
    { nested: ['Basic dXNlcjpwYXNz'] }, { value: 'Bearer opaque-token' },
    { value: 'AKIA' + '0123456789ABCDEF' }, { value: 'sk-0123456789abcdef' },
    { value: jwt }, { value: `${joseHeader}.key.iv.ciphertext.tag` },
  ])('still withholds credential fields or complete credential strings %j', async (structuredContent) => {
    const error: unknown = await adapter({ structuredContent })
      .callTool(context, { name: 'bookmarks.list', arguments: {} }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'secret_marker_detected' });
    expect(normalizeMcp20260728Error(error)).toEqual({ code: -32603, message: 'Internal error' });
  });

  it('keeps strict authorization-binding prefix checks and does not invoke hooks', () => {
    expect(containsRawSecretMarker(cursor)).toBe(true);
    expect(containsOutputSecretMarker(cursor)).toBe(false);
    const getter = vi.fn(() => 'Bearer secret');
    const accessor = Object.defineProperty({}, 'authorization', { get: getter });
    expect(containsOutputSecretMarker(accessor)).toBe(false);
    expect(getter).not.toHaveBeenCalled();
    const traps = vi.fn(() => { throw new Error('must not execute Proxy'); });
    expect(containsOutputSecretMarker(new Proxy({}, { ownKeys: traps }))).toBe(false);
    expect(traps).not.toHaveBeenCalled();
    const cyclic: { child?: unknown } = {};
    cyclic.child = cyclic;
    expect(containsOutputSecretMarker(cyclic)).toBe(false);
  });
});

describe('Read Tool output scanner budget', () => {
  it('admits a snapshot-bounded wide result without a credential marker', async () => {
    // 200 records of ordinary text (about 120 KiB, duplicated into the text
    // block): inside the 1 MiB snapshot budget and therefore admitted.
    const bookmarks = Array.from({ length: 200 }, (_, index) => ({
      id: `bookmark-${index}`,
      title: `Reading list entry ${index} `.padEnd(200, 'x'),
      url: `https://example.test/articles/${index}/`.padEnd(200, 'y'),
      note: 'Plain business text without credential syntax. '.repeat(4),
    }));
    const result = { structuredContent: { bookmarks, nextCursor: cursor }, content: [{ type: 'text', text: JSON.stringify(bookmarks) }] };
    await expect(adapter(result).callTool(context, { name: 'bookmarks.list', arguments: {} }))
      .resolves.toMatchObject({ structuredContent: { nextCursor: cursor } });
  });

  it('fails closed once the scan work exceeds the budget', () => {
    const wide: Record<string, string> = {};
    for (let index = 0; index < 150_000; index += 1) wide[`k${index}`] = 'plain text value';
    expect(containsOutputSecretMarker(wide)).toBe(true);
  });
});

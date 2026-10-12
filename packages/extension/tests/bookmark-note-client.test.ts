import { expect, test, vi } from 'vitest';
import { createBookmarkNoteClient } from '../src/bookmark-note-client.js';
import type { NoteIntent } from '../src/bookmark-annotation-sync-types.js';
import { createNoteProductTransport } from '../src/note-product-transport.js';
const note = (overrides: Record<string, unknown> = {}) => ({ id: 'note-a', collectionId: 'c',
  subject: { type: 'node', id: 'n' }, type: 'note', format: 'plain', value: 'Text', visibility: 'private',
  provenance: { kind: 'human' }, revision: 'r1', ...overrides });
const page = (notes: unknown[], nextCursor: string | null = null) => ({ annotations: notes,
  page: { returnedCount: notes.length, hasMore: nextCursor !== null, nextCursor } });
function setup(responses: Response[]) {
  const fetcher = vi.fn(async () => responses.shift()!);
  const client = createBookmarkNoteClient({ serverOrigin: 'https://known.test', accountId: 'a', collectionId: 'c',
    scopeKey: 'scope', assertCurrent: async () => undefined, fetch: fetcher });
  return { client, fetcher };
}
const identity = (account = 'a') => [Response.json({ authenticated: true, csrfToken: 'csrf' }),
  Response.json({ user: { id: account }, session: { id: 'session-a' } })];
const reply = (body: unknown, session = 'session-a', status = 200) => Response.json(body, { status,
  headers: { 'Known-Annotation-Session': session } });

test('account verification happens before private note access; foreign accounts never get a note request', async () => {
  const { client, fetcher } = setup(identity('other'));
  await expect(client.read('n')).rejects.toThrow('reconnect_required');
  expect(fetcher).toHaveBeenCalledTimes(2);
});
test('private note reads are bound to the verified server session before their body is consumed', async () => {
  const { client } = setup([...identity(), reply(page([note()]), 'session-b')]);
  await expect(client.read('n')).rejects.toThrow('reconnect_required');
});
test('pagination must complete before an absent note can authorize creation', async () => {
  const { client } = setup([...identity(), reply(page([], 'next')), reply(page([note()]))]);
  expect(await client.read('n')).toMatchObject({ annotationId: 'note-a', value: 'Text', supported: true });
  const incomplete = setup([...identity(), reply(page([], 'next')), reply(page([], 'next'))]);
  await expect(incomplete.client.read('n')).rejects.toThrow('annotation_response_invalid');
});
test('foreign subjects, ambiguous notes, markdown and oversized notes cannot become writable plain notes', async () => {
  const foreign = setup([...identity(), reply(page([note({ collectionId: 'other' })]))]);
  await expect(foreign.client.read('n')).rejects.toThrow('annotation_response_invalid');
  for (const notes of [[note(), note({ id: 'note-b' })], [note({ format: 'markdown' })], [note({ value: 'x'.repeat(16385) })]]) {
    expect((await setup([...identity(), reply(page(notes))]).client.read('n')).supported).toBe(false);
  }
});
test('conditional updates carry only the original value, command, session and ETag', async () => {
  const intent: NoteIntent = { scopeKey: 'scope', nodeId: 'n', commandId: '12345678-1234-4123-8123-123456789abc',
    version: 2, action: 'update', annotationId: 'note-a', revision: 'original-r1', value: 'New' };
  const { client, fetcher } = setup([...identity(), reply(note({ value: 'New', revision: 'r2' }))]);
  expect(await client.send(intent)).toMatchObject({ revision: 'r2', value: 'New' });
  const request = fetcher.mock.calls[2] as unknown as [string, RequestInit];
  expect(request[1]).toMatchObject({ method: 'PATCH', credentials: 'include', redirect: 'error',
    headers: { 'Known-Annotation-Session': 'session-a', 'Known-Command-Id': intent.commandId,
      'If-Match': '"original-r1"', 'X-CSRF-Token': 'csrf' }, body: '{"value":"New"}' });
  expect((request[1].headers as Record<string, string>).Authorization).toBeUndefined();
});

test('a valid large subject page and complete 256-annotation pagination can expose its private note', async () => {
  const big = Array.from({ length: 15 }, (_, index) => note({ id: `highlight-${index}`, type: 'highlight', value: 'x'.repeat(65536) }));
  expect((await setup([...identity(), reply(page([...big, note()]))]).client.read('n')).annotationId).toBe('note-a');
  const responses = Array.from({ length: 16 }, (_, index) => reply(page(Array.from({ length: 16 }, (_, offset) =>
    index === 15 && offset === 15 ? note() : note({ id: `highlight-${index}-${offset}`, type: 'highlight' })), index < 15 ? `cursor-${index}` : null)));
  expect((await setup([...identity(), ...responses]).client.read('n')).annotationId).toBe('note-a');
});

test('duplicate resource ids across pages fail before an incomplete observation can authorize a mutation', async () => {
  const { client } = setup([...identity(), reply(page([note()], 'next')), reply(page([note()]))]);
  await expect(client.read('n')).rejects.toThrow('annotation_response_invalid');
});

test('a pre-admission CSRF rejection without a session header refreshes identity and replays the exact command', async () => {
  const intent: NoteIntent = { scopeKey: 'scope', nodeId: 'n', commandId: '12345678-1234-4123-8123-123456789abc',
    version: 1, action: 'update', annotationId: 'note-a', revision: 'r1', value: 'New' };
  const { client, fetcher } = setup([...identity(), Response.json({ error: { code: 'csrf_failed' } }, { status: 403 }),
    ...identity(), reply(note({ value: 'New', revision: 'r2' }))]);
  await client.send(intent);
  const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
  expect(calls[2]![1].body).toBe(calls[5]![1].body);
  expect(calls[2]![1].headers).toEqual(calls[5]![1].headers);
  const foreign = setup([...identity(), Response.json({ error: { code: 'csrf_failed' } }, { status: 403 }), ...identity('other')]);
  await expect(foreign.client.send(intent)).rejects.toThrow('reconnect_required');
  expect(foreign.fetcher).toHaveBeenCalledTimes(5);
});

test('clients in one scan share authentication while retaining per-node guards and session-bound responses', async () => {
  const responses = [...identity(), reply(page([])), reply(page([]))];
  const fetcher = vi.fn(async () => responses.shift()!);
  const options = { serverOrigin: 'https://known.test', accountId: 'a', collectionId: 'c', assertCurrent: async () => undefined, fetch: fetcher };
  const transport = createNoteProductTransport(options);
  await createBookmarkNoteClient({ ...options, transport, scopeKey: 'scope', nodeId: 'first' }).read('first');
  await createBookmarkNoteClient({ ...options, transport, scopeKey: 'scope', nodeId: 'second' }).read('second');
  expect(fetcher).toHaveBeenCalledTimes(4);
  const client = createBookmarkNoteClient({ ...options, transport, scopeKey: 'scope', nodeId: 'first' });
  await expect(client.read('second')).rejects.toThrow('annotation_target_changed');
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(() => createBookmarkNoteClient({ ...options, transport, scopeKey: 'scope', accountId: 'other-account' }))
    .toThrow('annotation_scope_changed');
});

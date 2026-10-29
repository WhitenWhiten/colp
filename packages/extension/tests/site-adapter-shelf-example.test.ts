// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest';
import { qualifySiteAdapter } from './fixtures/site-adapters/qualification.js';
import { createPageContext } from '../src/site-adapters/page-context.js';
import { readLimits } from '../src/site-adapters/read-policy.js';
import { shelfDefinition, SAVED, article } from './fixtures/site-adapters/shelf/definition.js';
import { createShelfAdapter } from './fixtures/site-adapters/shelf/adapter.js';
const item = article('alpha', 'Alpha')!;
const services = { readPolicy: readLimits({ readPolicy: { spacingMs: 1, requestSpacingMs: 1 } }) };
const signIn = () => { document.head.innerHTML = '<meta name="shelf:user" content="42">'; };
afterEach(() => { vi.unstubAllGlobals(); document.head.replaceChildren(); document.body.replaceChildren(); });
qualifySiteAdapter({ definition: shelfDefinition, accountId: '42', item, collection: SAVED, setup() {
  signIn(); vi.stubGlobal('fetch', async () => Response.json({ items: [{ slug: 'alpha', title: 'Alpha' }], next: null }));
  return createShelfAdapter(services);
} });
test('a Save click is reported only after the page shows it saved', async () => {
  signIn(); document.body.innerHTML = '<article data-shelf-id="alpha"><h1>Alpha</h1><button data-shelf-save aria-pressed="false">Save</button></article>';
  const emitted: unknown[] = [], controller = new AbortController();
  const context = createPageContext({ document, signal: controller.signal, accountId: '42', routeEpoch: 0, deadlineAt: Date.now() + 10000, routeEvent: 'shelf-route', controls: false,
    emit: async data => { emitted.push(data); return { status: 'accepted', receiptId: String(emitted.length) }; },
    hint: async () => { throw Error('unexpectedHint'); }, requestCapture: async () => { throw Error('unexpectedCapture'); } });
  const cleanup = await createShelfAdapter(services).start(context);
  const button = document.querySelector('button')!;
  button.click(); expect(emitted).toEqual([]);
  button.setAttribute('aria-pressed', 'true');
  await vi.waitFor(() => expect(emitted).toHaveLength(1));
  expect(emitted).toEqual([expect.objectContaining({ type: 'favorite.confirmed', item, memberships: { mode: 'delta', added: [SAVED.id], removed: [] } })]);
  controller.abort(); await cleanup?.();
});
test('an expired session fails visibly instead of reading as an empty list', async () => {
  vi.stubGlobal('fetch', async () => new Response('', { status: 401 }));
  const context = { accountId: '42', document, signal: new AbortController().signal, deadlineAt: Date.now() + 5000, readSessionId: 'session' };
  await expect(createShelfAdapter(services).readItemsPage!(context, SAVED.id, null)).rejects.toMatchObject({ failure: { code: 'signedOut' } });
});

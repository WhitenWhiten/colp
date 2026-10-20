// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest';
import { bindReplicaRebuildButton } from '../src/replica-rebuild-ui.js';
import { REPLICA_REBUILD_JOURNAL, validReplicaRebuildRequest,
  type ReplicaRebuildRequest } from '../src/replica-rebuild.js';
import { setupRetirement } from './replica-retirement-harness.js';

const fixtures: Awaited<ReturnType<typeof setupRetirement>>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

async function setup(page: 'popup' | 'options' = 'popup') {
  const f = await setupRetirement(); fixtures.push(f);
  const sent: ReplicaRebuildRequest[] = [], opened: string[] = [];
  const navigation = { pathname: `/${page}.html`, href: `chrome-extension://test/${page}.html`, reload: vi.fn() };
  vi.stubGlobal('location', navigation);
  vi.stubGlobal('chrome', { runtime: {
    getURL: (path: string) => `chrome-extension://test/${path}`,
    sendMessage: async (message: unknown) => {
      if (!validReplicaRebuildRequest(message)) throw new Error('invalid_runtime_request');
      sent.push(message); return f.rebuilder.handle(message);
    },
  }, tabs: { create: async ({ url }: { url: string }) => { opened.push(url); } } });
  document.body.innerHTML = '<button id="audit-rebuild"></button><p id="audit-feedback" hidden></p>';
  bindReplicaRebuildButton('audit');
  return { ...f, sent, opened, navigation,
    button: document.getElementById('audit-rebuild') as HTMLButtonElement,
    feedback: document.getElementById('audit-feedback')! };
}
async function review(f: Awaited<ReturnType<typeof setup>>) {
  f.button.click();
  await vi.waitFor(() => expect(document.querySelector('.rebuild-confirm-copy')).not.toBeNull());
  return document.querySelector('.rebuild-confirm') as HTMLElement;
}
function confirm() {
  const button = Array.from(document.querySelectorAll('button')).find(node => node.textContent === 'Reset sync');
  expect(button).toBeDefined(); button!.click();
}

test.each(['popup', 'options'] as const)('the %s Reset dialog waits for real server retirement before publishing the new setup scope', async page => {
  const f = await setup(page);
  const originalMapping = await f.store.getMappingByColpId(f.scope, 'bookmark');
  let complete!: () => void;
  const server = new Promise<void>(resolve => { complete = resolve; });
  f.setResponse(async init => {
    expect(init.method).toBe('DELETE'); expect(init.body).toBeUndefined();
    expect(new Headers(init.headers).get('Known-Sync-Replica-Proof')).toBe(f.session.sessionId);
    await server; return new Response(null, { status: 204 });
  });
  await review(f); confirm();
  try {
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    expect(f.button.disabled).toBe(true); expect(f.feedback.hidden).toBe(true);
    expect(f.opened).toEqual([]); expect(f.navigation.reload).not.toHaveBeenCalled();
    expect(await f.credentials.loadBinding()).toEqual(f.binding);
    expect(await f.store.listQueue(f.scope)).toEqual(f.original);
    await expect(f.store.exportArchive(f.scope)).rejects.toThrow('archive_not_found');
  } finally {
    complete();
    await vi.waitFor(() => expect(f.button.disabled).toBe(false));
  }
  expect(f.feedback.hidden).toBe(false); expect(f.feedback.textContent).toContain('was reset and your bookmarks were kept');
  const archived = await f.store.exportArchive(f.scope);
  expect(archived.queue).toEqual(f.original); expect(archived.receipts).toEqual([]);
  expect(archived.mappings).toEqual([originalMapping]);
  expect(await f.store.getScope(f.scope)).toBeNull();
  const next = await f.currentScope();
  expect(next.replicaId).not.toBe(f.scope.replicaId); expect(next.browserProfileId).toBe(f.scope.browserProfileId);
  expect(await f.store.getScope(next)).toMatchObject({ firstRun: 'none', selectedRoots: [] });
  expect(await f.store.listQueue(next)).toEqual([]); expect(f.pushCalls).toBe(1);
  expect((await f.journal.get(REPLICA_REBUILD_JOURNAL))[REPLICA_REBUILD_JOURNAL]).toBeUndefined();
  expect(f.sent.map(message => message.kind)).toEqual(['known.scope.rebuild.preview', 'known.scope.rebuild.confirm']);
  if (page === 'popup') {
    expect(f.opened).toEqual(['chrome-extension://test/options.html#sync']);
    expect(f.navigation.reload).not.toHaveBeenCalled();
  } else {
    expect(f.opened).toEqual([]); expect(f.navigation.href).toBe('chrome-extension://test/options.html#sync');
    expect(f.navigation.reload).toHaveBeenCalledTimes(1);
  }
});

test.each(['Escape', 'Cancel'])('%s and repeated clicks never authorize retirement and restore keyboard focus', async action => {
  const f = await setup(); const strip = await review(f);
  const retainedConfirm = strip.querySelector('button')!;
  f.button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  expect(f.sent).toHaveLength(1);
  strip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  expect(document.querySelector('.rebuild-confirm')).toBe(strip);
  if (action === 'Escape') strip.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  else strip.querySelectorAll('button')[1]!.click();
  retainedConfirm.click();
  await vi.waitFor(() => expect(f.button.disabled).toBe(false));
  expect(document.activeElement).toBe(f.button); expect(document.querySelector('.rebuild-confirm')).toBeNull();
  expect(f.requests).toEqual([]); expect(f.sent).toHaveLength(1); expect(f.feedback.hidden).toBe(true);
  expect(await f.credentials.loadBinding()).toEqual(f.binding); expect(await f.store.listQueue(f.scope)).toEqual(f.original);
  await expect(f.store.exportArchive(f.scope)).rejects.toThrow('archive_not_found');
});

test.each(['other-control', 'replaced-view'] as const)('a canceled confirmation cannot reclaim focus from a %s', async change => {
  const f = await setup(); const strip = await review(f);
  const focus = vi.spyOn(f.button, 'focus');
  strip.addEventListener('keydown', () => {
    if (change === 'other-control') {
      const input = document.createElement('input'); input.id = 'other-control';
      document.body.append(input); input.focus();
    } else document.body.innerHTML = '<button id="audit-rebuild">Another view</button><p id="audit-feedback"></p>';
  });
  strip.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await vi.waitFor(() => expect(f.button.disabled).toBe(false));
  expect(focus).not.toHaveBeenCalled();
  if (change === 'other-control') expect(document.activeElement?.id).toBe('other-control');
  else expect(document.activeElement).toBe(document.body);
  expect(f.requests).toEqual([]); expect(f.sent).toHaveLength(1); expect(f.opened).toEqual([]);
  expect(await f.credentials.loadBinding()).toEqual(f.binding); expect(await f.store.listQueue(f.scope)).toEqual(f.original);
  await expect(f.store.exportArchive(f.scope)).rejects.toThrow('archive_not_found');
});

test('an engine revision change after review rejects the retained confirmation without rotating authority', async () => {
  const f = await setup(); await review(f);
  const state = (await f.store.getEngineState(f.scope))!;
  await f.store.transitionEngine(f.scope, { ...state, expectedRevision: state.revision,
    updatedAt: state.updatedAt + 1, notBefore: state.notBefore + 1 });
  confirm(); await vi.waitFor(() => expect(f.button.disabled).toBe(false));
  expect(f.feedback.textContent).toContain('Refresh Status');
  expect(f.feedback.textContent).toContain('stale_ref');
  expect(f.feedback.textContent).not.toContain('was reset');
  expect(f.requests).toEqual([]); expect(f.opened).toEqual([]);
  expect(await f.credentials.loadBinding()).toEqual(f.binding); expect(await f.store.listQueue(f.scope)).toEqual(f.original);
  await expect(f.store.exportArchive(f.scope)).rejects.toThrow('archive_not_found');
});

test('a missing current account fails preview and cannot expose a confirmation or success state', async () => {
  const f = await setup(); await f.credentials.clearCredential(); f.setRestore(null);
  f.button.click(); await vi.waitFor(() => expect(f.button.disabled).toBe(false));
  expect(f.sent.map(message => message.kind)).toEqual(['known.scope.rebuild.preview']);
  expect(document.querySelector('.rebuild-confirm')).toBeNull();
  expect(f.feedback.textContent).toContain("Reset isn't finished yet");
  expect(f.requests).toEqual([]); expect(f.opened).toEqual([]);
  expect(await f.store.listQueue(f.scope)).toEqual(f.original);
});

// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { bindRejoinDecisions } from '../src/rejoin-decisions-ui.js';
import type { PublicRejoinDecision, RejoinDecisionRequest } from '../src/scope-rejoin-decisions.js';

const decision: PublicRejoinDecision = { commandId: 'rejoin-delete:folder', token: `sha256:${'1'.repeat(64)}`,
  title: 'Cloud folder', kind: 'local_delete', state: 'pending', affectedCount: 3 };
let send: ReturnType<typeof vi.fn>;
beforeEach(() => {
  document.body.innerHTML = '<section id="rejoin-decisions"></section>';
  send = vi.fn(async () => ({ ok: true, decisions: [decision] }));
  vi.stubGlobal('chrome', { runtime: { sendMessage: send } });
});
afterEach(() => { window.dispatchEvent(new Event('pagehide')); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
function bind() {
  const host = { panel: document.getElementById('rejoin-decisions')!, show: vi.fn(), onResolved: vi.fn() };
  const ui = bindRejoinDecisions(host); ui.setLibraryId('library-a'); ui.onConnection(true);
  return { ui, ...host };
}
function button(action = 'keep_remote') { return document.querySelector<HTMLButtonElement>(`[data-rejoin-action="${action}"]`)!; }

test('renders the actual cloud count and sends only the current explicit token and choice', async () => {
  const f = bind(); await vi.waitFor(() => expect(button()).not.toBeNull());
  expect(f.panel.textContent).toContain('current cloud copy contains 3 items');
  send.mockResolvedValueOnce({ ok: true, decisions: [] }); button().click();
  await vi.waitFor(() => expect(f.onResolved).toHaveBeenCalledTimes(1));
  expect(send.mock.calls.at(-1)?.[0]).toEqual({ kind: 'known.sync.rejoinDecisions.resolve', commandId: decision.commandId,
    token: decision.token, choice: 'keep_remote', userGesture: true });
  expect(f.panel.textContent).toContain('Your choice is saved.');
});

test('a stale choice refreshes the token and requires another click; it never retries automatically', async () => {
  const f = bind(); await vi.waitFor(() => expect(button()).not.toBeNull());
  const fresh = { ...decision, token: `sha256:${'2'.repeat(64)}`, affectedCount: 4 };
  send.mockImplementation(async (message: RejoinDecisionRequest) => message.kind.endsWith('.resolve')
    ? { ok: false, error: 'preview_stale' } : { ok: true, decisions: [fresh] });
  button().click();
  await vi.waitFor(() => expect(f.panel.textContent).toContain('current cloud copy contains 4 items'));
  expect(f.panel.textContent).toContain('Review the latest items and choose again');
  expect(send.mock.calls.filter(([message]) => message.kind.endsWith('.resolve'))).toHaveLength(1);
  send.mockResolvedValueOnce({ ok: true, decisions: [] }); button().click();
  await vi.waitFor(() => expect(f.onResolved).toHaveBeenCalled());
  expect(send.mock.calls.at(-1)?.[0].token).toBe(fresh.token);
});

test('A to B to A and pagehide ignore earlier reads and decisions, including late successes', async () => {
  let finish!: (value: unknown) => void;
  send.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const f = bind(); await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  f.ui.setLibraryId('library-b'); f.ui.setLibraryId('library-a');
  await vi.waitFor(() => expect(button()).not.toBeNull());
  finish({ ok: true, decisions: [{ ...decision, title: 'Old library response' }] });
  await Promise.resolve(); await Promise.resolve();
  expect(f.panel.textContent).not.toContain('Old library response');
  let saved!: (value: unknown) => void;
  send.mockImplementationOnce(() => new Promise(resolve => { saved = resolve; })); button().click();
  await vi.waitFor(() => expect(saved).toBeTypeOf('function'));
  window.dispatchEvent(new Event('pagehide')); const afterHide = f.panel.innerHTML;
  saved({ ok: true, decisions: [] }); await Promise.resolve(); await Promise.resolve();
  expect(f.panel.innerHTML).toBe(afterHide); expect(f.onResolved).not.toHaveBeenCalled();
});

test.each([null, { ok: true, decisions: [null] }, { ok: true, decisions: [{ ...decision, localOrder: [4] }] }])(
  'malformed worker replies never create an actionable choice: %j', async value => {
    send.mockResolvedValue(value); const f = bind();
    await vi.waitFor(() => expect(f.panel.textContent).toContain('could not be confirmed'));
    expect(button()).toBeNull();
  });

test('a failed refresh removes earlier actionable tokens until a fresh valid read arrives', async () => {
  const f = bind(); await vi.waitFor(() => expect(button()).not.toBeNull());
  const old = button(); send.mockResolvedValueOnce({ ok: true, decisions: [null] });
  await f.ui.refresh(); expect(button()).toBeNull(); old.click();
  expect(send.mock.calls.some(([message]) => message.kind.endsWith('.resolve'))).toBe(false);
  await f.ui.refresh(); expect(button()).not.toBeNull();
});

test('order previews expose both sequences, and an accepted choice has no duplicate action buttons', async () => {
  send.mockResolvedValue({ ok: true, decisions: [{ ...decision, commandId: 'rejoin-order:folder', kind: 'order',
    localOrder: ['Browser first', 'Browser second'], remoteOrder: ['Browser second', 'Browser first'] }] });
  const f = bind(); await vi.waitFor(() => expect(button('keep_local_order')).not.toBeNull());
  expect(Array.from(f.panel.querySelectorAll('ol')).map(list => Array.from(list.children).map(row => row.textContent)))
    .toEqual([['Browser first', 'Browser second'], ['Browser second', 'Browser first']]);
  send.mockResolvedValue({ ok: true, decisions: [{ ...decision, state: 'applying' }] });
  await f.ui.refresh(); expect(button()).toBeNull(); expect(f.panel.textContent).toContain('Finishing your saved choice');
  window.dispatchEvent(new Event('known.sync.rejoinDecisions.show'));
  await vi.waitFor(() => expect(f.show).toHaveBeenCalledTimes(1));
});

test('a lost reply checks durable state and keeps the saved applying choice non-actionable', async () => {
  const f = bind(); await vi.waitFor(() => expect(button()).not.toBeNull());
  vi.useFakeTimers();
  send.mockImplementationOnce(() => new Promise(() => {})); button().click();
  send.mockResolvedValue({ ok: true, decisions: [{ ...decision, state: 'applying' }] });
  await vi.advanceTimersByTimeAsync(10_001);
  expect(button()).toBeNull(); expect(f.panel.textContent).toContain('Finishing your saved choice');
  expect(send.mock.calls.filter(([message]) => message.kind.endsWith('.resolve'))).toHaveLength(1);
  window.dispatchEvent(new Event('pagehide')); expect(vi.getTimerCount()).toBe(0);
});

// @vitest-environment happy-dom
import { expect, test, vi } from 'vitest';
import { createPageContext } from '../src/site-adapters/page-context.js';

function context() {
  const controller = new AbortController();
  const emit = vi.fn(async () => ({ status: 'accepted' as const, receiptId: 'receipt' }));
  return { controller, context: createPageContext({ document, signal: controller.signal, accountId: '42', routeEpoch: 1, deadlineAt: Date.now() + 30000,
    routeEvent: 'test-route', controls: false, emit, hint: emit, requestCapture: emit }) };
}
test('SDK delegates events to descendants and disposes observers/listeners on lease cancellation', async () => {
  const f = context(), root = document.createElement('div'); root.innerHTML = '<button><span>Save</span></button>'; document.body.append(root);
  const click = vi.fn(), observed = vi.fn();
  f.context.dom.on(root, 'click', 'button', click); f.context.dom.observe(root, { childList: true }, observed);
  root.querySelector('span')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); expect(click).toHaveBeenCalledOnce();
  f.controller.abort(); root.append(document.createElement('div'));
  root.querySelector('span')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(click).toHaveBeenCalledOnce(); expect(observed).not.toHaveBeenCalled(); root.remove();
});
test('SDK bounds condition waits and rejects cancellation without retaining callbacks', async () => {
  const f = context();
  const waiting = f.context.dom.waitFor(() => null, { timeoutMs: 30000, signal: new AbortController().signal });
  const rejected = expect(waiting).rejects.toThrow('cancelled'); f.controller.abort(); await rejected;
  const next = context(); await expect(next.context.dom.waitFor(() => null, { timeoutMs: 1, signal: next.controller.signal })).rejects.toThrow('timeout'); next.controller.abort();
});
test('ungranted controls fail closed and route listeners do not survive their lease', () => {
  const f = context(), route = vi.fn(); f.context.onRouteChange(route);
  window.dispatchEvent(new Event('test-route')); expect(route).toHaveBeenCalledOnce(); f.controller.abort();
  window.dispatchEvent(new Event('test-route')); expect(route).toHaveBeenCalledOnce();
  expect(() => f.context.ui.mountControl({ id: 'capture', anchor: document.body, position: 'beforeend', action: 'save', resolveItem: async () => null, purpose: 'semantic' })).toThrow('unsupported');
});

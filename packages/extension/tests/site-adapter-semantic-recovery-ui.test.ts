// @vitest-environment happy-dom
import { expect, test, vi } from 'vitest';
import { paintSemanticRecovery, type SemanticStatus } from '../src/site-adapters/settings-semantic.js';

test('semantic recovery loads later actionable jobs, keeps history separate and locates a specific task', async () => {
  const root = document.createElement('div'); document.body.append(root);
  const job = (id: string) => ({ id, title: id, state: 'attention', reason: 'providerFailed', takeover: false });
  const summary: SemanticStatus = { attention: 21, pending: 0, completed: 0, suppressed: 20, jobs: [job('first')], nextCursor: 'next' };
  const send = vi.fn(async (m: Record<string, unknown>) => m.kind === 'known.siteAdapters.semantic.get' ? { ok: true, job: job('located') }
    : { ok: true, jobs: [m.group === 'history' ? { ...job('history'), state: 'suppressed' } : job('older-failure')], nextCursor: null });
  const act = vi.fn(async () => undefined);
  const paint = (next = summary) => paintSemanticRecovery(root, next, send, act, code => code);
  paint();
  const button = (title: string) => Array.from(root.querySelectorAll('button')).find(b => b.textContent === title)!;
  button('Load more tasks').click();
  await vi.waitFor(() => expect(root.textContent).toContain('older-failure'));
  const input = root.querySelector('input')!;
  input.value = 'typing task ID'; input.focus();
  paint({ ...summary, pending: 1 });
  expect(root.querySelector('[data-job-id="older-failure"]')).not.toBeNull();
  expect(root.querySelector('input')).toBe(input); expect(document.activeElement).toBe(input);
  expect(input.value).toBe('typing task ID');
  expect(send).toHaveBeenCalledWith({ kind: 'known.siteAdapters.semantic.list', group: 'recovery', cursor: 'next' });
  root.querySelector<HTMLButtonElement>('[data-job-id="older-failure"] button')!.click();
  expect(act).toHaveBeenCalledWith({ kind: 'known.siteAdapters.semantic.retry', jobId: 'older-failure' });
  button('View task history').click();
  await vi.waitFor(() => expect(root.textContent).toContain('history'));
  paint(); expect(root.querySelector('[data-job-id="history"]')).not.toBeNull();
  expect(root.querySelector('[data-job-id="first"]')).toBeNull();
  expect(root.querySelector('[data-job-id="history"] button')).toBeNull();
  root.querySelector('input')!.value = 'located'; button('Find task').click();
  await vi.waitFor(() => expect(root.textContent).toContain('located'));
  paint(); expect(root.querySelector('[data-job-id="located"]')).not.toBeNull();
  expect(send).toHaveBeenCalledWith({ kind: 'known.siteAdapters.semantic.get', jobId: 'located' });
  root.remove();
});

test('polling during a page read preserves its result; switching connections fences a late response', async () => {
  const root = document.createElement('div'); document.body.append(root);
  const job = (id: string) => ({ id, title: id, state: 'attention', reason: 'providerFailed', takeover: false });
  const summary: SemanticStatus = { connectionId: 'one', attention: 21, pending: 1, completed: 0, suppressed: 0, jobs: [job('first')], nextCursor: 'next' };
  let release!: (value: unknown) => void;
  const send = vi.fn(() => new Promise(resolve => { release = resolve; }));
  const paint = (next = summary) => paintSemanticRecovery(root, next, send, async () => undefined, code => code);
  const more = () => Array.from(root.querySelectorAll('button')).find(b => b.textContent === 'Load more tasks')!;
  paint(); more().click(); paint(); release({ ok: true, jobs: [job('second')], nextCursor: 'third' });
  await vi.waitFor(() => expect(root.textContent).toContain('second'));
  more().click(); paint({ ...summary, connectionId: 'two', jobs: [job('other-account')], nextCursor: null });
  release({ ok: true, jobs: [job('private-old-task')], nextCursor: null });
  await Promise.resolve(); await Promise.resolve();
  expect(root.textContent).toContain('other-account'); expect(root.textContent).not.toContain('private-old-task');
  expect(root.textContent).not.toContain('second'); root.remove();
});

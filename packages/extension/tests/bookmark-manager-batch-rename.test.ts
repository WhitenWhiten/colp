// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest';
import { bindBookmarkManagerBatch } from '../src/bookmark-manager-batch-ui.js';
import type { BatchRequest, BatchResponse } from '../src/types.js';

afterEach(() => { window.dispatchEvent(new Event('pagehide')); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

function fixture(changed = false, undoExpiresAt?: number) {
  document.body.innerHTML = '<button id="manager-batch-rename"></button><button id="manager-batch-undo" hidden></button>'
    + '<span id="manager-batch-undo-deadline" hidden></span>';
  const messages: BatchRequest[] = [], feedback = vi.fn();
  vi.stubGlobal('chrome', { runtime: { async sendMessage(message: BatchRequest): Promise<BatchResponse> {
    messages.push(structuredClone(message));
    if (message.kind === 'known.batch.preview') return { ok: true, preview: { operation: 'rename', digest: message.titles?.one === 'After' ? 'edited' : 'initial',
      basisDigest: changed && message.titles?.one === 'After' ? 'concurrent-change' : 'unchanged-tree', crossBoundary: false, requiresSecondConfirm: false,
      items: [{ nativeId: 'one', title: 'Before', nodeKind: 'bookmark', state: 'ready' }] } };
    if (message.kind === 'known.batch.confirm') return { ok: true, status: { planId: message.commandId, commandId: message.commandId,
      operation: 'rename', state: 'completed', reused: false, applied: 1, failed: 0, changed: 0, undone: 0, items: [], undoExpiresAt } };
    return { ok: false, error: 'batch_plan_not_found' };
  } } });
  const ui = bindBookmarkManagerBatch({ selectedIds: () => new Set(['one']), select() {}, rootId: () => 'root',
    nodes: () => new Map([['one', { id: 'one', title: 'Before', url: 'https://one.test/' }]]), async refresh() {}, feedback });
  return { ui, messages, feedback };
}

test('the edited title is confirmed using a fresh digest for the same original tree', async () => {
  const f = fixture(); await f.ui.beginWithIds('rename', ['one']);
  const field = document.querySelector<HTMLInputElement>('#manager-batch-body input')!;
  field.value = 'After'; field.dispatchEvent(new Event('input'));
  document.getElementById('manager-batch-confirm')!.click();
  await vi.waitFor(() => expect(f.feedback).toHaveBeenCalledWith('Renamed.', 'ok'));
  expect(f.messages.filter(message => message.kind === 'known.batch.confirm')).toEqual([
    expect.objectContaining({ previewDigest: 'edited', titles: { one: 'After' } }),
  ]);
});

test('Undo shows its actual remaining window and becomes unavailable at the receipt deadline', async () => {
  vi.useFakeTimers(); vi.setSystemTime(100_000);
  const f = fixture(false, Date.now() + 300_000);
  await f.ui.beginWithIds('rename', ['one']); document.getElementById('manager-batch-confirm')!.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(document.getElementById('manager-batch-undo')!.hidden).toBe(false);
  expect(document.getElementById('manager-batch-undo-deadline')!.textContent).toBe('Undo available for 5:00');
  await vi.advanceTimersByTimeAsync(299_000);
  expect(document.getElementById('manager-batch-undo-deadline')!.textContent).toBe('Undo available for 0:01');
  await vi.advanceTimersByTimeAsync(1000);
  expect(document.getElementById('manager-batch-undo')!.hidden).toBe(true);
  expect(document.getElementById('manager-batch-undo-deadline')!.textContent).toBe('The undo window has ended.');
});

test('a concurrent tree or mapping change during editing still prevents confirmation', async () => {
  const f = fixture(true); await f.ui.beginWithIds('rename', ['one']);
  const field = document.querySelector<HTMLInputElement>('#manager-batch-body input')!;
  field.value = 'After'; field.dispatchEvent(new Event('input'));
  document.getElementById('manager-batch-confirm')!.click();
  await vi.waitFor(() => expect(f.feedback).toHaveBeenCalledWith('The tree changed. Preview again.', 'error'));
  expect(f.messages.some(message => message.kind === 'known.batch.confirm')).toBe(false);
});

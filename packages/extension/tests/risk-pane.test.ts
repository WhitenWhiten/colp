// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RiskListView, RiskStateView } from '../src/risk/risk-messages.js';
import { createRiskPane } from '../src/risk/risk-pane.js';

/** Doc 17 §9, RS-16.1, RS-17.2, RS-17.3, R11, R14: Options › Automations › Risk alerts asks the worker for everything and changes it only by command. */
const NOW = Date.parse('2026-10-19T08:00:00.000Z'), DAY = 86_400_000;
const list = (id: string, over: Partial<RiskListView> = {}): RiskListView => ({ id, url: `https://lists.example.org/${id}.json`, origin: 'https://lists.example.org',
  name: `List ${id}`, publisher: { name: 'Example', url: 'https://example.org', feedbackUrl: 'https://example.org/report' }, state: 'ready', refreshIntervalHours: 6,
  paused: false, currentVersion: '7', lastAttemptAt: NOW - DAY, lastSuccessAt: NOW - DAY, lastFailure: null, freshness: 'fresh', entries: 1_204, ...over });
const standard = (): RiskStateView => ({ mode: 'onSave', lists: [list('a'), list('b', { freshness: 'stale', lastSuccessAt: NOW - 9 * DAY }),
  list('c', { freshness: 'outOfDate', lastSuccessAt: NOW - 40 * DAY }),
  list('d', { state: 'notReady', currentVersion: null, freshness: null, entries: null, lastSuccessAt: null, lastFailure: { code: 'http', status: 503, at: NOW - 60_000 } })],
exceptions: [{ id: 'x1', scope: 'host', value: 'login.example-bank.com', duration: 'always', createdAt: NOW },
  { id: 'x2', scope: 'domain', value: 'example-support.com', duration: 'session', createdAt: NOW }] });

let sent: Record<string, unknown>[] = [], state: RiskStateView, request: ReturnType<typeof vi.fn>, granted = true;
let answer: (message: Record<string, unknown>) => unknown = () => ({ ok: true });
const text = (node: Element | null) => (node?.textContent ?? '').replace(/\s+/gu, ' ').trim();
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function render(hash = ''): Promise<HTMLElement> {
  document.body.innerHTML = '';
  location.hash = hash;
  const pane = createRiskPane();
  document.body.append(pane.element);
  pane.activate();
  await vi.waitFor(() => expect(pane.element.querySelector('.risk-mode')).not.toBeNull());
  return pane.element;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
  sent = []; state = standard(); granted = true; answer = () => ({ ok: true });
  request = vi.fn(async () => granted);
  vi.stubGlobal('chrome', {
    runtime: { sendMessage: vi.fn(async (message: Record<string, unknown>) => {
      if (message.kind === 'known.risk.state') return { ok: true, state };
      sent.push(message); return answer(message);
    }) },
    storage: { onChanged: { addListener: vi.fn() } },
    permissions: { request },
  });
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) { this.open = true; };
  HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) { this.open = false; this.dispatchEvent(new Event('close')); };
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); document.body.innerHTML = ''; });

describe('Risk alerts in Options', () => {
  it('says absence from a list means nothing, and never calls a page safe (RS-17.2)', async () => {
    const pane = await render();
    expect(text(pane.querySelector('h2'))).toBe('Risk alerts');
    expect(text(pane)).toContain('Absence from a list means nothing either way');
    expect(text(pane)).not.toMatch(/\bsafe\b/iu);
    expect(pane.querySelector<HTMLInputElement>('.risk-mode input[value="onSave"]')!.checked).toBe(true);
  });

  it('shows each list with its version, entries and how fresh it is, a failure in words (R11)', async () => {
    const pane = await render();
    const meta = (id: string) => pane.querySelector(`[data-risk-list="${id}"] .list-row-meta`)!;
    expect(text(meta('a'))).toMatch(/^Example · 1,204 entries · version 7 · checked /u);
    expect(meta('a').getAttribute('data-tone')).toBeNull();
    expect(text(meta('b'))).toContain('stale: last updated');
    expect(meta('b').getAttribute('data-tone')).toBe('warning');
    expect(text(meta('c'))).toContain('out of date: last updated');
    expect(text(meta('c'))).toContain('its alerts say “unknown”');
    expect(text(meta('d'))).toContain('Not ready: Couldn’t fetch it from lists.example.org (HTTP 503)');
    // The publisher's feedback address is a plain link, opened only when clicked (RS-15.4).
    expect(pane.querySelector<HTMLAnchorElement>('[data-risk-list="a"] a')!.href).toBe('https://example.org/report');
    expect(sent).toEqual([]);
  });

  it('switches the mode by command, and lists the exceptions with their reach and how long they last (RS-17.3)', async () => {
    const pane = await render();
    const off = pane.querySelector<HTMLInputElement>('.risk-mode input[value="off"]')!;
    off.checked = true; off.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(sent).toEqual([{ kind: 'known.risk.mode', mode: 'off' }]));
    const rows = Array.from(pane.querySelectorAll('.risk-exceptions .list-row-main')).map((row) => Array.from(row.children).map(text).join(' | '));
    expect(rows).toEqual(['login.example-bank.com | This host only · always', 'example-support.com | The domain and every host under it · until the browser closes']);
    pane.querySelector<HTMLButtonElement>('.risk-exceptions [aria-label="Remove exception for example-support.com"]')!.click();
    await vi.waitFor(() => expect(sent.at(-1)).toEqual({ kind: 'known.risk.exception.remove', id: 'x2' }));
  });

  it('asks for the list’s site in the Subscribe click, before anything is awaited (R14)', async () => {
    const pane = await render();
    pane.querySelector<HTMLButtonElement>('[data-risk-subscribe]')!.click();
    const dialog = document.querySelector('dialog')!;
    const input = dialog.querySelector<HTMLInputElement>('input[type="url"]')!, form = dialog.querySelector('form')!;
    input.value = 'http://lists.example.org/phish.json';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(text(dialog.querySelector('.form-error'))).toBe('Use an https address, such as https://example.org/risklist.json.');
    expect(request).not.toHaveBeenCalled();
    input.value = 'https://lists.example.org/phish.json';
    answer = () => ({ ok: true, list: list('e', { name: 'Example phishing list' }) });
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(request).toHaveBeenCalledWith({ origins: ['https://lists.example.org/*'] });
    expect(sent).toEqual([]);
    await vi.waitFor(() => expect(sent).toEqual([{ kind: 'known.risk.subscribe', url: 'https://lists.example.org/phish.json', refreshIntervalHours: 6 }]));
    await vi.waitFor(() => expect(document.querySelector('dialog')).toBeNull());
  });

  it('subscribes to nothing when the site is not allowed', async () => {
    granted = false;
    const pane = await render();
    pane.querySelector<HTMLButtonElement>('[data-risk-subscribe]')!.click();
    const dialog = document.querySelector('dialog')!;
    dialog.querySelector<HTMLInputElement>('input[type="url"]')!.value = 'https://lists.example.org/phish.json';
    dialog.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(text(dialog.querySelector('.form-error'))).toContain('Allow reading lists.example.org'));
    expect(sent).toEqual([]);
  });

  it('refreshes now and removes a list by command', async () => {
    const pane = await render();
    answer = () => ({ ok: true, list: list('a', { currentVersion: '8' }) });
    pane.querySelector<HTMLButtonElement>('[data-risk-list="a"] [aria-label="Refresh now"]')!.click();
    expect(request).toHaveBeenCalledWith({ origins: ['https://lists.example.org/*'] });
    await vi.waitFor(() => expect(sent).toEqual([{ kind: 'known.risk.refresh', id: 'a' }]));
    pane.querySelector<HTMLButtonElement>('[data-risk-list="b"] [aria-label="Remove list"]')!.click();
    const confirm = Array.from(document.querySelectorAll<HTMLButtonElement>('dialog button')).find((button) => text(button) === 'Remove list')!;
    confirm.click();
    await vi.waitFor(() => expect(sent.at(-1)).toEqual({ kind: 'known.risk.remove', id: 'b' }));
  });

  it('View list from the popup brings its row into view', async () => {
    const pane = await render('#automations?item=risk-c');
    await flush();
    expect(pane.querySelector('[data-risk-list="c"] > .list-row')!.hasAttribute('data-highlight')).toBe(true);
    expect(pane.querySelector('[data-risk-list="a"] > .list-row')!.hasAttribute('data-highlight')).toBe(false);
  });
});

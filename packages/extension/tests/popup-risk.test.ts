// @vitest-environment happy-dom
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RiskMatch } from '../src/risk/risk-check.js';
import type { RiskCheckView } from '../src/risk/risk-messages.js';
import { bindPopupRisk } from '../src/popup-risk.js';

/** Doc 17 §9 On save, RS-17, RS-18, R11, R12: the popup's notice says what each list says, offers Dismiss, Add exception and View list, and touches nothing else. */
const PAGE = 'https://www.login-example-support.com/account';
const match = (over: Partial<RiskMatch> = {}): RiskMatch => ({ listId: 'l1', listName: 'Example phishing list', scope: 'domain', value: 'login-example-support.com',
  kind: 'phishing', since: '2026-10-17T00:00:00Z', expires: null, evidenceUrl: 'https://example.org/r/1', expired: false, freshness: 'fresh', ...over });
const site = { host: 'www.login-example-support.com', domain: 'login-example-support.com' };

let check: RiskCheckView, sent: Record<string, unknown>[], opened: string[], url: string;
const text = (node: Element | null) => (node?.textContent ?? '').replace(/\s+/gu, ' ').trim();

function bind() {
  document.body.innerHTML = '<div id="risk-notice" class="inline-alert" hidden></div>';
  const notice = document.getElementById('risk-notice')!;
  return { notice, risk: bindPopupRisk({ notice, page: () => ({ url }) }) };
}

beforeEach(() => {
  check = { mode: 'onSave', matches: [match()], site }; sent = []; opened = []; url = PAGE;
  vi.stubGlobal('chrome', {
    runtime: { getURL: (path: string) => `chrome-extension://known/${path}`, sendMessage: vi.fn(async (message: Record<string, unknown>) => {
      sent.push(message);
      return message.kind === 'known.risk.check' ? { ok: true, check } : { ok: true };
    }) },
    tabs: { create: vi.fn(async ({ url }: { url: string }) => { opened.push(url); }) },
  });
});
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; });

describe('the popup’s risk notice', () => {
  it('stays hidden for a page on no list, with nothing said about it (RS-17.2)', async () => {
    check = { mode: 'onSave', matches: [], site: null };
    const { notice, risk } = bind();
    await risk.refresh();
    expect(sent).toEqual([{ kind: 'known.risk.check', url: PAGE }]);
    expect(notice.hidden).toBe(true);
    expect(text(notice)).toBe('');
  });

  it('names the list, what it calls the page, since when, what it names and its evidence (RS-17.1)', async () => {
    const { notice, risk } = bind();
    await risk.refresh();
    expect(notice.hidden).toBe(false);
    expect(text(notice.querySelector('.risk-notice-title'))).toBe('This page is on a risk list you subscribe to');
    const line = notice.querySelector('.risk-notice-matches li')!;
    expect(text(line)).toMatch(/^Example phishing list: listed as phishing since .+ · all of login-example-support\.com · Evidence$/u);
    expect(line.querySelector('a')!.getAttribute('href')).toBe('https://example.org/r/1');
    expect(text(notice)).toContain('You can still save it; the folder stays as it is.');
  });

  it('lists every list’s match with its source, and labels expired entries and stale or out-of-date lists (RS-18.3, RS-18.4, R11)', async () => {
    check = { mode: 'onSave', site, matches: [match(), match({ listId: 'l2', listName: 'Other list', scope: 'host', value: 'www.login-example-support.com', kind: 'scam',
      expired: true, expires: '2026-10-01T00:00:00Z', evidenceUrl: null }), match({ listId: 'l3', listName: 'Old list', freshness: 'outOfDate' }),
    match({ listId: 'l4', listName: 'Slow list', freshness: 'stale', scope: 'urlPrefix', value: 'https://www.login-example-support.com/account' })] };
    const { notice, risk } = bind();
    await risk.refresh();
    expect(text(notice.querySelector('.risk-notice-title'))).toBe('This page is on 4 risk lists you subscribe to');
    const lines = Array.from(notice.querySelectorAll('.risk-notice-matches li')).map(text);
    expect(lines[1]).toMatch(/^Other list: listed as a scam until .+ \(expired\) · this host, www\.login-example-support\.com$/u);
    expect(lines[2]).toBe('Old list: unknown, list out of date · all of login-example-support.com · Evidence');
    expect(lines[3]).toMatch(/^Slow list: listed as phishing since .+ · addresses starting https:\/\/www\.login-example-support\.com\/account · list not updated for over a week · Evidence$/u);
  });

  it('Dismiss hides it for this page only', async () => {
    const { notice, risk } = bind();
    await risk.refresh();
    Array.from(notice.querySelectorAll('button')).find((button) => text(button) === 'Dismiss')!.click();
    expect(notice.hidden).toBe(true);
    await risk.refresh();
    expect(notice.hidden).toBe(true);
    url = 'https://login-example-support.com/other';
    await risk.refresh();
    expect(notice.hidden).toBe(false);
  });

  it('adds an exception for the host or the domain, this session or always (R12)', async () => {
    const { notice, risk } = bind();
    await risk.refresh();
    Array.from(notice.querySelectorAll('button')).find((button) => text(button) === 'Add exception')!.click();
    const [scope, duration] = Array.from(notice.querySelectorAll('select'));
    expect(Array.from(scope!.options).map((option) => [option.value, text(option)])).toEqual([['host', 'Only www.login-example-support.com'],
      ['domain', 'All of login-example-support.com']]);
    expect(Array.from(duration!.options).map((option) => option.value)).toEqual(['session', 'always']);
    scope!.value = 'domain'; duration!.value = 'always';
    // Cancel goes back to the notice's actions.
    Array.from(notice.querySelectorAll('button')).find((button) => text(button) === 'Cancel')!.click();
    expect(notice.querySelector('.risk-notice-except')).toBeNull();
    expect(notice.querySelector<HTMLElement>('.risk-notice-body > .risk-notice-actions')!.hidden).toBe(false);
    Array.from(notice.querySelectorAll('button')).find((button) => text(button) === 'Add exception')!.click();
    const [scopeAgain, durationAgain] = Array.from(notice.querySelectorAll('select'));
    scopeAgain!.value = 'domain'; durationAgain!.value = 'always';
    Array.from(notice.querySelectorAll('button')).find((button) => text(button) === 'Add')!.click();
    await vi.waitFor(() => expect(text(notice)).toBe('No more risk alerts for login-example-support.com.'));
    expect(sent.at(-1)).toEqual({ kind: 'known.risk.exception.add', scope: 'domain', value: 'login-example-support.com', duration: 'always' });
    expect(notice.dataset.tone).toBe('success');
  });

  it('View list opens the list in Options', async () => {
    const { notice, risk } = bind();
    await risk.refresh();
    Array.from(notice.querySelectorAll('button')).find((button) => text(button) === 'View list')!.click();
    expect(opened).toEqual(['chrome-extension://known/options.html#automations?item=risk-l1']);
  });

  it('shows only the answer for the latest page', async () => {
    const { notice, risk } = bind();
    const first = risk.refresh();
    url = 'https://example.org/';
    check = { mode: 'onSave', matches: [], site: null };
    await Promise.all([first, risk.refresh()]);
    expect(notice.hidden).toBe(true);
  });

  it('the risk modules call no bookmark API and no classifier, and change no rule (RS-17.5, R17)', () => {
    const root = resolve(import.meta.dirname, '../src');
    const files = [resolve(root, 'popup-risk.ts'), resolve(root, 'sw/risk.ts'), ...readdirSync(resolve(root, 'risk')).map((name) => resolve(root, 'risk', name))];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/chrome\.bookmarks|classif|rule-list-decide|rule-list-store|known\.automation\.browser\./u);
    }
  });
});

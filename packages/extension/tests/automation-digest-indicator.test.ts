// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BADGE_ACCENT, BADGE_MUTED } from '../src/badge-colors.js';
import { digestIndicator, toolbarBadge } from '../src/automation/digest-indicator.js';
import type { AutomationRunView, AutomationServerView } from '../src/automation/messages.js';
import { runBadge } from '../src/automation/status-ui.js';
import { digestLine, paintDigestNote } from '../src/popup-digest.js';
import { createPopupNote } from '../src/popup-note.js';

/**
 * AW-60: the badge and the popup line are a projection of the server's unread
 * state. Nothing is counted from content, and nothing is marked read here.
 */
const NOW = Date.parse('2026-10-14T08:00:00.000Z');
const WEB = 'https://colp.example/automations';
const run = (id: string, over: Partial<AutomationRunView> = {}): AutomationRunView => ({ id, ruleName: 'Weekly reading digest', kind: 'batch',
  status: 'completed', held: false, explanation: null, at: NOW, unread: false, outputCount: 0, url: `${WEB}/runs/${id}`, ...over });
const server = (runs: AutomationRunView[], over: Partial<AutomationServerView> = {}): AutomationServerView =>
  ({ fetchedAt: NOW - 60_000, problem: null, rules: [], runs, ...over });

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

describe('new results, as the server reports them', () => {
  it('shows only runs the server marks unread with output, and points at the newest', () => {
    const runs = [run('read', { outputCount: 1 }), run('empty', { unread: true }), run('new', { unread: true, outputCount: 1 })];
    expect(digestIndicator(server(runs), WEB)).toEqual({ count: 1, digests: true, url: `${WEB}/runs/new`, ruleName: 'Weekly reading digest',
      fetchedAt: NOW - 60_000, stale: false });
    expect(digestIndicator(server([run('read', { outputCount: 3 })]), WEB)).toBeNull();
    // Nothing read yet, or a server without automations: no indicator at all.
    expect(digestIndicator(server(runs, { fetchedAt: null }), WEB)).toBeNull();
    expect(digestIndicator(null, WEB)).toBeNull();
  });

  it('sends several to the web’s Digests page, and says results when not all are digests', () => {
    const several = digestIndicator(server([run('a', { unread: true, outputCount: 1 }), run('b', { unread: true, outputCount: 2, kind: 'intake' })]), `${WEB}/`)!;
    expect(several).toMatchObject({ count: 2, digests: false, url: `${WEB}/digests`, ruleName: null });
    expect(toolbarBadge(several)).toEqual({ text: '2', color: BADGE_ACCENT, title: '2 new results from your automations.' });
  });

  it('keeps the last answer on the toolbar while the server can’t be read, muted and dated', () => {
    const stale = digestIndicator(server([run('new', { unread: true, outputCount: 1 })], { fetchedAt: NOW - 3 * 3_600_000, problem: 'offline' }), WEB)!;
    const badge = toolbarBadge(stale);
    expect([badge.text, badge.color]).toEqual(['1', BADGE_MUTED]);
    expect(badge.title).toMatch(/^1 new digest as of .+\. Your server couldn’t be reached since\.$/u);
    expect(toolbarBadge({ ...stale, count: 120, stale: false }).text).toBe('99+');
  });

  it('marks an unread result New in the Options run list', () => {
    expect(runBadge({ status: 'completed', held: false, unread: true, outputCount: 1 })).toMatchObject({ textContent: 'New', dataset: { tone: 'accent' } });
    expect(runBadge({ status: 'completed', held: false, unread: false, outputCount: 1 }).textContent).toBe('Done');
  });
});

describe('the popup line', () => {
  it('names the rule and opens the run on the web, without marking anything read', async () => {
    const tabs: string[] = [], messages: unknown[] = [];
    const indicator = digestIndicator(server([run('new', { unread: true, outputCount: 1 })]), WEB)!;
    vi.stubGlobal('chrome', { tabs: { create: async ({ url }: { url: string }) => { tabs.push(url); } },
      runtime: { sendMessage: async (message: unknown) => { messages.push(message); return { ok: true, digest: indicator }; } } });
    document.body.innerHTML = '<p id="note" hidden></p>';
    const host = document.getElementById('note')!, note = createPopupNote(host);
    await paintDigestNote(note);
    expect(host.textContent).toBe('1 new digest from “Weekly reading digest” · Read');
    host.querySelector('button')!.click();
    expect(tabs).toEqual([`${WEB}/runs/new`]);
    // One read of the worker's last answer; no read marker is ever sent.
    expect(messages).toEqual([{ kind: 'known.automation.digest' }]);
  });

  it('gives way to anything about the page in front, and says how old a stale answer is', () => {
    document.body.innerHTML = '<p id="note" hidden></p>';
    const host = document.getElementById('note')!, note = createPopupNote(host);
    const stale = digestIndicator(server([run('a', { unread: true, outputCount: 1 }), run('b', { unread: true, outputCount: 1 })],
      { fetchedAt: NOW - 2 * 3_600_000, problem: 'offline' }), WEB)!;
    note.set('digest', digestLine(stale));
    expect(host.textContent).toBe('2 new digests · as of 2 hours ago · Open Digests');
    note.set('dest', 'This browser only');
    expect(host.textContent).toBe('This browser only');
    note.set('dest', undefined);
    expect(note.current()).toBe('digest');
  });
});

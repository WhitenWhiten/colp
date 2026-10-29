// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BADGE_ACCENT, BADGE_MUTED } from '../src/badge-colors.js';
import { digestIndicator, toolbarBadge } from '../src/automation/digest-indicator.js';
import type { AutomationRunView, AutomationServerView } from '../src/automation/messages.js';
import { runBadge } from '../src/automation/status-ui.js';
import { digestLine, paintDigestNote } from '../src/popup-digest.js';
import { item } from './automation-activity-fixture.js';
import { activityPanel, activityTitle } from '../src/automation/activity-ui.js';
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
  ({ activity: null, fetchedAt: NOW - 60_000, problem: null, rules: [], runs, ...over });

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


describe('the unified owner activity signal', () => {
  it('prefers activity over digest runs and suppresses the fallback when activity is read', () => {
    const oldRuns = [run('old', { unread: true, outputCount: 1 })];
    const activity = { unreadCount: 7, latest: item, fetchedAt: NOW };
    const indicator = digestIndicator(server(oldRuns, { activity, fetchedAt: null, problem: 'offline' }), WEB)!;
    expect(indicator).toMatchObject({ activity: true, count: 7, url: 'https://colp.example/activity', fetchedAt: NOW, stale: false });
    expect(toolbarBadge(indicator)).toEqual({ text: '7', color: BADGE_ACCENT, title: '7 new from your agents.' });
    expect(digestLine(indicator).textContent).toBe('7 new from your agents · Open');
    expect(digestIndicator(server(oldRuns, { activity: { ...activity, unreadCount: 0 } }), WEB)).toBeNull();
    expect(digestIndicator(server(oldRuns, { activity: null }), WEB)).toMatchObject({ count: 1, digests: true });
  });

  it('uses the activity read age and failure independently and keeps the popup sentence concise', () => {
    const indicator = digestIndicator(server([], { activity: { unreadCount: 1, latest: item, fetchedAt: NOW - 120_000 }, activityProblem: 'offline' }), WEB)!;
    expect(indicator).toMatchObject({ ruleName: 'Claude', fetchedAt: NOW - 120_000, stale: true });
    expect(digestLine(indicator).textContent).toBe('1 new from your agents · as of 2 minutes ago · Open');
    expect(toolbarBadge(indicator).color).toBe(BADGE_MUTED);
  });

  it('uses the web item vocabulary and existing row patterns for the Options preview', () => {
    expect(activityTitle(item)).toBe('Claude added 7 bookmarks to LLM Papers');
    expect(activityTitle({ ...item, agent: null, count: 1 })).toBe('An agent added 1 bookmark to LLM Papers');
    for (const [kind, words] of [['run_completed', 'finished'], ['run_partial', 'partly finished'], ['run_failed', 'failed'], ['run_attention', 'needs your decision']] as const) {
      expect(activityTitle({ ...item, kind, run: { id: 'run-1', ruleId: 'rule-1', ruleName: 'Reading digest', status: 'completed', outputCount: 1, attention: null } })).toBe(`Reading digest ${words}`);
    }
    const folder = (nodeId: string, count: number) => ({ nodeId, title: nodeId, count });
    expect(activityTitle({ ...item, folders: [folder('LLM Papers', 6), folder('Reading', 1)] })).toBe('Claude added 7 bookmarks to LLM Papers and 1 more folder');
    expect(activityTitle({ ...item, folders: [folder('LLM Papers', 5), folder('Reading', 1), folder('Later', 1)] }))
      .toBe('Claude added 7 bookmarks to LLM Papers and 2 more folders');
    const panel = activityPanel(server([], { activity: { unreadCount: 1, latest: item, fetchedAt: NOW } }), WEB);
    expect(panel.querySelector('.list-row-title')?.textContent).toBe('Claude added 7 bookmarks to LLM Papers');
    expect(panel.querySelector<HTMLElement>('.badge')?.dataset.tone).toBe('accent');
    expect(panel.querySelector('.badge')?.textContent).toBe('New');
    // The row is the way in: it opens the web inbox, where reading happens, like the popup's Open.
    const row = panel.querySelector<HTMLAnchorElement>('a.list-row')!;
    expect([row.href, row.target]).toEqual(['https://colp.example/activity', '_blank']);
    expect(panel.querySelectorAll('a')).toHaveLength(1);
    // A waiting plan names its agent and reads as the plan's own summary; the row still opens the inbox.
    const approval = { ...item, kind: 'approval_requested' as const, count: 0, folders: [], items: [], plan: { id: 'plan-1', summary: 'Move <b>3</b> items' } };
    expect(activityTitle(approval)).toBe('Claude wants your approval');
    expect(activityTitle({ ...approval, agent: null })).toBe('An agent wants your approval');
    const asking = activityPanel(server([], { activity: { unreadCount: 1, latest: approval, fetchedAt: NOW } }), WEB);
    expect(Array.from(asking.querySelectorAll('.list-row-meta'), (line) => line.textContent)).toEqual([expect.not.stringContaining('digest'), 'Move <b>3</b> items']);
    expect(asking.querySelector('b')).toBeNull();
    expect(asking.querySelector<HTMLElement>('.automation-run-glyph')?.dataset.tone).toBe('warning');
    expect(asking.querySelector<HTMLAnchorElement>('a.list-row')?.href).toBe('https://colp.example/activity');
    const empty = activityPanel(server([], { activity: { unreadCount: 0, latest: null, fetchedAt: NOW } }), WEB);
    expect(empty.querySelector('.empty-title')?.textContent).toBe('No activity yet');
    expect(empty.querySelector('a')).toBeNull();
  });
});

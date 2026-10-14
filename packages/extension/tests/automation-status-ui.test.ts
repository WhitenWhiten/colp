// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutomationRunView, AutomationServerView, AutomationStateView } from '../src/automation/messages.js';
import { bindAutomationsPane } from '../src/automation/options-pane.js';
import { placementBadge, ruleServerBadge, ruleServerMeta, runBadge, runRow, runTitle, serverFreshness } from '../src/automation/status-ui.js';

/**
 * AW-54: the extension words server runs the way the web does, keeps them
 * apart from this browser's placements, and says how old the server's answer is.
 */
const NOW = Date.parse('2026-10-14T08:00:00.000Z');
const run = (over: Partial<AutomationRunView> = {}): AutomationRunView => ({ id: 'run-1', ruleName: 'arXiv papers', kind: 'intake',
  status: 'completed', held: false, explanation: null, at: NOW - 120_000, unread: false, outputCount: 0,
  url: 'https://colp.example/automations/runs/run-1', ...over });
const server = (over: Partial<AutomationServerView> = {}): AutomationServerView => ({ fetchedAt: NOW - 60_000, problem: null, rules: [], runs: [], ...over });
/** Text as it reads on screen: separators are drawn by CSS, and rows, lines and badges stand apart. */
function text(node: Node | null): string {
  const walk = (current: Node): string => {
    if (current.nodeType === Node.TEXT_NODE) return current.textContent ?? '';
    const element = current as HTMLElement;
    if (element.classList?.contains('sep')) return ' · ';
    const inner = Array.from(current.childNodes).map(walk).join('');
    return ['P', 'DIV', 'LI', 'A', 'UL'].includes(element.tagName) || element.classList?.contains('badge') ? ` ${inner} ` : inner;
  };
  return node ? walk(node).replace(/\s+/gu, ' ').trim() : '';
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

describe('run and placement words', () => {
  it('uses the web’s run vocabulary, with tone only for problems', () => {
    const badges = (['waiting', 'running', 'review', 'completed', 'partial', 'blocked', 'cancelled', 'failed'] as const)
      .map((status) => { const node = runBadge({ status, held: false }); return [node.textContent, node.dataset.tone ?? null]; });
    expect(badges).toEqual([['Waiting', null], ['Running', null], ['Needs a decision', 'warning'], ['Done', null], ['Partly done', 'warning'],
      ['Blocked', 'danger'], ['Cancelled', null], ['Failed', 'danger']]);
    // An explicit hold is what the Owner needs to know; a finished run is just finished.
    expect(runBadge({ status: 'waiting', held: true }).textContent).toBe('On hold');
    expect(runBadge({ status: 'completed', held: true }).textContent).toBe('Done');
  });

  it('says what a run did in the Owner’s words, and shows unknown server text as sent', () => {
    expect(runTitle({ kind: 'intake', explanation: 'Canonical device placement verified against the pinned rule and binding.' }))
      .toBe('Placed by your browser, and confirmed by the server.');
    expect(runTitle({ kind: 'intake', explanation: 'Waiting to place in canonical folder academic.' })).toBe('Waiting to move it into the rule’s folder.');
    expect(runTitle({ kind: 'batch', explanation: null })).toBe('Batch');
    expect(runTitle({ kind: 'intake', explanation: 'Something new the server says.' })).toBe('Something new the server says.');
  });

  it('keeps a placement’s own state: a confirmed one needs no badge whatever the server’s work did', () => {
    expect(placementBadge('confirmed')).toBeNull();
    expect(placementBadge('waitingForSync')?.textContent).toBe('Waiting for sync');
    expect(placementBadge('attention')?.dataset.tone).toBe('warning');
  });

  it('opens the run on the web from its row', () => {
    const row = runRow(run({ kind: 'batch', status: 'waiting', held: true }));
    const link = row.querySelector('a')!;
    expect(link.href).toBe('https://colp.example/automations/runs/run-1');
    expect([link.target, link.rel]).toEqual(['_blank', 'noreferrer']);
    // The kind is said once: in the title when the server gave no explanation, in the meta when it did.
    expect(text(row)).toMatch(/^Batch Rule “arXiv papers” · \d+ minutes ago On hold$/u);
    expect(text(runRow(run({ kind: 'batch', explanation: 'Destination unavailable.' }))))
      .toMatch(/^Not moved: the rule’s folder is unavailable\. Rule “arXiv papers” · .+ · Batch Done$/u);
    expect(text(runRow(run({ ruleName: null })))).toMatch(/^New bookmark A rule · /u);
  });

  it('shows a rule’s server state and the server’s own counts and cost words', () => {
    expect(ruleServerBadge('active')).toBeNull();
    expect([ruleServerBadge('degraded')?.textContent, ruleServerBadge('blocked')?.dataset.tone]).toEqual(['On, with problems', 'danger']);
    const rule = { id: 'r', name: 'Summaries', state: 'degraded' as const, inBrowser: false, waiting: 7, held: 1, approvals: 2, cost: 'Billed by your agent' };
    expect(text(ruleServerMeta(rule))).toBe('7 jobs waiting for an agent · 1 held by a limit · 2 need your approval · Billed by your agent');
    expect(ruleServerMeta({ ...rule, waiting: 0, held: 0, approvals: null, cost: null })).toBeNull();
  });
});

describe('freshness', () => {
  it('says how old the server’s answer is, and why it may be old', () => {
    expect(text(serverFreshness(server()))).toBe('Updated 1 minute ago.');
    expect(text(serverFreshness(server({ fetchedAt: null })))).toBe('Checking your server…');
    const offline = serverFreshness(server({ fetchedAt: NOW - 2 * 3_600_000, problem: 'offline' }));
    expect([text(offline), offline.dataset.tone]).toEqual(['Couldn’t reach your server. Showing what it said 2 hours ago.', 'warning']);
    expect(text(serverFreshness(server({ problem: 'signedOut' })))).toBe('Sign in on the web in this browser to update this. Showing what your server said 1 minute ago.');
    expect(text(serverFreshness(server({ fetchedAt: null, problem: 'invalid' })))).toBe('Your server sent something this browser couldn’t read.');
  });
});

describe('Options › Automations with the server’s status', () => {
  const view = (over: Partial<AutomationStateView> = {}): AutomationStateView => ({ account: 'signedIn', state: 'active', webUrl: 'https://colp.example/automations',
    rules: [{ id: 'rule-arxiv', name: 'arXiv papers', folder: 'Academic', resolved: true,
      match: { combinator: 'all', conditions: [{ kind: 'siteIs', value: 'arxiv.org' }] } }],
    placements: [{ id: 'p1', title: 'A paper', host: 'arxiv.org', url: 'https://arxiv.org/abs/1', ruleName: 'arXiv papers', folder: 'Academic',
      at: NOW - 60_000, path: 'preSave', state: 'confirmed' }],
    pausedAt: null, pausedBy: null, expiresAt: NOW + 86_400_000, lastRefreshAt: NOW - 60_000, problem: null,
    server: server({ rules: [{ id: 'rule-arxiv', name: 'arXiv papers', state: 'degraded', inBrowser: true, waiting: 3, held: null, approvals: null, cost: null },
      { id: 'rule-digest', name: 'Weekly digest', state: 'active', inBrowser: false, waiting: 0, held: 0, approvals: 0, cost: 'Billed by your agent' },
      { id: 'rule-old', name: 'Old rule', state: 'archived', inBrowser: false, waiting: null, held: null, approvals: null, cost: null }],
    runs: [run({ status: 'failed', explanation: 'Destination unavailable.' }), run({ id: 'run-2', status: 'waiting' })] }), ...over });

  async function render(state: AutomationStateView): Promise<HTMLElement> {
    document.body.innerHTML = '<section><a data-automations-web hidden></a><div data-automations-body></div></section>';
    vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(async () => ({ ok: true, state })), getURL: (path: string) => `chrome-extension://known${path}` },
      storage: { onChanged: { addListener: vi.fn() } } });
    bindAutomationsPane(document.querySelector('section')!).activate();
    await vi.waitFor(() => expect(document.querySelector('[data-automations-body]')!.children.length).toBeGreaterThan(0));
    return document.querySelector<HTMLElement>('[data-automations-body]')!;
  }

  it('shows placements and server runs as two separate things', async () => {
    const body = await render(view());
    const placements = body.querySelector('[aria-labelledby="automation-placements-heading"]')!;
    const runs = body.querySelector('[aria-labelledby="automation-server-heading"]')!;
    // The confirmed placement carries no badge although a run on the server failed.
    expect(placements.querySelectorAll('.badge')).toHaveLength(0);
    expect(Array.from(runs.querySelectorAll('.automation-run')).map((row) => (row as HTMLElement).dataset.status)).toEqual(['failed', 'waiting']);
    expect(text(runs)).toContain('Not moved: the rule’s folder is unavailable.');
    expect(text(runs.querySelector('.automation-freshness'))).toBe('Updated 1 minute ago.');
  });

  it('says each rule in the web’s words and opens it on the web, with rules that only work on the server', async () => {
    const rules = (await render(view())).querySelector('[aria-labelledby="automation-rules-heading"]')!;
    const rows = Array.from(rules.querySelectorAll<HTMLAnchorElement>('a.list-row'));
    expect(rows.map((row) => row.href)).toEqual(['https://colp.example/automations/rules/rule-arxiv', 'https://colp.example/automations/rules/rule-digest']);
    expect(rows.map((row) => row.target)).toEqual(['_blank', '_blank']);
    expect(Array.from(rows[0]!.querySelectorAll('.automation-recipe span')).map((part) => part.textContent)).toEqual(['From arxiv.org', 'Academic']);
    expect(text(rows[0]!.querySelector('.list-row-meta + .list-row-meta'))).toBe('3 jobs waiting for an agent');
    expect(text(rows[0]!.querySelector('.badge'))).toBe('On, with problems');
    expect(text(rows[1]!)).toBe('Weekly digest Works on your server; nothing to file here. Billed by your agent');
  });

  it('joins a rule’s conditions the way the rule does, and says so when they have no short form', async () => {
    const recipe = async (match: AutomationStateView['rules'][number]['match']) => {
      const body = await render(view({ rules: [{ ...view().rules[0]!, match }] }));
      return body.querySelector('.automation-recipe span')!.textContent;
    };
    expect(await recipe({ combinator: 'any', conditions: [{ kind: 'siteEndsWith', value: 'github.com' }, { kind: 'hasTag', value: 'code' }] }))
      .toBe('From github.com or a subdomain or tagged code');
    expect(await recipe({ combinator: 'all', conditions: [{ kind: 'titleContains', value: 'Paper' }, { kind: 'pathStartsWith', value: '/abs/' }] }))
      .toBe('Title has “Paper” and path starts with /abs/');
    expect(await recipe(null)).toBe('Matches its conditions');
  });

  it('sends the account-wide pause to the web, where the server takes it', async () => {
    const on = await render(view());
    const pause = on.querySelector('.automation-status .set-row')!;
    expect(text(pause.querySelector('.set-row-title'))).toBe('Pause all automations');
    expect(pause.querySelector<HTMLAnchorElement>('a.btn')!.href).toBe('https://colp.example/automations');
    const paused = await render(view({ state: 'paused', rules: [], pausedAt: NOW - 86_400_000, pausedBy: 'owner' }));
    expect(text(paused.querySelector('.automation-status-title'))).toBe('All automations are paused');
    expect(text(paused.querySelector('.automation-status .set-row a.btn'))).toBe('Resume on the web');
    // A server without automations has nothing to pause.
    const off = await render(view({ state: 'none', rules: [], problem: 'unavailable', server: null }));
    expect(off.querySelector('.automation-status .set-row')).toBeNull();
  });

  it('switches recent activity between this browser and the server, one panel at a time', async () => {
    const body = await render(view());
    const tabs = Array.from(body.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    expect(tabs.map((tab) => [text(tab), tab.getAttribute('aria-selected')])).toEqual([['This browser1', 'true'], ['Your server2', 'false']]);
    const panel = (id: string) => body.querySelector<HTMLElement>(`[role="tabpanel"][aria-labelledby="${id}"]`)!;
    expect([panel('automation-placements-heading').hidden, panel('automation-server-heading').hidden]).toEqual([false, true]);
    tabs[1]!.click();
    const next = document.querySelector('[data-automations-body]')!;
    expect(next.querySelector('#automation-server-heading')!.getAttribute('aria-selected')).toBe('true');
    expect(next.querySelector<HTMLElement>('[role="tabpanel"][aria-labelledby="automation-server-heading"]')!.hidden).toBe(false);
  });

  it('asks for a web sign-in when the server can’t be read with one, and leaves the rest of the page as it is', async () => {
    const body = await render(view({ server: server({ fetchedAt: null, problem: 'signedOut' }) }));
    const group = body.querySelector('[aria-labelledby="automation-server-heading"]')!;
    expect(text(group)).toContain('Sign in on the web to see runs');
    expect(group.querySelector<HTMLAnchorElement>('a.btn')!.href).toBe('https://colp.example/automations');
    expect(group.querySelector('.automation-freshness')).toBeNull();
    expect(body.querySelector('[aria-labelledby="automation-placements-heading"]')).not.toBeNull();
  });

  it('says where the filing rules went while paused, and lists only the rules that work on the server', async () => {
    const rules = (await render(view({ state: 'paused', rules: [] }))).querySelector('[aria-labelledby="automation-rules-heading"]')!;
    expect(text(rules)).toBe('Rules Rules that file bookmarks come back here when you resume automations on the web. '
      + 'Weekly digest Works on your server; nothing to file here. Billed by your agent');
  });

  it('says plainly when no rule files bookmarks here, and has no offline copy to promise before the first bundle', async () => {
    const on = await render(view({ rules: [] }));
    expect(text(on.querySelector('.automation-status-title'))).toBe('Automations are on');
    expect(text(on.querySelector('.automation-status-hint'))).toBe('None of your rules file bookmarks in this browser yet.');
    const none = await render(view({ state: 'none', rules: [], expiresAt: null, lastRefreshAt: null }));
    expect(text(none.querySelector('.automation-status-fresh'))).toBe('This browser checks for rules every 5 minutes.');
    expect(text(none.querySelector('.automation-status-main > .btn'))).toBe('Check now');
  });

  it('keeps showing the last runs with their age while the server is unreachable, and hides the section without server automations', async () => {
    const stale = await render(view({ server: { ...view().server!, fetchedAt: NOW - 3 * 3_600_000, problem: 'offline' } }));
    expect(stale.querySelectorAll('.automation-run')).toHaveLength(2);
    expect(text(stale.querySelector('.automation-freshness'))).toBe('Couldn’t reach your server. Showing what it said 3 hours ago.');
    expect((await render(view({ server: null }))).querySelector('[aria-labelledby="automation-server-heading"]')).toBeNull();
  });
});

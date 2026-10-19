// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutomationStateView, BrowserListEntryView, BrowserListView, BrowserRuleView, BrowserSetView } from '../src/automation/messages.js';

vi.mock('../src/bookmark-subscriptions/guards.js', () => ({ exclusionIds: async () => new Set<string>() }));

import { bindAutomationsPane } from '../src/automation/options-pane.js';

/**
 * Doc 17 RW-04 (RS-01, RS-03): Options shows this browser's rules as one ordered list of rules, sets and
 * subscriptions, reorders it with Move up, Move down and dragging, and changes it only through the worker.
 */
const NOW = Date.parse('2026-10-18T08:00:00.000Z');
const rule = (id: string, over: Partial<BrowserRuleView> = {}): BrowserRuleView => ({ id, name: `Rule ${id}`, enabled: true, active: true, setId: null,
  keepHere: false, match: { combinator: 'all', conditions: [{ kind: 'siteIs', value: `${id}.example` }] },
  draft: { name: `Rule ${id}`, combinator: 'all', conditions: [{ kind: 'siteIs', value: `${id}.example` }], action: { kind: 'file', folderNativeId: 'f-papers' } },
  folder: { nativeId: 'f-papers', title: 'Papers', path: ['Bookmarks bar', 'Papers'] }, folderMissing: false, account: null, move: null, localOnly: false,
  moving: false, movingStale: false, ...over });
const set = (id: string, rules: BrowserRuleView[], over: Partial<BrowserSetView> = {}): BrowserListEntryView =>
  ({ kind: 'set', set: { id, name: `Set ${id}`, enabled: true, origin: { kind: 'custom' }, rules: rules.map((item) => ({ ...item, setId: id })), ...over } });
const one = (item: BrowserRuleView): BrowserListEntryView => ({ kind: 'rule', rule: item });

function view(entries: BrowserListEntryView[], list: Partial<BrowserListView> = {}): AutomationStateView {
  const browserRules = entries.flatMap((entry) => entry.kind === 'rule' ? [entry.rule] : entry.kind === 'set' ? entry.set.rules : []);
  return { account: 'signedOut', state: 'none', rules: [], placements: [], browserRules, browserList: { revision: 3, enabled: true, entries, orderNotice: null, ...list },
    pausedAt: null, pausedBy: null, expiresAt: null, lastRefreshAt: null, problem: null, webUrl: null, server: null, saving: { mode: 'manual', ai: null, suggestInForm: false } };
}
const standard = () => view([one(rule('a')), set('s', [rule('b'), rule('c')]), one(rule('d')), { kind: 'subscription', id: 'sub', enabled: true }]);

let sent: Record<string, unknown>[] = [];
let reply: (message: Record<string, unknown>) => unknown;
let current: AutomationStateView;
let changed: ((changes: Record<string, unknown>, area: string) => void) | undefined;
const text = (node: Element | null) => (node?.textContent ?? '').replace(/\s+/gu, ' ').trim();

async function render(state: AutomationStateView): Promise<HTMLElement> {
  current = state;
  document.body.innerHTML = '<section><a data-automations-web hidden></a><button data-automations-new type="button">New rule</button><div data-automations-body></div></section>';
  vi.stubGlobal('chrome', {
    runtime: { getURL: (path: string) => `chrome-extension://known/${path}`, sendMessage: vi.fn(async (message: Record<string, unknown>) => {
      if (message.kind === 'known.automation.state') return { ok: true, state: current };
      sent.push(message); return reply(message);
    }) },
    storage: { onChanged: { addListener: vi.fn((listener: typeof changed) => { changed = listener; }) } },
    permissions: { contains: async () => true, request: async () => true },
    bookmarks: { getTree: async () => [{ id: '0', title: '', children: [{ id: '1', title: 'Bookmarks bar', children: [{ id: 'f-papers', title: 'Papers', children: [] }] }] }] },
  });
  bindAutomationsPane(document.querySelector('section')!).activate();
  await vi.waitFor(() => expect(document.querySelector('.rule-list, .automation-browser .empty')).not.toBeNull());
  return document.querySelector<HTMLElement>('[data-automations-body]')!;
}
/** The worker kept a change: the page reads the state again, as it does on the automation marker. */
async function repaint(state: AutomationStateView): Promise<void> {
  current = state;
  changed?.({ 'known.automation.changed.v1': { newValue: Date.now() } }, 'local');
  await vi.waitFor(() => expect(document.querySelector('.rule-list')).not.toBeNull());
  await new Promise((resolve) => setTimeout(resolve, 0));
}
const row = (id: string) => document.querySelector<HTMLElement>(`[data-entry-id="${id}"] > .list-row`)!;
const control = (id: string, name: 'up' | 'down') => row(id).querySelector<HTMLButtonElement>(`[data-move="${name}"]`)!;
const dialog = () => document.querySelector<HTMLDialogElement>('dialog.capture-dialog')!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
  sent = []; reply = () => ({ ok: true, revision: 4 }); changed = undefined;
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) { this.open = true; };
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

describe('the list on the page', () => {
  it('shows rules, sets and subscriptions in the order saves try them, each set over its own rules', async () => {
    const body = await render(standard());
    const list = body.querySelector('.rule-list')!;
    expect(Array.from(list.children).map((item) => (item as HTMLElement).dataset.entryId)).toEqual(['a', 's', 'd', 'sub']);
    expect(Array.from(list.querySelectorAll('[data-entry-id="s"] .rule-set-rules > li')).map((item) => (item as HTMLElement).dataset.entryId)).toEqual(['b', 'c']);
    expect(text(row('s').querySelector('.list-row-meta'))).toBe('2 rules · Your set');
    expect(text(row('sub'))).toContain('No version yet, so it files nothing.');
    expect(text(body.querySelector('#automation-browser-heading'))).toBe('Rules in this browser4');
    expect(text(body.querySelector('.automation-browser .detail'))).toContain('Tried from the top, and the first that matches decides.');
  });

  it('dims what takes no part in saves: a rule in a switched-off set, the whole list switched off', async () => {
    await render(view([set('s', [rule('b', { active: false })], { enabled: false }), one(rule('a'))]));
    expect(row('s').dataset.off).toBe('');
    expect(row('b').dataset.off).toBe('');
    expect(row('a').dataset.off).toBeUndefined();
    await repaint(view([one(rule('a', { active: false }))], { enabled: false }));
    expect(text(document.querySelector('.automation-browser .detail'))).toBe('Switched off: pages you save keep the folder you save them to.');
    expect(document.querySelector('.automation-list-switch')!.getAttribute('aria-checked')).toBe('false');
  });

  it('switches a set, a subscription and the whole list through the worker', async () => {
    await render(standard());
    row('s').querySelector<HTMLButtonElement>('[role="switch"]')!.click();
    row('sub').querySelector<HTMLButtonElement>('[role="switch"]')!.click();
    document.querySelector<HTMLButtonElement>('.automation-list-switch')!.click();
    expect(sent).toEqual([{ kind: 'known.automation.browser.enable', id: 's', enabled: false, entry: 'set' },
      { kind: 'known.automation.browser.enable', id: 'sub', enabled: false, entry: 'subscription' },
      { kind: 'known.automation.browser.list.enable', enabled: false }]);
  });
});

describe('moving entries', () => {
  it('moves an entry of the list up or down with the whole order, and not past either end', async () => {
    await render(standard());
    expect(control('a', 'up').disabled).toBe(true);
    expect(control('sub', 'down').disabled).toBe(true);
    control('d', 'up').click();
    control('s', 'down').click();
    expect(sent).toEqual([{ kind: 'known.automation.browser.reorder', order: ['a', 'd', 's', 'sub'] },
      { kind: 'known.automation.browser.reorder', order: ['a', 'd', 's', 'sub'] }]);
  });

  it('moves a rule within its set, and out of it past either end', async () => {
    await render(standard());
    control('b', 'down').click();
    control('b', 'up').click();
    control('c', 'down').click();
    expect(sent).toEqual([{ kind: 'known.automation.browser.moveRule', ruleId: 'b', into: 's', index: 1 },
      { kind: 'known.automation.browser.moveRule', ruleId: 'b', into: null, index: 1 },
      { kind: 'known.automation.browser.moveRule', ruleId: 'c', into: null, index: 2 }]);
  });

  it('keeps focus on the moved entry once the list repaints', async () => {
    await render(standard());
    control('d', 'up').click();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    await repaint(view([one(rule('a')), one(rule('d')), set('s', [rule('b'), rule('c')]), { kind: 'subscription', id: 'sub', enabled: true }]));
    expect(document.activeElement).toBe(control('d', 'up'));
  });

  it('says why a rule cannot leave its set', async () => {
    reply = () => ({ ok: false, error: 'unbound' });
    await render(standard());
    control('b', 'up').click();
    await vi.waitFor(() => expect(text(document.querySelector('.toast'))).toBe('Its set has no folder for it. Choose a folder first.'));
  });

  const drag = (from: HTMLElement, to: HTMLElement, clientY: number) => {
    from.dispatchEvent(new Event('dragstart', { bubbles: true }));
    to.dispatchEvent(new MouseEvent('dragover', { bubbles: true, cancelable: true, clientY }));
    to.dispatchEvent(new MouseEvent('drop', { bubbles: true, cancelable: true, clientY }));
    from.dispatchEvent(new Event('dragend', { bubbles: true }));
  };

  it('drags with the same commands: into a set, out of one, and along the list', async () => {
    await render(standard());
    // Rows here measure 40px: the middle of a set's head takes a rule into it, its top and bottom place beside it.
    drag(row('a'), row('s'), 20);
    drag(row('c'), row('d'), 35);
    drag(row('d'), row('a'), 5);
    drag(row('s'), row('b'), 5);
    expect(sent).toEqual([{ kind: 'known.automation.browser.moveRule', ruleId: 'a', into: 's', index: 2 },
      { kind: 'known.automation.browser.moveRule', ruleId: 'c', into: null, index: 3 },
      { kind: 'known.automation.browser.reorder', order: ['d', 'a', 's', 'sub'] }]);
  });

  it('drops a rule into an empty set through its hint row', async () => {
    await render(view([one(rule('a')), set('s', [])]));
    const hint = document.querySelector<HTMLElement>('.rule-set-empty')!;
    expect(text(hint)).toBe('No rules yet. Drag rules here, or add one.');
    drag(row('a'), hint, 10);
    expect(sent).toEqual([{ kind: 'known.automation.browser.moveRule', ruleId: 'a', into: 's', index: 0 }]);
  });
});

describe('sets', () => {
  it('are made with a name, and a nameless one is refused at once', async () => {
    reply = () => ({ ok: true, set: { id: 'n', name: 'Research' } });
    await render(standard());
    document.querySelector<HTMLButtonElement>('.automation-list-tools .btn')!.click();
    const form = dialog().querySelector('form')!;
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(text(dialog().querySelector('.form-error'))).toBe('Give the set a name.');
    dialog().querySelector<HTMLInputElement>('input')!.value = '  Research ';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(sent).toEqual([{ kind: 'known.automation.browser.set.save', name: 'Research' }]);
  });

  it('ask whether their rules stay when deleted, and say why the worker could not keep them', async () => {
    reply = () => ({ ok: false, error: 'unbound' });
    await render(standard());
    row('s').querySelector<HTMLButtonElement>('button[aria-label="Delete set"]')!.click();
    expect(text(dialog().querySelector('h3'))).toBe('Delete “Set s”?');
    const choices = Array.from(dialog().querySelectorAll<HTMLInputElement>('input[type="radio"]'));
    expect(choices.map((input) => [input.value, input.checked])).toEqual([['keep', true], ['delete', false]]);
    dialog().querySelector<HTMLButtonElement>('.btn-danger')!.click();
    await vi.waitFor(() => expect(text(dialog().querySelector('.form-error'))).toContain('Choose them, or delete the rules with the set.'));
    choices[1]!.click();
    dialog().querySelector<HTMLButtonElement>('.btn-danger')!.click();
    expect(sent).toEqual([{ kind: 'known.automation.browser.set.remove', id: 's', keepRules: true },
      { kind: 'known.automation.browser.set.remove', id: 's', keepRules: false }]);
  });

  it('start a new rule inside themselves, and copy a rule or a set below the original', async () => {
    await render(standard());
    row('s').querySelector<HTMLButtonElement>('button[aria-label="New rule in this set"]')!.click();
    const editor = document.querySelector<HTMLDialogElement>('dialog.automation-rule-editor')!;
    expect(editor.querySelector<HTMLSelectElement>('.automation-in-set select')!.value).toBe('s');
    editor.close();
    row('b').querySelector<HTMLButtonElement>('button[aria-label="Duplicate rule"]')!.click();
    row('s').querySelector<HTMLButtonElement>('button[aria-label="Duplicate set"]')!.click();
    expect(sent).toEqual([{ kind: 'known.automation.browser.duplicate', id: 'b', entry: 'rule', name: 'Rule b (copy)' },
      { kind: 'known.automation.browser.duplicate', id: 's', entry: 'set', name: 'Set s (copy)' }]);
  });
});

describe('the one-time note about order (R2)', () => {
  it('names the rules whose order now decides, until it is read', async () => {
    await render(view([one(rule('a')), one(rule('b'))], { orderNotice: [{ upper: 'Rule a', lower: 'Rule b' }] }));
    const notice = document.querySelector('.automation-browser .inline-alert')!;
    expect(text(notice)).toContain('the upper one files it now: “Rule a” before “Rule b”.');
    notice.querySelector<HTMLButtonElement>('button')!.click();
    expect(sent).toEqual([{ kind: 'known.automation.browser.notice.dismiss' }]);
  });
});

// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutomationStateView, BrowserRuleView } from '../src/automation/messages.js';

vi.mock('../src/bookmark-subscriptions/guards.js', () => ({ exclusionIds: async () => new Set(['f-sub']) }));

import { bindAutomationsPane } from '../src/automation/options-pane.js';

/**
 * AW-68: Options › Automations lists this browser's own rules, leads with them
 * when signed out, and writes them through one dialog. The worker checks every
 * draft; the page only sends what the Owner filled in and shows what came back.
 */
const NOW = Date.parse('2026-10-14T08:00:00.000Z');
const rule = (over: Partial<BrowserRuleView> = {}): BrowserRuleView => ({ id: 'b-1', name: 'Papers from arXiv', enabled: true,
  match: { combinator: 'all', conditions: [{ kind: 'siteIs', value: 'arxiv.org' }] },
  draft: { name: 'Papers from arXiv', combinator: 'all', conditions: [{ kind: 'siteIs', value: 'arxiv.org' }], folderNativeId: 'f-papers' },
  folder: { nativeId: 'f-papers', title: 'Papers', path: ['Bookmarks bar', 'Papers'] }, folderMissing: false, account: null, move: null, localOnly: false,
  moving: false, movingStale: false, ...over });
const view = (over: Partial<AutomationStateView> = {}): AutomationStateView => ({ account: 'signedOut', state: 'none', rules: [], placements: [],
  browserRules: [rule(), rule({ id: 'b-2', name: 'SEO reading', enabled: false,
    match: { combinator: 'any', conditions: [{ kind: 'siteEndsWith', value: 'moz.com' }, { kind: 'titleContains', value: 'SEO' }] },
    draft: { name: 'SEO reading', combinator: 'any', conditions: [{ kind: 'siteEndsWith', value: 'moz.com' }, { kind: 'titleContains', value: 'SEO' }],
      folderNativeId: 'f-papers' } }),
  rule({ id: 'b-3', name: 'Recipes', folder: null, folderMissing: true })],
  pausedAt: null, pausedBy: null, expiresAt: null, lastRefreshAt: null, problem: null, webUrl: null, server: null, saving: { mode: 'manual', ai: null, suggestInForm: false }, ...over });
const tree = [{ id: '0', title: '', children: [{ id: '1', title: 'Bookmarks bar', children: [{ id: 'f-papers', title: 'Papers', children: [] },
  { id: 'f-sub', title: 'A subscription', children: [] }] }] }];

let sent: Record<string, unknown>[] = [];
let reply: (message: Record<string, unknown>) => unknown;
function text(node: Element | null): string { return (node?.textContent ?? '').replace(/\s+/gu, ' ').trim(); }

async function render(state: AutomationStateView): Promise<HTMLElement> {
  document.body.innerHTML = '<section><a data-automations-web hidden></a><button data-automations-new type="button">New rule</button><div data-automations-body></div></section>';
  vi.stubGlobal('chrome', {
    runtime: { getURL: (path: string) => `chrome-extension://known/${path}`, sendMessage: vi.fn(async (message: Record<string, unknown>) => {
      if (message.kind === 'known.automation.state' || message.kind === 'known.automation.refresh') return { ok: true, state };
      sent.push(message); return reply(message);
    }) },
    storage: { onChanged: { addListener: vi.fn() } },
    permissions: { contains: async () => true, request: async () => true },
    bookmarks: { getTree: async () => tree },
  });
  bindAutomationsPane(document.querySelector('section')!).activate();
  await vi.waitFor(() => expect(document.querySelector('[data-automations-body]')!.children.length).toBeGreaterThan(0));
  return document.querySelector<HTMLElement>('[data-automations-body]')!;
}
const editor = () => document.querySelector<HTMLDialogElement>('dialog.automation-rule-editor')!;
const submit = () => editor().querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
  sent = []; reply = () => ({ ok: true, rule: null });
  // happy-dom's dialog has no modal layer; opening it is enough here.
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) { this.open = true; };
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

describe('Rules in this browser on the page', () => {
  it('lead the page when signed out, in the web’s words, and say what an account adds', async () => {
    const body = await render(view());
    // The order every save follows comes first (U3); then this browser's rules lead.
    const groups = Array.from(body.children).slice(1);
    expect(body.children[0]!.getAttribute('aria-labelledby')).toBe('automation-flow-heading');
    expect(groups[0]!.getAttribute('aria-labelledby')).toBe('automation-browser-heading');
    expect(text(groups[0]!.querySelector('h2'))).toBe('Rules in this browser3');
    const rows = Array.from(body.querySelectorAll('.automation-browser-rule'));
    expect(rows.map((row) => Array.from(row.querySelectorAll('.automation-recipe span')).map((part) => part.textContent))).toEqual([
      ['From arxiv.org', 'Papers'], ['From moz.com or a subdomain or title has “SEO”', 'Papers'], ['From arxiv.org', 'a folder that no longer exists']]);
    expect(rows.map((row) => text(row.querySelector('.badge')))).toEqual(['', 'Off', 'Folder missing']);
    expect(rows.map((row) => row.querySelector('[role="switch"]')!.getAttribute('aria-checked'))).toEqual(['true', 'false', 'true']);
    expect(text(groups[1]!)).toContain('Your account’s rules');
    expect(groups[1]!.querySelector<HTMLAnchorElement>('a.btn')!.getAttribute('href')).toBe('#account');
    // No status card and no web link without an account.
    expect(body.querySelector('.automation-status')).toBeNull();
    expect(document.querySelector<HTMLElement>('[data-automations-web]')!.hidden).toBe(true);
  });

  it('say they are paused with the account’s automations, and each rule that would file says Paused', async () => {
    const body = await render(view({ account: 'signedIn', state: 'paused', webUrl: 'https://colp.example/automations', pausedAt: NOW - 60_000 }));
    const group = body.querySelector('.automation-browser')!;
    expect(text(group.querySelector('.detail'))).toBe('Paused with your account’s automations. They file pages again when you resume on the web.');
    // Folder missing and Off say more than Paused; the switches still work.
    expect(Array.from(group.querySelectorAll('.automation-browser-rule')).map((row) => text(row.querySelector('.badge')))).toEqual(['Paused', 'Off', 'Folder missing']);
    expect(text(body.querySelector('.automation-status'))).toContain('rules in this browser pause with them');
  });

  it('come after the account’s status and rules when signed in', async () => {
    const body = await render(view({ account: 'signedIn', state: 'active', webUrl: 'https://colp.example/automations',
      rules: [{ id: 'rule-arxiv', name: 'arXiv papers', folder: 'Academic', resolved: true, match: null }] }));
    expect(Array.from(body.children).map((node) => node.getAttribute('aria-labelledby'))).toEqual(['automation-flow-heading', 'automation-status-title',
      'automation-rules-heading', 'automation-browser-heading']);
    expect(text(body.querySelector('#automation-rules-heading'))).toBe('Your account’s rules');
    // One New rule for the page (U2): the account's section has no second one.
    expect(body.querySelector('[aria-labelledby="automation-rules-heading"] .automation-group-head a, [aria-labelledby="automation-rules-heading"] .automation-group-head button')).toBeNull();
  });

  it('offer the first rule when there is none', async () => {
    const body = await render(view({ browserRules: [] }));
    const empty = body.querySelector('[aria-labelledby="automation-browser-heading"] .empty')!;
    expect(text(empty)).toContain('No rules in this browser yet');
    empty.querySelector<HTMLButtonElement>('button')!.click();
    expect(text(editor().querySelector('h3'))).toBe('New rule in this browser');
  });

  it('switch a rule off and back when the worker refuses', async () => {
    const body = await render(view());
    const toggle = body.querySelector<HTMLButtonElement>('.automation-browser-rule [role="switch"]')!;
    toggle.click();
    expect(sent).toEqual([{ kind: 'known.automation.browser.enable', id: 'b-1', enabled: false }]);
    await vi.waitFor(() => expect(toggle.disabled).toBe(false));
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    reply = () => ({ ok: false, error: 'notFound' });
    toggle.click();
    await vi.waitFor(() => expect(toggle.disabled).toBe(false));
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });
});

describe('the rule dialog', () => {
  it('says what is missing before asking the worker', async () => {
    await render(view());
    document.querySelector<HTMLButtonElement>('[data-automations-new]')!.click();
    await vi.waitFor(() => expect(editor().querySelectorAll('.folder-opt').length).toBe(2));
    submit();
    expect(sent).toEqual([]);
    expect(Array.from(editor().querySelectorAll<HTMLElement>('.form-error:not([hidden])')).map((node) => node.textContent))
      .toEqual(['Add at least one condition.', 'Choose the folder pages go to.']);
    // Subscription folders are not offered.
    expect(Array.from(editor().querySelectorAll('.folder-opt')).map((node) => text(node))).toEqual(['Bookmarks bar', 'Papers']);
  });

  it('sends the conditions and the folder, and puts the worker’s problems on their row', async () => {
    reply = () => ({ ok: false, error: 'invalid', problems: [{ field: 'condition', index: 1, code: 'invalidHost' }] });
    await render(view());
    document.querySelector<HTMLButtonElement>('[data-automations-new]')!.click();
    await vi.waitFor(() => expect(editor().querySelectorAll('.folder-opt').length).toBe(2));
    const dialog = editor();
    dialog.querySelector<HTMLInputElement>('.automation-condition input')!.value = 'Paper';
    dialog.querySelector<HTMLSelectElement>('.automation-condition select')!.value = 'titleContains';
    dialog.querySelector<HTMLButtonElement>('.automation-add-condition')!.click();
    const second = dialog.querySelectorAll('.automation-condition')[1]!;
    second.querySelector<HTMLInputElement>('input')!.value = 'not a site';
    dialog.querySelector<HTMLSelectElement>('.automation-joiner select')!.value = 'any';
    dialog.querySelector<HTMLButtonElement>('.folder-pill')!.click();
    dialog.querySelector<HTMLButtonElement>('.folder-opt[data-folder-id="f-papers"]')!.click();
    submit();
    expect(sent).toEqual([{ kind: 'known.automation.browser.save', draft: { name: 'Paper → Papers', combinator: 'any', folderNativeId: 'f-papers',
      conditions: [{ kind: 'titleContains', value: 'Paper' }, { kind: 'siteIs', value: 'not a site' }] } }]);
    await vi.waitFor(() => expect(text(second.querySelector('.form-error'))).toBe('Use a site name, such as arxiv.org.'));
    expect(dialog.open).toBe(true);
  });

  it('opens a rule as it was written and saves it under its id', async () => {
    reply = () => ({ ok: true, rule: { definition: { name: 'SEO reading' } } });
    const body = await render(view());
    body.querySelectorAll<HTMLElement>('.automation-browser-rule')[1]!.click();
    await vi.waitFor(() => expect(editor().querySelector<HTMLButtonElement>('.folder-pill')!.dataset.value).toBe('f-papers'));
    const dialog = editor();
    expect(text(dialog.querySelector('h3'))).toBe('Edit rule');
    expect(Array.from(dialog.querySelectorAll<HTMLInputElement>('.automation-condition input')).map((input) => input.value)).toEqual(['moz.com', 'SEO']);
    expect(dialog.querySelector<HTMLSelectElement>('.automation-joiner select')!.value).toBe('any');
    expect(dialog.querySelector<HTMLInputElement>('input[maxlength="200"]')!.value).toBe('SEO reading');
    submit();
    expect(sent[0]).toMatchObject({ kind: 'known.automation.browser.save', id: 'b-2', draft: { folderNativeId: 'f-papers', combinator: 'any' } });
    await vi.waitFor(() => expect(dialog.isConnected).toBe(false));
  });

  it('asks before deleting, and says the pages stay where they are', async () => {
    const body = await render(view());
    body.querySelector<HTMLButtonElement>('.automation-browser-rule button[aria-label="Delete rule"]')!.click();
    const confirm = document.querySelector<HTMLDialogElement>('dialog.capture-dialog')!;
    expect(text(confirm.querySelector('h3'))).toBe('Delete “Papers from arXiv”?');
    expect(text(confirm)).toContain('Pages it already filed stay where they are.');
    confirm.querySelector<HTMLButtonElement>('.btn-danger')!.click();
    expect(sent).toEqual([{ kind: 'known.automation.browser.remove', id: 'b-1' }]);
  });
});

describe('next to the account’s rules (AW-69)', () => {
  const account = (kind: 'duplicate' | 'conflict', reviewed = false, pages = 37) => ({ kind, pages, reviewed, reviewKey: '4:1',
    rule: { id: 'rule-arxiv', name: 'arXiv papers', folder: 'Academic', match: { combinator: 'all' as const, conditions: [{ kind: 'siteIs' as const, value: 'arxiv.org' }] } } });
  const signedIn = () => view({ account: 'signedIn', state: 'active', webUrl: 'https://colp.example/automations', browserRules: [
    rule({ account: account('conflict') }), rule({ id: 'b-2', name: 'Same papers', account: account('duplicate', false, 0) }),
    rule({ id: 'b-3', name: 'Kept papers', account: account('conflict', true, 0) })] });

  it('says once what has not been looked at, and on each row which account rule it meets', async () => {
    const group = (await render(signedIn())).querySelector('[aria-labelledby="automation-browser-heading"]')!;
    expect(text(group.querySelector('.inline-alert'))).toBe('2 of your browser rules overlap your account’s rules.Review');
    const rows = Array.from(group.querySelectorAll('.automation-browser-rule'));
    expect(rows.map((row) => text(row.querySelector('.badge')))).toEqual(['Overlaps', 'Same as account', '']);
    expect(rows.map((row) => text(row.querySelector('.automation-overlap')))).toEqual([
      'Your account’s rule “arXiv papers” files these in Academic first. 37 of your bookmarks match both.',
      'Your account’s rule “arXiv papers” does the same.', 'Your account’s rule “arXiv papers” files these in Academic first.']);
    expect(rows.map((row) => row.querySelector<HTMLElement>('.automation-overlap')!.dataset.tone)).toEqual(['warning', undefined, undefined]);
  });

  it('settles each overlap in the review: keep both, use the account’s, or remove a duplicate', async () => {
    const body = await render(signedIn());
    body.querySelector<HTMLButtonElement>('.automation-browser .inline-alert button')!.click();
    const dialog = document.querySelector<HTMLDialogElement>('dialog.automation-review')!;
    const items = Array.from(dialog.querySelectorAll('.automation-review-item'));
    expect(items.map((item) => text(item.querySelector('.automation-review-name')))).toEqual(['Papers from arXiv', 'Same papers']);
    expect(text(items[0]!.querySelector('dl'))).toBe('This browserPapers from arXiv: From arxiv.org → PapersYour accountarXiv papers: From arxiv.org → Academic');
    expect(text(items[0]!.querySelector('.mgr-hint'))).toBe('37 of your bookmarks match both.');
    Array.from(items[0]!.querySelectorAll('button')).find((node) => node.textContent === 'Keep both')!.click();
    expect(sent).toEqual([{ kind: 'known.automation.browser.review', id: 'b-1', accountRuleId: 'rule-arxiv', key: '4:1' }]);
    await vi.waitFor(() => expect(text(items[0]!.querySelector('.automation-review-done'))).toBe('Kept both. This rule files what the account’s doesn’t match.'));
    Array.from(items[1]!.querySelectorAll('button')).find((node) => node.textContent === 'Remove mine')!.click();
    expect(sent[1]).toEqual({ kind: 'known.automation.browser.remove', id: 'b-2' });
    await vi.waitFor(() => expect(text(items[1]!.querySelector('.automation-review-done'))).toBe('Removed this rule.'));
  });

  it('switches the browser rule off for “Use the account’s”, and keeps the choice open if that fails', async () => {
    reply = () => ({ ok: false, error: 'unavailable' });
    const body = await render(signedIn());
    body.querySelector<HTMLButtonElement>('.automation-browser .inline-alert button')!.click();
    const item = document.querySelector('dialog.automation-review .automation-review-item')!;
    const use = Array.from(item.querySelectorAll('button')).find((node) => node.textContent === 'Use the account’s')!;
    use.click();
    expect(sent).toEqual([{ kind: 'known.automation.browser.enable', id: 'b-1', enabled: false }]);
    await vi.waitFor(() => expect(use.disabled).toBe(false));
    expect(item.querySelector('.automation-review-done')).toBeNull();
  });
});

describe('moving a rule to the account (AW-71)', () => {
  const url = 'https://colp.example/automations/new?collectionId=c&folderId=n&from=browser';
  const signedIn = (rules: BrowserRuleView[]) => view({ account: 'signedIn', state: 'active', webUrl: 'https://colp.example/automations', browserRules: rules });

  it('opens the filled-in web editor from the row and marks the rule as moving', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    const body = await render(signedIn([rule({ move: { url } })]));
    body.querySelector<HTMLButtonElement>('.automation-browser-rule button[aria-label="Add to your account"]')!.click();
    expect(open).toHaveBeenCalledWith(url, '_blank', 'noopener');
    expect(sent).toEqual([{ kind: 'known.automation.browser.moving', id: 'b-1' }]);
  });

  it('says a moving rule still files until the account’s copy arrives, and a rule with an unsynced folder stays here', async () => {
    const body = await render(signedIn([rule({ moving: true, move: { url } }), rule({ id: 'b-2', name: 'Local', localOnly: true })]));
    const rows = Array.from(body.querySelectorAll('.automation-browser-rule'));
    expect(text(rows[0]!.querySelector('.badge'))).toBe('Moving');
    expect(text(rows[0]!.querySelector('.automation-overlap'))).toBe('Waiting for your account’s copy. Until it arrives, this browser keeps using this one.');
    expect(rows[0]!.querySelector('button[aria-label="Add to your account"]')).toBeNull();
    expect(text(rows[1]!.querySelector('.automation-overlap'))).toBe('Only in this browser: its folder isn’t synced.');
    expect(rows[1]!.querySelector('button[aria-label="Add to your account"]')).toBeNull();
  });

  it('offers Add mine to the account in the review for a conflict whose folder is synced', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    const conflict = { kind: 'conflict' as const, pages: 3, reviewed: false, reviewKey: '4:1',
      rule: { id: 'rule-arxiv', name: 'arXiv papers', folder: 'Academic', match: null } };
    const body = await render(signedIn([rule({ account: conflict, move: { url } })]));
    body.querySelector<HTMLButtonElement>('.automation-browser .inline-alert button')!.click();
    const item = document.querySelector('dialog.automation-review .automation-review-item')!;
    Array.from(item.querySelectorAll('button')).find((node) => node.textContent === 'Add mine to the account')!.click();
    expect(open).toHaveBeenCalledWith(url, '_blank', 'noopener');
    expect(sent).toEqual([{ kind: 'known.automation.browser.moving', id: 'b-1' }]);
    await vi.waitFor(() => expect(text(item.querySelector('.automation-review-done')))
      .toBe('Opened on the web. Preview it there and turn it on; this browser then stops using its copy.'));
  });
});

describe('one New rule for both kinds (U2)', () => {
  const signedIn = (over: Partial<AutomationStateView> = {}) => view({ account: 'signedIn', state: 'active', webUrl: 'https://colp.example/automations', ...over });
  const useOn = () => Array.from(editor().querySelectorAll<HTMLInputElement>('.automation-use-on input[type="radio"]'));
  const fill = async () => {
    editor().querySelector<HTMLInputElement>('.automation-condition input')!.value = 'arxiv.org';
    editor().querySelector<HTMLButtonElement>('.folder-pill')!.click();
    await vi.waitFor(() => expect(editor().querySelector('.folder-opt[data-folder-id="f-papers"]')).not.toBeNull());
    editor().querySelector<HTMLElement>('.folder-opt[data-folder-id="f-papers"]')!.click();
  };

  it('asks where the rule is used when signed in, starting with this browser', async () => {
    await render(signedIn());
    document.querySelector<HTMLButtonElement>('[data-automations-new]')!.click();
    expect(text(editor().querySelector('h3'))).toBe('New rule');
    expect(useOn().map((input) => [input.value, input.checked])).toEqual([['browser', true], ['account', false]]);
    expect(text(editor().querySelector('button[type="submit"]'))).toBe('Save rule');
    useOn()[1]!.click();
    expect(text(editor().querySelector('button[type="submit"]'))).toBe('Continue on the web');
    expect(text(editor().querySelector('.mgr-hint'))).toBe('The web editor opens filled in with this rule. Nothing changes until you turn it on there.');
  });

  it('does not ask when signed out, or when editing this browser’s rule', async () => {
    await render(view());
    document.querySelector<HTMLButtonElement>('[data-automations-new]')!.click();
    expect(editor().querySelector<HTMLElement>('.automation-use-on')!.hidden).toBe(true);
    expect(text(editor().querySelector('h3'))).toBe('New rule in this browser');
    editor().close();
    await render(signedIn());
    document.querySelector<HTMLElement>('.automation-browser-rule .list-row-title')!.click();
    expect(editor().querySelector<HTMLElement>('.automation-use-on')!.hidden).toBe(true);
  });

  it('opens the web editor filled in for all devices, and stores nothing here', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    reply = (message) => message.kind === 'known.automation.browser.forAccount' ? { ok: true, url: 'https://colp.example/automations/new?from=browser' } : { ok: true, rule: null };
    await render(signedIn());
    document.querySelector<HTMLButtonElement>('[data-automations-new]')!.click();
    useOn()[1]!.click();
    await fill();
    submit();
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith('https://colp.example/automations/new?from=browser', '_blank', 'noopener'));
    expect(sent).toEqual([{ kind: 'known.automation.browser.forAccount',
      draft: { name: 'arxiv.org → Papers', combinator: 'all', folderNativeId: 'f-papers', conditions: [{ kind: 'siteIs', value: 'arxiv.org' }] } }]);
    expect(document.querySelector('dialog.automation-rule-editor')).toBeNull();
    expect(text(document.querySelector('.toast'))).toContain('Finish on the web: preview the rule and turn it on.');
  });

  it('says so on the folder when it is not synced', async () => {
    reply = () => ({ ok: false, error: 'notSynced' });
    await render(signedIn());
    document.querySelector<HTMLButtonElement>('[data-automations-new]')!.click();
    useOn()[1]!.click();
    await fill();
    submit();
    await vi.waitFor(() => expect(text(editor().querySelector('.form-field .form-error:not([hidden])'))).toBe(
      'This folder isn’t synced, so your other devices don’t have it. Choose a synced folder, or use the rule in this browser.'));
  });

  it('starts at all devices from the account’s empty section', async () => {
    const body = await render(signedIn({ state: 'none' }));
    body.querySelector<HTMLButtonElement>('[aria-labelledby="automation-rules-heading"] .empty button')!.click();
    expect(useOn().map((input) => input.checked)).toEqual([false, true]);
    expect(text(editor().querySelector('button[type="submit"]'))).toBe('Continue on the web');
  });
});

describe('how a page you save finds its folder (U3)', () => {
  const steps = (body: HTMLElement) => Array.from(body.querySelectorAll('.automation-flow-step')).map((step) =>
    [text(step.querySelector('.automation-flow-name')), text(step.querySelector('.automation-flow-state'))]);

  it('shows the five steps in order, with what each does here now', async () => {
    const body = await render(view({ account: 'signedIn', state: 'active', webUrl: 'https://colp.example/automations',
      rules: [{ id: 'rule-arxiv', name: 'arXiv papers', folder: 'Academic', resolved: true, match: null }],
      saving: { mode: 'automatic', ai: 'own', suggestInForm: false } }));
    expect(text(body.querySelector('#automation-flow-heading'))).toBe('How a page you save finds its folder');
    expect(steps(body)).toEqual([['A folder you pick', 'Always wins'], ['Your account’s rules', '1 on'],
      ['Rules in this browser', '1 on'], ['AI', 'Your AI service picks one'], ['Otherwise', 'Stays where you saved it']]);
  });

  it('says what is off, paused or left to the form, and links to where it is set up', async () => {
    let body = await render(view({ saving: { mode: 'automatic', ai: null, suggestInForm: false }, browserRules: [] }));
    expect(steps(body).slice(1, 4)).toEqual([['Your account’s rules', 'Sign in to use them'], ['Rules in this browser', 'None yet'], ['AI', 'Off · Set up']]);
    expect(body.querySelector<HTMLAnchorElement>('.automation-flow-state a')!.getAttribute('href')).toBe('#ai');
    body = await render(view({ account: 'signedIn', state: 'paused', webUrl: 'https://colp.example/automations',
      saving: { mode: 'manual', ai: 'own', suggestInForm: true } }));
    expect(steps(body).slice(1, 4)).toEqual([['Your account’s rules', 'Paused'], ['Rules in this browser', 'Paused'],
      ['AI', 'Suggests in the form · Manual mode']]);
    body = await render(view({ saving: { mode: 'manual', ai: null, suggestInForm: true },
      browserRules: [rule({ enabled: false })] }));
    expect(steps(body).slice(2, 4)).toEqual([['Rules in this browser', 'All off'], ['AI', 'You choose in the form · Manual mode']]);
  });
});

describe('a move the account has not finished (U5)', () => {
  it('says so after a day, with the web editor and Keep in this browser', async () => {
    const body = await render(view({ account: 'signedIn', state: 'active', webUrl: 'https://colp.example/automations',
      browserRules: [rule({ moving: true, movingStale: true, move: { url: 'https://colp.example/automations/new?from=browser' } })] }));
    const row = body.querySelector('.automation-browser-rule')!;
    expect(text(row.querySelector('.badge'))).toBe('Not on yet');
    expect(text(row.querySelector('.automation-overlap[data-tone="warning"]'))).toBe('Your account doesn’t have it yet. Turn it on on the web, or keep it in this browser.');
    expect(row.querySelector<HTMLAnchorElement>('.automation-stale-actions a')!.href).toBe('https://colp.example/automations/new?from=browser');
    row.querySelector<HTMLButtonElement>('.automation-stale-actions button')!.click();
    await vi.waitFor(() => expect(sent).toEqual([{ kind: 'known.automation.browser.stay', id: 'b-1' }]));
    await vi.waitFor(() => expect(text(document.querySelector('.toast'))).toContain('“Papers from arXiv” stays in this browser.'));
    // The row's own controls never open the editor.
    expect(document.querySelector('dialog.automation-rule-editor')).toBeNull();
  });

  it('still says Moving within the first day', async () => {
    const body = await render(view({ account: 'signedIn', state: 'active', webUrl: 'https://colp.example/automations',
      browserRules: [rule({ moving: true })] }));
    expect(text(body.querySelector('.automation-browser-rule .badge'))).toBe('Moving');
    expect(body.querySelector('.automation-stale-actions')).toBeNull();
  });
});

import type { Predicate, RuleDefinition } from '@know-n/colp/automation';
import { describe, expect, it } from 'vitest';
import { relateBrowserRule, replayOverlap, sameMatch, witnessOverlap, type OverlapRule } from '../src/automation/browser-overlap.js';
import { checkRuleDraft, type RuleDraft } from '../src/automation/rule-conditions.js';
import { compiledRule, NOW } from './automation-fixture.js';

/** AW-69: where a browser rule and an account rule can take the same page, proven by a page or counted on real ones. */
function browser(id: string, conditions: RuleDraft['conditions'], folderNativeId = '30', combinator: 'all' | 'any' = 'all'): OverlapRule {
  const checked = checkRuleDraft({ name: id, combinator, conditions, action: { kind: 'file', folderNativeId } });
  if (!checked.ok) throw new Error('invalid draft');
  return { id, definition: checked.definition, folderNativeId };
}
function account(id: string, match: Predicate, folderNativeId: string | null = '10'): OverlapRule {
  return { id, definition: compiledRule({ ruleId: id, definition: { match } as Partial<RuleDefinition> }).definition, folderNativeId };
}
const site = (value: string): Predicate => ({ kind: 'field', field: 'bookmark.url.host', op: 'eq', value });
const title = (value: string): Predicate => ({ kind: 'field', field: 'bookmark.title', op: 'contains', value });
const def = (rule: OverlapRule) => rule.definition;

describe('a witness page', () => {
  it('is found from the rules’ own values when one page fits both', () => {
    expect(witnessOverlap(def(browser('b', [{ kind: 'siteIs', value: 'arxiv.org' }])), def(account('a', site('arxiv.org'))), NOW))
      .toEqual({ url: 'https://arxiv.org/', title: '' });
    // A site and its parent domain.
    expect(witnessOverlap(def(browser('b', [{ kind: 'siteEndsWith', value: 'github.com' }])), def(account('a', site('gist.github.com'))), NOW))
      .toMatchObject({ url: 'https://gist.github.com/' });
    // Conditions on different fields meet on one page.
    expect(witnessOverlap(def(browser('b', [{ kind: 'titleContains', value: 'Paper' }])), def(account('a', site('arxiv.org'))), NOW))
      .toEqual({ url: 'https://arxiv.org/', title: 'Paper' });
    // A path inside another path.
    expect(witnessOverlap(def(browser('b', [{ kind: 'pathStartsWith', value: '/abs/2410' }])),
      def(account('a', { kind: 'field', field: 'bookmark.url.path', op: 'startsWith', value: '/abs/' })), NOW)).toMatchObject({ url: 'https://witness.invalid/abs/2410' });
  });

  it('is not found when the rules ask for different sites, or one needs what the other excludes', () => {
    expect(witnessOverlap(def(browser('b', [{ kind: 'siteIs', value: 'arxiv.org' }])), def(account('a', site('github.com'))), NOW)).toBeNull();
    expect(witnessOverlap(def(browser('b', [{ kind: 'siteIs', value: 'arxiv.org' }, { kind: 'titleContains', value: 'Paper' }])),
      def(account('a', { kind: 'all', items: [site('arxiv.org'), { kind: 'not', item: title('Paper') }] })), NOW)).toBeNull();
    // Tags are written after the save, so a tag rule never shares a page at intake.
    expect(witnessOverlap(def(browser('b', [{ kind: 'siteIs', value: 'arxiv.org' }])),
      def(account('a', { kind: 'all', items: [site('arxiv.org'), { kind: 'field', field: 'bookmark.tags', op: 'hasTag', value: 'paper' }] })), NOW)).toBeNull();
  });

  it('tries each side of an “any” rule', () => {
    expect(witnessOverlap(def(browser('b', [{ kind: 'siteIs', value: 'moz.com' }, { kind: 'siteIs', value: 'arxiv.org' }], '30', 'any')),
      def(account('a', site('arxiv.org'))), NOW)).toMatchObject({ url: 'https://arxiv.org/' });
  });
});

describe('the same conditions', () => {
  it('ignore the order of a group but not its kind or values', () => {
    expect(sameMatch({ kind: 'all', items: [site('arxiv.org'), title('Paper')] }, { kind: 'all', items: [title('Paper'), site('arxiv.org')] })).toBe(true);
    expect(sameMatch({ kind: 'all', items: [site('arxiv.org')] }, site('arxiv.org'))).toBe(true);
    expect(sameMatch({ kind: 'all', items: [site('arxiv.org'), title('Paper')] }, { kind: 'any', items: [site('arxiv.org'), title('Paper')] })).toBe(false);
    expect(sameMatch(site('arxiv.org'), site('github.com'))).toBe(false);
  });

  it('ignore the order of keys, as the server writes them', () => {
    const server = JSON.parse('{"op":"eq","kind":"field","field":"bookmark.url.host","value":"arxiv.org"}') as Predicate;
    expect(sameMatch(server, site('arxiv.org'))).toBe(true);
    expect(sameMatch({ kind: 'any', items: [server, title('Paper')] }, { items: [title('Paper'), site('arxiv.org')], kind: 'any' } as Predicate)).toBe(true);
    expect(relateBrowserRule(browser('b', [{ kind: 'siteIs', value: 'arxiv.org' }], '10'),
      [account('a', server, '10')], undefined, NOW)).toEqual({ kind: 'duplicate', accountRuleId: 'a', pages: 0 });
  });
});

describe('replay over this browser’s bookmarks', () => {
  it('counts the pages each pair of rules both match', () => {
    const pages = [{ url: 'https://arxiv.org/abs/1', title: 'A paper' }, { url: 'https://arxiv.org/abs/2', title: 'Notes' },
      { url: 'https://github.com/know-n', title: 'A paper about code' }, { url: 'not a url', title: 'paper' }];
    const counts = replayOverlap([browser('b-site', [{ kind: 'siteIs', value: 'arxiv.org' }]), browser('b-title', [{ kind: 'titleContains', value: 'paper' }])],
      [account('a-arxiv', site('arxiv.org')), account('a-code', site('github.com'))], pages, NOW);
    expect(Object.fromEntries([...counts].map(([id, row]) => [id, Object.fromEntries(row)])))
      .toEqual({ 'b-site': { 'a-arxiv': 2 }, 'b-title': { 'a-arxiv': 1, 'a-code': 1 } });
    expect(replayOverlap([browser('b', [{ kind: 'siteIs', value: 'arxiv.org' }])], [], pages, NOW).size).toBe(0);
  });
});

describe('a browser rule next to the account’s rules', () => {
  const mine = browser('b', [{ kind: 'siteIs', value: 'arxiv.org' }], '30');

  it('is a duplicate when the conditions and the folder here are the same', () => {
    expect(relateBrowserRule(browser('b', [{ kind: 'siteIs', value: 'ArXiv.org' }], '10'), [account('a', site('arxiv.org'), '10')], undefined, NOW))
      .toEqual({ kind: 'duplicate', accountRuleId: 'a', pages: 0 });
  });

  it('is a conflict when the account files its pages elsewhere first, or into a folder not here', () => {
    expect(relateBrowserRule(mine, [account('a', site('arxiv.org'), '10')], undefined, NOW)).toEqual({ kind: 'conflict', accountRuleId: 'a', pages: 0 });
    expect(relateBrowserRule(mine, [account('a', site('arxiv.org'), null)], new Map([['a', 4]]), NOW)).toEqual({ kind: 'conflict', accountRuleId: 'a', pages: 4 });
  });

  it('shows the conflict that takes the most pages, and a duplicate before any conflict', () => {
    const many = [account('a-1', { kind: 'field', field: 'bookmark.url.host', op: 'hostSuffix', value: 'org' }, '11'), account('a-2', site('arxiv.org'), '12')];
    expect(relateBrowserRule(mine, many, new Map([['a-1', 2], ['a-2', 9]]), NOW)).toMatchObject({ accountRuleId: 'a-2', pages: 9 });
    expect(relateBrowserRule(mine, [...many, account('a-3', site('arxiv.org'), '30')], new Map([['a-2', 9]]), NOW))
      .toMatchObject({ kind: 'duplicate', accountRuleId: 'a-3' });
  });

  it('is nothing when no page is shared, or when shared pages land in the same folder anyway', () => {
    expect(relateBrowserRule(mine, [account('a', site('github.com'), '10')], undefined, NOW)).toBeNull();
    expect(relateBrowserRule(mine, [account('a', { kind: 'all', items: [site('arxiv.org'), title('Paper')] }, '30')], undefined, NOW)).toBeNull();
  });
});

import { compilePredicate, validateM1Rule } from '@know-n/colp/automation';
import { describe, expect, it } from 'vitest';
import { checkRuleDraft, conditionPredicate, ruleDefinition, type RuleDraft } from '../src/automation/rule-conditions.js';
import { preSaveFacts } from '../src/automation/pre-save.js';
import { NOW } from './automation-fixture.js';

/** Doc 17 R5, RS-09, RS-11: what the editor writes is the truth, compiled to operators the shared core already has. */
type Draft = Partial<RuleDraft> & { readonly folderNativeId?: string };
const draft = ({ folderNativeId = '30', ...over }: Draft = {}): RuleDraft =>
  ({ name: 'Papers from arXiv', combinator: 'all', conditions: [{ kind: 'siteIs', value: 'arxiv.org' }], action: { kind: 'file', folderNativeId }, ...over });

const matches = (condition: Parameters<typeof conditionPredicate>[0], url: string, title = 'A page') => {
  const compiled = compilePredicate(conditionPredicate(condition));
  if (!compiled.valid) throw new Error('invalid predicate');
  return compiled.evaluate(preSaveFacts({ url, title }, 'browser', { ancestors: [] }, 'userDefault', NOW)).outcome;
};

describe('a draft becomes a stored rule', () => {
  it('is the M1 placement definition with no collection, normalized the way the evaluator compares', () => {
    const checked = checkRuleDraft(draft({ conditions: [{ kind: 'siteIs', value: ' ArXiv.org ' }] }));
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(validateM1Rule(checked.definition)).toEqual([]);
    expect(checked.conditions).toEqual([{ kind: 'siteIs', value: 'ArXiv.org' }]);
    expect(checked.definition).toMatchObject({ name: 'Papers from arXiv', scope: {}, on: 'bookmark.intake', tasks: [], priority: 100,
      match: { kind: 'field', field: 'bookmark.url.host', op: 'eq', value: 'arxiv.org' }, intake: { folderRole: 'destination' } });
  });

  it('takes a pasted link for its site or its path, and names an unnamed rule after its first value', () => {
    const checked = checkRuleDraft(draft({ name: '  ', conditions: [{ kind: 'siteEndsWith', value: 'https://Docs.GitHub.com/en/actions' },
      { kind: 'pathStartsWith', value: 'https://github.com/know-n/colp' }] }));
    expect(checked.ok && checked.conditions).toEqual([{ kind: 'siteEndsWith', value: 'docs.github.com' }, { kind: 'pathStartsWith', value: '/know-n/colp' }]);
    expect(checked.ok && checked.definition).toMatchObject({ name: 'docs.github.com', match: { kind: 'all', items: [{ op: 'hostSuffix', value: 'docs.github.com' },
      { op: 'startsWith', value: '/know-n/colp' }] } });
  });

  it('joins several conditions with all or any and drops empty rows', () => {
    const definition = ruleDefinition('Rule', 'any', [{ kind: 'titleContains', value: 'Paper' }, { kind: 'siteIs', value: '' },
      { kind: 'pathStartsWith', value: '/abs/' }]);
    expect(definition.match).toEqual({ kind: 'any', items: [{ kind: 'field', field: 'bookmark.title', op: 'contains', value: 'Paper' },
      { kind: 'field', field: 'bookmark.url.path', op: 'startsWith', value: '/abs/' }] });
  });

  it('says what the editor should point at', () => {
    expect(checkRuleDraft(draft({ conditions: [{ kind: 'siteIs', value: '  ' }], folderNativeId: '' }))).toEqual({ ok: false,
      problems: [{ field: 'conditions', code: 'required' }, { field: 'folder', code: 'required' }] });
    expect(checkRuleDraft(draft({ conditions: [{ kind: 'titleContains', value: 'ok' }, { kind: 'siteIs', value: 'not a host' }] }))).toEqual({ ok: false,
      problems: [{ field: 'condition', index: 1, code: 'invalidHost' }] });
    expect(checkRuleDraft(draft({ conditions: Array.from({ length: 9 }, (_, index) => ({ kind: 'titleContains' as const, value: `w${index}` })) })))
      .toMatchObject({ ok: false, problems: [{ field: 'conditions', code: 'tooMany' }] });
    expect(checkRuleDraft(draft({ name: 'x'.repeat(201) }))).toMatchObject({ ok: false, problems: [{ field: 'name', code: 'tooLong' }] });
    expect(checkRuleDraft(draft({ conditions: [{ kind: 'titleContains', value: 'x'.repeat(513) }] })))
      .toMatchObject({ ok: false, problems: [{ field: 'condition', index: 0, code: 'tooLong' }] });
    expect(checkRuleDraft(draft({ conditions: [{ kind: 'hasTag' as never, value: 'research' }] })))
      .toMatchObject({ ok: false, problems: [{ field: 'condition', index: 0, code: 'kind' }] });
  });

  it('needs no folder to keep a page where it was saved', () => {
    expect(checkRuleDraft({ ...draft(), action: { kind: 'keepHere' } })).toMatchObject({ ok: true });
  });
});

describe('what each kind matches', () => {
  it('a site exactly, or with its subdomains on a dot boundary (RS-09.1)', () => {
    expect(matches({ kind: 'siteIs', value: 'arxiv.org' }, 'https://arxiv.org/abs/1')).toBe('matched');
    expect(matches({ kind: 'siteIs', value: 'arxiv.org' }, 'https://export.arxiv.org/abs/1')).toBe('notMatched');
    expect(matches({ kind: 'siteEndsWith', value: 'arxiv.org' }, 'https://export.arxiv.org/abs/1')).toBe('matched');
    expect(matches({ kind: 'siteEndsWith', value: 'arxiv.org' }, 'https://arxiv.org.evil.example/abs/1')).toBe('notMatched');
    expect(matches({ kind: 'siteEndsWith', value: 'arxiv.org' }, 'https://notarxiv.org/')).toBe('notMatched');
  });

  it('a path and what is under it, never a sibling that shares its letters (RS-11.2)', () => {
    for (const value of ['/team', '/team/', 'team', 'https://example.org/team/']) {
      expect(conditionPredicate({ kind: 'pathUnder', value })).toEqual({ kind: 'any', items: [
        { kind: 'field', field: 'bookmark.url.path', op: 'eq', value: '/team' },
        { kind: 'field', field: 'bookmark.url.path', op: 'startsWith', value: '/team/' }] });
    }
    expect(matches({ kind: 'pathUnder', value: '/team' }, 'https://example.org/team')).toBe('matched');
    expect(matches({ kind: 'pathUnder', value: '/team' }, 'https://example.org/team/x')).toBe('matched');
    expect(matches({ kind: 'pathUnder', value: '/team' }, 'https://example.org/team-other')).toBe('notMatched');
    expect(matches({ kind: 'pathStartsWith', value: '/team' }, 'https://example.org/team-other')).toBe('matched');
    expect(conditionPredicate({ kind: 'pathUnder', value: '/' })).toEqual({ kind: 'field', field: 'bookmark.url.path', op: 'startsWith', value: '/' });
  });

  it('no site or path for a link that has none, while its title still counts (RS-11.5)', () => {
    expect(matches({ kind: 'siteIs', value: 'example.org' }, 'file:///home/notes.html')).toBe('missingInput');
    expect(matches({ kind: 'pathUnder', value: '/home' }, 'file:///home/notes.html')).toBe('missingInput');
    expect(matches({ kind: 'titleContains', value: 'Notes' }, 'file:///home/notes.html', 'Notes')).toBe('matched');
    // An address by number is a host like any other.
    expect(matches({ kind: 'siteIs', value: '10.0.0.1' }, 'http://10.0.0.1/admin')).toBe('matched');
    expect(matches({ kind: 'siteEndsWith', value: 'example.org' }, 'http://10.0.0.1/admin')).toBe('notMatched');
  });

  it('two hosts that only look alike are two hosts (RS-09.4)', () => {
    const cyrillic = 'раураl.com';
    expect(matches({ kind: 'siteIs', value: 'paypal.com' }, `https://${cyrillic}/`)).toBe('notMatched');
    expect(matches({ kind: 'siteEndsWith', value: cyrillic }, 'https://paypal.com/')).toBe('notMatched');
    expect(matches({ kind: 'siteIs', value: cyrillic }, `https://${cyrillic}/`)).toBe('matched');
  });
});

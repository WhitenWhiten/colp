import { describe, expect, it } from 'vitest';
import { ruleMatchView } from '../src/automation/rule-match.js';

/** Options says a rule's conditions in the web editor's words, and only the shapes that editor writes. */
describe('ruleMatchView', () => {
  it('reads the web editor’s five condition shapes, alone or grouped', () => {
    expect(ruleMatchView({ kind: 'field', field: 'bookmark.url.host', op: 'eq', value: 'arxiv.org' }))
      .toEqual({ combinator: 'all', conditions: [{ kind: 'siteIs', value: 'arxiv.org' }] });
    expect(ruleMatchView({ kind: 'any', items: [
      { kind: 'field', field: 'bookmark.url.host', op: 'hostSuffix', value: 'github.com' },
      { kind: 'field', field: 'bookmark.title', op: 'contains', value: 'Paper' },
      { kind: 'field', field: 'bookmark.tags', op: 'hasTag', value: 'research' },
      { kind: 'field', field: 'bookmark.url.path', op: 'startsWith', value: '/abs/' },
    ] })).toEqual({ combinator: 'any', conditions: [
      { kind: 'siteEndsWith', value: 'github.com' }, { kind: 'titleContains', value: 'Paper' },
      { kind: 'hasTag', value: 'research' }, { kind: 'pathStartsWith', value: '/abs/' },
    ] });
  });

  it('has no short form for anything else', () => {
    expect(ruleMatchView({ kind: 'field', field: 'bookmark.url.host', op: 'in', value: ['a.example', 'b.example'] })).toBeNull();
    expect(ruleMatchView({ kind: 'not', item: { kind: 'field', field: 'bookmark.url.host', op: 'eq', value: 'a.example' } })).toBeNull();
    expect(ruleMatchView({ kind: 'all', items: [
      { kind: 'field', field: 'bookmark.url.host', op: 'eq', value: 'a.example' },
      { kind: 'any', items: [] },
    ] })).toBeNull();
    expect(ruleMatchView({ kind: 'all', items: [] })).toBeNull();
  });
});

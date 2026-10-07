import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'vitest';
import {
  bookmarkTokenSet,
  folderTokenSet,
  hostTokens,
  isInboxFolderTitle,
  jaccard,
  normalizeInboxTitle,
  suggestFolderTitle,
  tokenizeTitle,
} from '../../../src/modules/collections/application/organize-planner-tokens.js';

const APPLICATION_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../src/modules/collections/application',
);

describe('inbox title normalization', () => {
  test('Reading later and reading   later hit the same closed inbox set', () => {
    assert.equal(normalizeInboxTitle('Reading later'), 'reading later');
    assert.equal(normalizeInboxTitle('reading   later'), 'reading later');
    assert.equal(isInboxFolderTitle('Reading later'), true);
    assert.equal(isInboxFolderTitle('reading   later'), true);
  });

  test('standalone later and Later do not match the inbox set', () => {
    assert.equal(isInboxFolderTitle('later'), false);
    assert.equal(isInboxFolderTitle('Later'), false);
  });

  test('closed inbox titles match after NFKC, Unicode lowercase, and trim', () => {
    assert.equal(isInboxFolderTitle('Unsorted'), true);
    assert.equal(isInboxFolderTitle('  INBOX  '), true);
    assert.equal(isInboxFolderTitle('Uncategorized'), true);
    assert.equal(isInboxFolderTitle('Read later'), true);
    assert.equal(isInboxFolderTitle('未分类'), true);
    assert.equal(isInboxFolderTitle('未整理'), true);
    assert.equal(isInboxFolderTitle('稍后读'), true);
    assert.equal(isInboxFolderTitle('稍后再读'), true);
    assert.equal(isInboxFolderTitle('Ｉｎｂｏｘ'), true);
  });
});

describe('tokenizeTitle', () => {
  test('NFKC-lowercases, splits on non letter-or-number, drops short tokens and stopwords', () => {
    assert.deepEqual(
      [...tokenizeTitle('The Design and Systems for https://www.Example.COM')],
      ['design', 'systems', 'example'],
    );
    assert.deepEqual([...tokenizeTitle('a I 系统')], ['系统']);
  });
});

describe('hostTokens', () => {
  test('illegal URL does not throw and host tokens are empty', () => {
    assert.deepEqual(hostTokens('not a url'), []);
    assert.deepEqual(hostTokens(''), []);
    assert.deepEqual(hostTokens('http://'), []);
    assert.doesNotThrow(() => hostTokens('://broken'));
    assert.deepEqual(hostTokens('://broken'), []);
  });

  test('uses hostname only, drops www, and does not emit userinfo', () => {
    assert.deepEqual(hostTokens('https://www.GitHub.com/org/repo'), ['github']);
    const withUserinfo = hostTokens('https://alice:secret@example.org/path');
    assert.ok(!withUserinfo.includes('alice'));
    assert.ok(!withUserinfo.includes('secret'));
    assert.deepEqual(withUserinfo, ['example']);
  });
});

describe('jaccard', () => {
  test('Design systems vs Spacing as a system produces a repeatable Jaccard > 0', () => {
    const left = bookmarkTokenSet({ title: 'Design systems', url: 'https://example.com/x' });
    const right = folderTokenSet('Spacing as a system');
    const first = jaccard(left, right);
    const second = jaccard(left, right);
    assert.equal(first, second);
    assert.ok(Number.isInteger(first));
    assert.ok(first > 0);
    assert.ok(first <= 100);
  });

  test('empty union is 0 and identical sets are 100', () => {
    assert.equal(jaccard(new Set(), new Set()), 0);
    assert.equal(jaccard(new Set(['design']), new Set(['design'])), 100);
  });
});

describe('suggestFolderTitle', () => {
  test('ranks cluster tokens by document frequency, Title Cases at most three, and is stable', () => {
    const bookmarks = [
      { id: 'b2', title: 'React query docs', url: 'https://react.dev/query' },
      { id: 'b1', title: 'React query guide', url: 'https://react.dev/guide' },
      { id: 'b3', title: 'React handbook', url: 'https://react.dev/book' },
    ];
    const tokens = new Set(['react', 'query', 'docs', 'guide', 'handbook']);
    const title = suggestFolderTitle(tokens, bookmarks);
    assert.equal(title, 'React Query Docs');
    assert.equal(suggestFolderTitle(tokens, bookmarks), title);
    assert.ok(!/^https?:/iu.test(title));
  });

  test('falls back to Cluster plus shortest bookmark id when empty or inbox-normalized', () => {
    const bookmarks = [
      { id: 'deadbeef99', title: 'later', url: 'https://example.com/a' },
      { id: 'abc123', title: 'later', url: 'https://example.com/b' },
    ];
    const inboxTitle = suggestFolderTitle(new Set(['reading', 'later']), [
      { id: 'ffffff', title: 'Reading later list', url: 'https://example.com/r' },
    ]);
    assert.match(inboxTitle, /^Cluster[0-9a-f]{6}$/u);
    assert.equal(inboxTitle, 'Clusterffffff');

    const emptyTitle = suggestFolderTitle(new Set(), bookmarks);
    assert.equal(emptyTitle, 'Clusterabc123');

    const nonHex = suggestFolderTitle(new Set(), [
      { id: 'zz-node', title: 'Alpha', url: 'https://example.com/z' },
    ]);
    assert.equal(nonHex, 'Clusterzz-nod');
  });

  test('never uses a full URL as the suggested title', () => {
    const url = 'https://evil.example/full';
    const title = suggestFolderTitle(new Set([url]), [
      { id: 'abcdef', title: url, url },
    ]);
    assert.notEqual(title, url);
    assert.ok(!title.includes('://'));
    assert.match(title, /^Clusterabcdef$/u);
  });
});

describe('deterministic sources', () => {
  test('organize planner sources do not use Math.random', () => {
    const tokens = readFileSync(join(APPLICATION_DIR, 'organize-planner-tokens.ts'), 'utf8');
    const planner = readFileSync(join(APPLICATION_DIR, 'organize-planner.ts'), 'utf8');
    assert.doesNotMatch(tokens, /Math\.random/);
    assert.doesNotMatch(planner, /Math\.random/);
  });
});

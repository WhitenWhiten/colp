import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  scoreClassifyInboxSuggestions,
  type ClassifyInboxScoreInput,
} from '../../../src/modules/collections/application/classify-inbox-score.js';
import {
  buildClassifyInboxFixture,
  toScoreInput,
} from '../../support/classify-inbox-fixtures.js';

function score(input: ClassifyInboxScoreInput) {
  return scoreClassifyInboxSuggestions(input);
}

test('no token overlap returns an empty suggestion list', () => {
  const suggestions = score({
    bookmark: { title: 'Zebra quilt', url: 'https://unrelated.example.org/notes' },
    candidateFolders: [
      { folderId: 'fld-kitchen', folderTitle: 'Kitchen recipes' },
      { folderId: 'fld-music', folderTitle: 'Piano repertoire' },
    ],
  });
  assert.deepEqual(suggestions, []);
});

test('Design systems vs Spacing as a system is a reproducible title/host overlap with score > 0', () => {
  const input = toScoreInput(buildClassifyInboxFixture());
  const first = score(input);
  const second = score(input);
  assert.deepEqual(first, second);
  assert.equal(first.length, 1);
  const suggestion = first[0];
  assert.ok(suggestion);
  assert.ok(suggestion.score > 0);
  assert.equal(suggestion.score, 14);
  assert.equal(suggestion.suggestionId, 'fld-spacing');
  assert.equal(suggestion.folderId, 'fld-spacing');
  assert.equal(suggestion.folderTitle, 'Spacing as a system');
  assert.equal(suggestion.kind, 'existing');
  assert.equal(suggestion.reason, 'Title/host overlap with "Spacing as a system".');
  assert.equal(Number.isInteger(suggestion.score), true);
  assert.ok(suggestion.score >= 0 && suggestion.score <= 100);
});

test('ties are stable by folderTitle ascending then folderId ascending', () => {
  const suggestions = score({
    bookmark: { title: 'Alpha Bravo', url: 'https://example.com/x' },
    candidateFolders: [
      { folderId: 'fld-z', folderTitle: 'Alpha' },
      { folderId: 'fld-a', folderTitle: 'Alpha' },
      { folderId: 'fld-m', folderTitle: 'Bravo' },
    ],
  });
  assert.equal(suggestions.length, 3);
  assert.deepEqual(
    suggestions.map((item) => ({ folderTitle: item.folderTitle, folderId: item.folderId, score: item.score })),
    [
      { folderTitle: 'Alpha', folderId: 'fld-a', score: 25 },
      { folderTitle: 'Alpha', folderId: 'fld-z', score: 25 },
      { folderTitle: 'Bravo', folderId: 'fld-m', score: 25 },
    ],
  );
  assert.ok(suggestions.every((item) => item.score === suggestions[0]?.score));
});

test('keeps at most 3 suggestions even when more folders overlap', () => {
  const suggestions = score({
    bookmark: { title: 'Alpha beta gamma delta', url: 'https://example.com/x' },
    candidateFolders: [
      { folderId: 'fld-4', folderTitle: 'Alpha' },
      { folderId: 'fld-1', folderTitle: 'Alpha beta gamma delta' },
      { folderId: 'fld-3', folderTitle: 'Alpha beta' },
      { folderId: 'fld-2', folderTitle: 'Alpha beta gamma' },
      { folderId: 'fld-0', folderTitle: 'Unrelated kitchen' },
    ],
  });
  assert.equal(suggestions.length, 3);
  assert.deepEqual(
    suggestions.map((item) => item.folderId),
    ['fld-1', 'fld-2', 'fld-3'],
  );
  assert.ok(suggestions.every((item) => item.score > 0));
  assert.equal(suggestions.some((item) => item.folderId === 'fld-4' || item.folderId === 'fld-0'), false);
});

test('empty title, invalid URL, and missing host do not throw', () => {
  assert.doesNotThrow(() => {
    const emptyTitle = score({
      bookmark: { title: '', url: 'https://design.example.com/x' },
      candidateFolders: [{ folderId: 'fld-design', folderTitle: 'Design notes' }],
    });
    assert.equal(emptyTitle.length, 1);
    assert.ok(emptyTitle[0] !== undefined && emptyTitle[0].score > 0);
  });
  assert.doesNotThrow(() => {
    const invalidUrl = score({
      bookmark: { title: 'Design systems', url: 'not a url' },
      candidateFolders: [{ folderId: 'fld-design', folderTitle: 'Design systems' }],
    });
    assert.equal(invalidUrl.length, 1);
    assert.equal(invalidUrl[0]?.score, 100);
  });
  assert.doesNotThrow(() => {
    const missingHost = score({
      bookmark: { title: 'Design systems', url: 'https://' },
      candidateFolders: [{ folderId: 'fld-design', folderTitle: 'Design systems' }],
    });
    assert.equal(missingHost.length, 1);
    assert.equal(missingHost[0]?.score, 100);
  });
  assert.doesNotThrow(() => {
    const emptyHostUrl = score({
      bookmark: { title: 'Design systems', url: '' },
      candidateFolders: [{ folderId: 'fld-design', folderTitle: 'Design systems' }],
    });
    assert.equal(emptyHostUrl.length, 1);
    assert.equal(emptyHostUrl[0]?.score, 100);
  });
});

test('results are deterministic across repeated calls', () => {
  const input: ClassifyInboxScoreInput = {
    bookmark: { title: 'Design systems', url: 'https://system.example.com/essay' },
    candidateFolders: [
      { folderId: 'fld-b', folderTitle: 'Systems handbook' },
      { folderId: 'fld-a', folderTitle: 'Spacing as a system' },
      { folderId: 'fld-c', folderTitle: 'Kitchen recipes' },
    ],
  };
  assert.deepEqual(score(input), score(input));
});

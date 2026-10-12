import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'vitest';
import { previewSourceRuleImageUrl } from '../../../src/infrastructure/collections/link-preview-source-rules.js';
import {
  linkPreviewImageRejection,
  linkPreviewTargetIdentity,
} from '../../../src/modules/collections/index.js';

describe('previewSourceRuleImageUrl', () => {
  test.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42', 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg'],
    ['https://youtu.be/dQw4w9WgXcQ?si=abc', 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg'],
    ['https://m.youtube.com/shorts/dQw4w9WgXcQ', 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg'],
    ['https://YouTube.com/embed/dQw4w9WgXcQ', 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg'],
    ['https://www.youtube.com/live/dQw4w9WgXcQ', 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg'],
    ['https://github.com/git-bug/git-bug', 'https://opengraph.githubassets.com/1/git-bug/git-bug'],
    ['https://github.com/vectorize-io/hindsight/tree/main/docs', 'https://opengraph.githubassets.com/1/vectorize-io/hindsight'],
    ['https://github.com/owner/repo.git', 'https://opengraph.githubassets.com/1/owner/repo'],
  ])('%s', (url, expected) => {
    assert.equal(previewSourceRuleImageUrl(url), expected);
  });

  test.each([
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/channel/UC123',
    'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
    'https://github.com/git-bug',
    'https://github.com/settings/profile',
    'https://github.com/topics/rust',
    'https://github.com/owner/..',
    'https://gist.github.com/owner/abcdef',
    'ftp://github.com/owner/repo',
    'not a url',
  ])('%s has no rule', (url) => {
    assert.equal(previewSourceRuleImageUrl(url), null);
  });
});

describe('linkPreviewTargetIdentity', () => {
  test('keys the normalized URL and groups by registrable domain', () => {
    const identity = linkPreviewTargetIdentity('HTTPS://Blog.Example.co.uk:443/post/#top');
    assert.ok(identity);
    assert.equal(identity.normalizedUrl, 'https://blog.example.co.uk/post/');
    assert.equal(identity.site, 'example.co.uk');
    assert.equal(identity.urlKey, createHash('sha256').update('https://blog.example.co.uk/post/').digest('hex'));
    assert.equal(linkPreviewTargetIdentity('https://blog.example.co.uk/post/')?.urlKey, identity.urlKey);
  });

  test('keeps trailing-slash resources separate while ignoring fragments', () => {
    const directory = linkPreviewTargetIdentity('https://example.com/articles/#top')!;
    const file = linkPreviewTargetIdentity('https://example.com/articles')!;
    assert.equal(directory.normalizedUrl, 'https://example.com/articles/');
    assert.equal(file.normalizedUrl, 'https://example.com/articles');
    assert.notEqual(directory.urlKey, file.urlKey);
  });

  test('IP and single-label hosts use the bare host; invalid URLs have no identity', () => {
    assert.equal(linkPreviewTargetIdentity('http://127.0.0.1:8080/a')?.site, '127.0.0.1');
    assert.equal(linkPreviewTargetIdentity('http://intranet/a')?.site, 'intranet');
    assert.equal(linkPreviewTargetIdentity('https://user:pw@example.com/'), null);
    assert.equal(linkPreviewTargetIdentity('mailto:a@example.com'), null);
    assert.equal(linkPreviewTargetIdentity(`https://example.com/${'a'.repeat(4100)}`), null);
  });
});

describe('linkPreviewImageRejection', () => {
  test.each([
    [{ mime: 'image/png', width: 1200, height: 630 }, null],
    [{ mime: 'image/jpeg', width: 200, height: 120 }, null],
    [{ mime: 'image/webp', width: 400, height: 1200 }, null],
    [{ mime: 'image/x-icon', width: 256, height: 256 }, 'rejected_type'],
    [{ mime: 'image/png', width: 199, height: 400 }, 'rejected_small'],
    [{ mime: 'image/png', width: 400, height: 119 }, 'rejected_small'],
    [{ mime: 'image/png', width: 2000, height: 400 }, 'rejected_shape'],
    [{ mime: 'image/png', width: 300, height: 1000 }, 'rejected_shape'],
    [{ mime: 'image/png', width: 5000, height: 3000 }, 'rejected_shape'],
  ] as const)('%o → %s', (image, expected) => {
    assert.equal(linkPreviewImageRejection(image), expected);
  });
});

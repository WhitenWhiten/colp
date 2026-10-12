// @vitest-environment happy-dom
import assert from 'node:assert/strict';
import { afterEach, describe, test, vi } from 'vitest';
import { avatarLetter, fillAvatar } from '../src/account-label.js';

const PNG = Uint8Array.from(Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000182e403790000000049454e44ae426082',
  'hex',
));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fillAvatar', () => {
  test('paints an img for a https url and falls back to the letter', async () => {
    vi.stubGlobal('fetch', async () => { throw new TypeError('Failed to fetch'); });
    const target = document.createElement('div');
    fillAvatar(target, avatarLetter('ada@example.test'), 'https://cdn.example.test/ada.png');
    const img = target.querySelector('img');
    assert.ok(img);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(img?.getAttribute('src'), 'https://cdn.example.test/ada.png');
    assert.equal(img?.getAttribute('alt'), '');
    assert.equal(img?.referrerPolicy, 'no-referrer');
    img?.dispatchEvent(new Event('error'));
    assert.equal(target.textContent, 'A');
    assert.equal(target.querySelector('img'), null);
  });

  test('paints a provider CDN photo even when a product origin is supplied', async () => {
    vi.stubGlobal('fetch', async () => { throw new TypeError('Failed to fetch'); });
    const target = document.createElement('div');
    fillAvatar(target, 'A', 'https://lh3.googleusercontent.com/a/ada.png', 'https://known.example');
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(target.querySelector('img')?.getAttribute('src'), 'https://lh3.googleusercontent.com/a/ada.png');
  });

  test('paints an inlined data-url photo without fetching', () => {
    const target = document.createElement('div');
    const data = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    fillAvatar(target, 'A', data);
    assert.equal(target.querySelector('img')?.getAttribute('src'), data);
  });

  test('paints the letter when the url is missing or unsafe', () => {
    const target = document.createElement('div');
    fillAvatar(target, 'K');
    assert.equal(target.textContent, 'K');
    fillAvatar(target, 'K', 'javascript:alert(1)');
    assert.equal(target.textContent, 'K');
    assert.equal(target.querySelector('img'), null);
  });

  test('loads a product photo as a blob so CORP cannot blank the chip', async () => {
    vi.stubGlobal('fetch', async () => new Response(PNG, { headers: { 'content-type': 'image/png' } }));
    const target = document.createElement('div');
    fillAvatar(
      target,
      'A',
      'https://known.example/api/v1/avatar/123e4567-e89b-42d3-a456-426614174000',
    );
    await vi.waitFor(() => {
      assert.match(target.querySelector('img')?.src ?? '', /^blob:/u);
    });
  });

  test('hydrates /me when the snapshot has no photo yet', async () => {
    const photo = 'https://known.example/api/v1/avatar/123e4567-e89b-42d3-a456-426614174000';
    const png = PNG;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const href = String(input);
      if (href.endsWith('/api/v1/session')) {
        return Response.json({ authenticated: true, csrfToken: 'csrf' });
      }
      if (href.endsWith('/api/v1/me')) {
        return Response.json({ profile: { avatarUrl: photo } });
      }
      return new Response(png, { headers: { 'content-type': 'image/png' } });
    });
    const target = document.createElement('div');
    fillAvatar(target, 'A', undefined, 'https://known.example');
    assert.equal(target.textContent, 'A');
    await vi.waitFor(() => {
      assert.match(target.querySelector('img')?.src ?? '', /^blob:/u);
    });
  });
});

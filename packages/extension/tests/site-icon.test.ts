// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest';
import { ICON_DATA_URL_MAX, validAdapterIcon, validSiteIcon } from '../src/site-adapters/icon-spec.js';
import { createSiteMark, faviconSources, iconSources } from '../src/site-adapters/site-icon.js';

const dataIcon = 'data:image/png;base64,iVBORw0KGgo=';
afterEach(() => vi.unstubAllGlobals());
function extensionUrl() {
  vi.stubGlobal('chrome', { runtime: { getURL: (path: string) => `chrome-extension://known/${path.replace(/^\//u, '')}` } });
}

test('package icons are closed, unmatched, inline image data only', () => {
  expect(validAdapterIcon({ kind: 'favicon' })).toBe(true);
  expect(validAdapterIcon({ kind: 'data', dataUrl: dataIcon })).toBe(true);
  for (const value of [
    { kind: 'asset', path: 'icons/bilibili.svg' }, { kind: 'url', url: 'https://icons.example/b.svg' },
    { kind: 'data', dataUrl: 'data:image/svg+xml;base64,AAAA' }, { kind: 'data', dataUrl: 'data:text/html;base64,AAAA' },
    { kind: 'favicon', extra: true }, { kind: 'data', dataUrl: `${dataIcon.slice(0, -1)}!` },
    { kind: 'data', dataUrl: `data:image/png;base64,${'A'.repeat(ICON_DATA_URL_MAX)}` },
  ]) expect(validAdapterIcon(value)).toBe(false);
});

test('bundled definitions may use a packaged asset or an audited HTTPS image, never a local or credentialed URL', () => {
  expect(validSiteIcon({ kind: 'asset', path: 'icons/icon-32.png' })).toBe(true);
  expect(validSiteIcon({ kind: 'asset', path: 'icons/sites/bilibili.svg' })).toBe(true);
  expect(validSiteIcon({ kind: 'url', url: 'https://www.bilibili.com/favicon.ico?v=2' })).toBe(true);
  for (const value of [
    { kind: 'asset', path: '../icons/b.svg' }, { kind: 'asset', path: 'icons/../b.svg' }, { kind: 'asset', path: 'icons/b.html' },
    { kind: 'url', url: 'http://www.bilibili.com/favicon.ico' }, { kind: 'url', url: 'https://user:secret@www.bilibili.com/favicon.ico' },
    { kind: 'url', url: 'https://www.bilibili.com/favicon.ico#fragment' }, { kind: 'url', url: 'javascript:alert(1)' },
  ]) expect(validSiteIcon(value)).toBe(false);
});

test('the default sources are the site favicon and the browser cache; authored marks come first', () => {
  extensionUrl();
  const favicons = faviconSources('https://www.bilibili.com', 32);
  expect(favicons[0]).toBe('https://www.bilibili.com/favicon.ico');
  const parsed = new URL(favicons[1]!);
  expect(parsed.pathname).toBe('/_favicon/'); expect(parsed.searchParams.get('pageUrl')).toBe('https://www.bilibili.com/'); expect(parsed.searchParams.get('size')).toBe('32');
  expect(faviconSources('http://localhost', 32)).toEqual([]);
  expect(iconSources(undefined, 'https://www.bilibili.com', 20)).toEqual(faviconSources('https://www.bilibili.com', 20));
  expect(iconSources({ kind: 'data', dataUrl: dataIcon }, 'https://www.bilibili.com', 20)[0]).toBe(dataIcon);
  expect(iconSources({ kind: 'asset', path: 'icons/icon-32.png' }, 'https://www.bilibili.com', 20)[0]).toBe('chrome-extension://known/icons/icon-32.png');
  expect(iconSources({ kind: 'url', url: 'https://icons.example/b.svg' }, 'https://www.bilibili.com', 20)[0]).toBe('https://icons.example/b.svg');
});

test('a mark paints the authored image, falls back to the favicon, then to its letter', () => {
  extensionUrl();
  const dataMark = createSiteMark({ label: 'Bilibili', origin: 'https://www.bilibili.com', icon: { kind: 'data', dataUrl: dataIcon } });
  expect(dataMark.querySelector('img')!.getAttribute('src')).toBe(dataIcon); expect(dataMark.textContent).toBe('B');
  dataMark.querySelector('img')!.dispatchEvent(new Event('load')); expect(dataMark.dataset.icon).toBe('image');
  const mark = createSiteMark({ label: 'Bilibili', origin: 'https://www.bilibili.com', icon: { kind: 'url', url: 'https://icons.example/missing.svg' } });
  const image = mark.querySelector('img')!;
  expect(image.getAttribute('src')).toBe('https://icons.example/missing.svg'); expect(mark.dataset.icon).toBe('letter');
  image.dispatchEvent(new Event('error')); expect(image.getAttribute('src')).toBe('https://www.bilibili.com/favicon.ico');
  image.dispatchEvent(new Event('error')); expect(image.getAttribute('src')).toContain('/_favicon/'); expect(mark.dataset.icon).toBe('letter');
  image.dispatchEvent(new Event('error')); expect(mark.querySelector('img')).toBeNull(); expect(mark.textContent).toBe('B');
  const noOrigin = createSiteMark({ label: '', origin: 'not-a-url' });
  expect(noOrigin.querySelector('img')).toBeNull(); expect(noOrigin.textContent).toBe('?');
});

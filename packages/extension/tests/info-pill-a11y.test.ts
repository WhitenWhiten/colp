import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');

test('info-pill tips are announced and the pill is a 24px target (R13 E-11)', async () => {
  const chrome = await read('../chrome.css');
  const popup = await read('../popup.css');
  const pageLanguage = await read('../src/page-language.ts');
  // .visually-hidden is shared through chrome.css, which popup.css and options.css both import.
  assert.match(chrome, /\.visually-hidden \{[^}]*clip: rect\(0, 0, 0, 0\)/);
  assert.doesNotMatch(popup, /\.visually-hidden \{/);
  assert.match(popup, /@import url\("chrome\.css"\)/);
  assert.match(await read('../options.css'), /@import url\("chrome\.css"\)/);
  assert.match(chrome, /\.info-pill \{[^}]*width: 1\.5rem;[^}]*height: 1\.5rem;/);
  // Static pills get a hidden copy of data-tip linked by aria-describedby.
  assert.match(pageLanguage, /querySelectorAll<HTMLElement>\('\.info-pill\[data-tip\]'\)/);
  assert.match(pageLanguage, /pill\.setAttribute\('aria-describedby', text\.id\)/);
});

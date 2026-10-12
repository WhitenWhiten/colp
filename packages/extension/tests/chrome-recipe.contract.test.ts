import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'vitest';

/**
 * chrome.css button recipes mirror the main site (web global.css +
 * interactions.css) by hand; this contract pins the shared declarations so
 * the two files cannot drift silently again — a weight, hover mix or
 * disabled treatment change must land on both sides deliberately.
 */
const webGlobalUrl = new URL('../design/global.css', import.meta.url);
const webSharedChromeUrl = new URL('../design/shared-chrome.css', import.meta.url);
const extChromeUrl = new URL('../chrome.css', import.meta.url);

/** Drop @media blocks (coarse-pointer overrides etc.) so only the base rules
 *  are compared; a selector list like `.btn, .btn-sm` inside one is not the
 *  base recipe. */
function stripMediaBlocks(css: string): string {
  let out = '';
  let rest = css;
  for (;;) {
    const at = rest.indexOf('@media');
    if (at < 0) return out + rest;
    out += rest.slice(0, at);
    const open = rest.indexOf('{', at);
    let depth = 0;
    let i = open;
    for (; i < rest.length; i += 1) {
      if (rest[i] === '{') depth += 1;
      else if (rest[i] === '}') { depth -= 1; if (depth === 0) { i += 1; break; } }
    }
    rest = rest.slice(i);
  }
}

function declarations(css: string, selector: string): Map<string, string> {
  const map = new Map<string, string>();
  // A selector may appear more than once (e.g. a fine-pointer @media block
  // adding hover lifts); merge every block so the pinned base values win
  // regardless of authoring order.
  let from = 0;
  for (;;) {
    const start = css.indexOf(`${selector} {`, from);
    if (start < 0) break;
    from = start + selector.length;
    const open = css.indexOf('{', start);
    const body = css.slice(open + 1, css.indexOf('}', open)).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const match of body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)) {
      map.set(match[1]!, match[2]!.trim().replace(/\s+/g, ' '));
    }
  }
  assert.ok(from > 0, `selector ${selector} not found`);
  return map;
}

const PINNED: Array<{ web: string; ext: string; props: string[] }> = [
  { web: '.btn', ext: '.btn',
    props: ['min-height', 'padding', 'border-radius', 'font-size', 'font-weight', 'letter-spacing'] },
  { web: '.btn::before', ext: '.btn::before', props: ['background'] },
  { web: '.btn:disabled', ext: '.btn:disabled', props: ['color', 'background', 'border-color'] },
  { web: '.btn-primary', ext: '.btn-primary', props: ['background', 'color', 'border-color', 'box-shadow'] },
  { web: '.btn-primary:hover', ext: '.btn-primary:hover:not(:disabled)', props: ['background', 'border-color'] },
  { web: '.btn-primary:disabled', ext: '.btn-primary:disabled', props: ['background', 'color', 'border-color'] },
  { web: '.btn-secondary', ext: '.btn-secondary', props: ['background', 'border-color', 'color', 'font-weight', 'box-shadow'] },
  { web: '.btn-secondary:hover', ext: '.btn-secondary:hover:not(:disabled)', props: ['border-color', 'background', 'color'] },
  { web: '.btn-danger', ext: '.btn-danger', props: ['background', 'border-color', 'color', 'box-shadow'] },
  { web: '.btn-danger:hover', ext: '.btn-danger:hover:not(:disabled)', props: ['background'] },
  { web: '.btn-ghost', ext: '.btn-ghost', props: ['background', 'border-color', 'color', 'font-weight'] },
  { web: '.btn-ghost:hover', ext: '.btn-ghost:hover:not(:disabled)', props: ['background', 'color'] },
  { web: '.btn-sm', ext: '.btn-sm', props: ['min-height', 'padding', 'font-size'] },
];

/* The segmented control is mirrored from shared-chrome.css (collection /
   explore / dashboard toolbars and auth-method tabs), not global.css, so it
   gets its own source and pin list. */
const PINNED_VIEW_SWITCH: Array<{ web: string; ext: string; props: string[] }> = [
  { web: '.view-switch', ext: '.view-switch',
    props: ['display', 'padding', 'gap', 'border', 'border-radius', 'background'] },
  { web: '.view-switch button', ext: '.view-switch button',
    props: ['min-height', 'padding', 'border', 'border-radius', 'background', 'color', 'font-size', 'font-weight', 'line-height', 'transition'] },
  { web: '.view-switch button:hover', ext: '.view-switch button:hover', props: ['color'] },
  { web: ".view-switch button[aria-selected='true']", ext: ".view-switch button[aria-selected='true']",
    props: ['background', 'color', 'box-shadow'] },
  { web: ".view-switch button[aria-disabled='true']", ext: ".view-switch button[aria-disabled='true']",
    props: ['opacity', 'cursor'] },
];

describe('chrome.css button recipes mirror the main site', () => {
  test('shared .btn declarations match web global.css values', async () => {
    const web = stripMediaBlocks(await readFile(webGlobalUrl, 'utf8'));
    const ext = stripMediaBlocks(await readFile(extChromeUrl, 'utf8'));
    for (const { web: webSelector, ext: extSelector, props } of PINNED) {
      const webDecls = declarations(web, webSelector);
      const extDecls = declarations(ext, extSelector);
      for (const prop of props) {
        const webValue = webDecls.get(prop);
        assert.ok(webValue !== undefined, `web ${webSelector} is missing ${prop}`);
        assert.strictEqual(extDecls.get(prop), webValue,
          `${extSelector} { ${prop} } drifted from the main site (${webSelector})`);
      }
    }
  });

  test('global focus ring mirrors the web double-ring recipe (D1)', async () => {
    const ext = await readFile(extChromeUrl, 'utf8');
    assert.match(ext,
      /:focus-visible \{[^}]*outline:\s*1px solid var\(--ink\);[^}]*outline-offset:\s*1px;[^}]*box-shadow:\s*var\(--shadow-ring\);/);
    // No local accent-outline specialization may survive anywhere (D1).
    for (const file of ['../chrome.css', '../popup.css', '../options.css']) {
      const css = await readFile(new URL(file, import.meta.url), 'utf8');
      assert.doesNotMatch(css, /outline:[^;}]*var\(--accent\)/, `${file} still has an accent focus ring`);
    }
  });
});

describe('chrome.css .view-switch mirrors the main site', () => {
  test('shared .view-switch declarations match web shared-chrome.css values', async () => {
    const web = stripMediaBlocks(await readFile(webSharedChromeUrl, 'utf8'));
    const ext = stripMediaBlocks(await readFile(extChromeUrl, 'utf8'));
    for (const { web: webSelector, ext: extSelector, props } of PINNED_VIEW_SWITCH) {
      const webDecls = declarations(web, webSelector);
      const extDecls = declarations(ext, extSelector);
      for (const prop of props) {
        const webValue = webDecls.get(prop);
        assert.ok(webValue !== undefined, `web ${webSelector} is missing ${prop}`);
        assert.strictEqual(extDecls.get(prop), webValue,
          `${extSelector} { ${prop} } drifted from the main site (${webSelector})`);
      }
    }
  });
});

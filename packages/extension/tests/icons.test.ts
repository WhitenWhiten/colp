// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createIcon, hydrateIcons } from '../src/icons.js';
import { icon as managerIcon } from '../src/bookmark-manager-dom.js';
import { captureIcon } from '../src/capture/icons.js';
import { ICON_NAMES } from '../design/icon-paths.js';

afterEach(() => { document.body.replaceChildren(); });

it('keeps capture and manager icons identical across both extension adapters', () => {
  for (const name of ['folder', 'globe', 'pencil', 'move', 'trash'] as const) {
    expect(managerIcon(name).outerHTML).toBe(captureIcon(name).outerHTML);
  }
  expect(managerIcon('chevron').outerHTML).toBe(createIcon('chevron-down').outerHTML);
});

it('hydrates every static popup/options glyph without replacing referenced nodes or changing their state', () => {
  for (const file of ['popup', 'options']) {
    const html = readFileSync(resolve(`${file}.html`), 'utf8');
    // Mount only the SVG declarations; page scripts/styles are outside this DOM test.
    // Choice-card wireframes and brand marks (Google) are drawn illustrations (data-illustration), not glyphs.
    document.body.innerHTML = (html.match(/<svg\b[^>]*>[\s\S]*?<\/svg>/gu) ?? []).filter(svg => !/^<svg\b[^>]*\bdata-illustration\b/u.test(svg)).join('');
    const svgs = Array.from(document.querySelectorAll<SVGSVGElement>('svg'));
    expect(svgs.length).toBeGreaterThan(0);
    for (const svg of svgs) {
      expect(ICON_NAMES).toContain(svg.dataset.icon);
      svg.setAttribute('hidden', '');
    }
    hydrateIcons(document);
    for (const svg of svgs) {
      expect(svg.isConnected).toBe(true);
      expect(svg.hasAttribute('hidden')).toBe(true);
      expect(svg.getAttribute('aria-hidden')).toBe('true');
      expect(svg.getAttribute('focusable')).toBe('false');
      expect(svg.querySelector('path')?.getAttribute('d')).toBeTruthy();
    }
    const rendered = document.body.innerHTML;
    hydrateIcons(document);
    expect(document.body.innerHTML).toBe(rendered);
  }
});

// @vitest-environment happy-dom
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Import } from './Import';
import { cleanup, mountTree } from '../test/render'

describe('P3-35 web import handoff', () => {
  beforeEach(() => { document.body.innerHTML = '<div id="root"></div>';
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
 });
  afterEach(() => cleanup());

  it('offers only the reachable extension workflow and no fake uploader, seed counts, or timer controls', () => {
    mountTree(<MemoryRouter><Import /></MemoryRouter>);
    expect(document.querySelector('h1')?.textContent).toBe('Import bookmarks');
    expect(document.body.textContent).toMatch(/Sync › Import/);
    expect(document.querySelector('a[href="/extension"]')?.textContent).toMatch(/extension/i);
    expect(document.querySelector('a[href="/sync"]')?.textContent).toMatch(/sync/i);
    expect(document.querySelector('input[type="file"]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/186|Pocket|Raindrop|demo|Import & classify/i);
    expect(document.querySelector('[data-extension-handoff]')).not.toBeNull();
  });

  it('renders malicious-looking instructions as text and preserves keyboard focus visibility hooks', () => {
    mountTree(<MemoryRouter><Import /></MemoryRouter>);
    expect(document.querySelector('script')).toBeNull();
    const link = document.querySelector<HTMLAnchorElement>('a[href="/extension"]')!;
    link.focus(); expect(document.activeElement).toBe(link); expect(link.className).toContain('btn');
  });
});

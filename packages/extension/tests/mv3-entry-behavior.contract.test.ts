/**
 * Static MV3-entry pin (allowlisted in tests/static-anchor-allowlist.ts): the
 * popup's overflow-menu observer must not write the attribute it observes
 * without comparing the current value first.
 *
 * The observer is module-private bootstrap code in `src/popup-header.ts` — constructed
 * at import time, with no exported seam — so no behavioural test in this package
 * can reach it: the package runs vitest in the node environment, and the hazard
 * (the callback re-queuing itself from its own microtask until the popup's main
 * thread starves) only manifests inside a real browser. It was found by pausing a
 * frozen popup with the V8 inspector, whose stack sat inside
 * `MutationObserver.observe.attributes` while `#popup-more` kept the same
 * `hidden` value on every invocation.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const popupSource = readFileSync(resolve(import.meta.dirname, '../src/popup-header.ts'), 'utf8');

function overflowMenuObserverBody(): string {
  const match = /new MutationObserver\(\(\) => \{([\s\S]*?)\}\)\s*\.observe\(popupMore,/u.exec(popupSource);
  if (!match?.[1]) throw new Error('the overflow-menu observer is missing from src/popup-header.ts');
  return match[1];
}

describe('MV3 popup entry behaviour', () => {
  it('guards the overflow-menu write so the observer cannot re-trigger itself', () => {
    const body = overflowMenuObserverBody();
    // The comparison is what stops the loop: an unconditional write re-queues the
    // callback that is watching the very attribute being written.
    expect(body).toMatch(/if\s*\(\s*popupMore\.hidden\s*!==\s*\w+\s*\)\s*popupMore\.hidden\s*=\s*\w+\s*;/u);
    expect(body).not.toMatch(/^\s*popupMore\.hidden\s*=/mu);
  });

  it('still derives the menu visibility from both conditional actions', () => {
    const body = overflowMenuObserverBody();
    expect(body).toMatch(/openNativeWait\.hidden/u);
    expect(body).toMatch(/clearIcon\.hidden/u);
  });
});

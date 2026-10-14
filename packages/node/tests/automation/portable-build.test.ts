import { test, expect } from 'vitest';
import { build } from 'esbuild';
import { compilePredicate } from '../../src/automation/index.js';
import facts from '../fixtures/automation/event-facts.json' with { type: 'json' };

test('optional automation entry bundles for a browser without host imports', async () => {
  const result = await build({ entryPoints: ['src/automation/index.ts'], bundle: true, platform: 'browser',
    format: 'esm', write: false, metafile: true });
  const imports = Object.values(result.metafile!.outputs).flatMap((output) => output.imports);
  expect(imports).toEqual([]);
  expect(Object.keys(result.metafile!.inputs).some((input) => /chrome|react|transport|database/.test(input))).toBe(false);
});

test('browser bundle executes the same golden decisions without host imports', async () => {
  const result = await build({ entryPoints: ['src/automation/index.ts'], bundle: true, platform: 'browser', format: 'iife', globalName: 'AutomationCore', write: false });
  const bundled = new Function(result.outputFiles[0]!.text + ';return AutomationCore;')() as { compilePredicate: typeof compilePredicate };
  for (const match of [
    { kind: 'field', field: 'bookmark.url.host', op: 'hostSuffix', value: 'ARXIV.org.' },
    { kind: 'field', field: 'bookmark.url.path', op: 'startsWith', value: '/abs/' },
    { kind: 'field', field: 'bookmark.title', op: 'contains', value: 'not-present' },
  ]) {
    const source = compilePredicate(match), browser = bundled.compilePredicate(match);
    expect(browser.valid).toBe(source.valid);
    if (source.valid && browser.valid) expect(browser.evaluate(facts)).toEqual(source.evaluate(facts));
  }
});

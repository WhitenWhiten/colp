import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as core from '@know-n/colp/automation';
import { automationAjvPlugin } from '../scripts/automation-ajv-plugin.mjs';
import { NOW, compiledRule, intakeFacts, ruleBundle } from './automation-fixture.js';

/* MV3 forbids runtime code generation, so the extension bundles the automation
   core with validators generated at build time. These tests run that bundled
   core and check it decides exactly as the published core does. */
const root = resolve(import.meta.dirname, '..');
let directory = '';
let bundled: typeof core;
let code = '';

beforeAll(async () => {
  const result = await build({ stdin: { contents: "export * from '@know-n/colp/automation';", resolveDir: root, loader: 'ts' },
    bundle: true, platform: 'browser', format: 'esm', write: false, plugins: [automationAjvPlugin(root)], logLevel: 'silent' });
  code = result.outputFiles[0]!.text;
  directory = await mkdtemp(join(tmpdir(), 'automation-core-'));
  const file = join(directory, 'core.mjs');
  await writeFile(file, code);
  bundled = await import(pathToFileURL(file).href) as typeof core;
}, 60_000);
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

describe('MV3 automation core', () => {
  it('keeps the generated validators in step with the installed core', async () => {
    await promisify(execFile)(process.execPath, [resolve(root, 'scripts/generate-automation-validators.mjs'), '--check']);
  });

  it('bundles without Ajv runtime compilation', () => {
    expect(code).not.toMatch(/new Function|\beval\(/u);
    expect(code).toContain('automation_validator_unavailable');
  });

  it('validates contract documents exactly like the published core', () => {
    const bundle = ruleBundle([compiledRule()]);
    const cases: Array<[core.AutomationSchemaName, unknown]> = [
      ['RuleBundle', bundle], ['RuleBundle', { ...bundle, rules: [{ ...bundle.rules[0], programId: 'javascript' }] }],
      ['RuleBundle', { ...bundle, issuedAt: 'yesterday' }], ['RuleBundle', { ...bundle, extra: true }],
      ['EventFacts', intakeFacts('https://arxiv.org/abs/1')], ['EventFacts', { ...intakeFacts('https://arxiv.org/abs/1'), origin: 'ftp' }],
      ['LocalReceiptInput', { deviceId: 'device-1', replicaGeneration: 1, localReceiptId: 'r1', operationId: 'op', ruleId: 'rule',
        ruleRevision: '1', bindingRevision: '1', bundleRevision: '1', inputDigest: 'a'.repeat(64), satisfiedTaskTypes: ['classify.root'],
        committedNode: { serverUuid: 's', collectionId: 'c', nodeId: 'n' }, resultDigests: [] }],
      ['LocalReceiptInput', { deviceId: 'device-1', nativeObservation: { nativeId: '42' } }],
      ['PauseState', { paused: true, pausedAt: new Date(NOW).toISOString(), pausedBy: 'owner', revision: '3', heldJobs: 0 }],
    ];
    for (const [name, value] of cases) {
      expect(bundled.validateAutomation(name, value).valid, name).toBe(core.validateAutomation(name, value).valid);
    }
  });

  it('compiles and evaluates predicates the same way', () => {
    const facts = intakeFacts('https://export.arxiv.org/abs/2401.0001');
    for (const match of [
      { kind: 'field', field: 'bookmark.url.host', op: 'hostSuffix', value: 'ARXIV.org.' },
      { kind: 'field', field: 'bookmark.url.path', op: 'startsWith', value: '/abs/' },
      { kind: 'not', item: { kind: 'field', field: 'bookmark.title', op: 'contains', value: 'paper' } },
      { kind: 'field', field: 'bookmark.tags', op: 'startsWith', value: 'x' },
      { kind: 'cel', expression: 'true', profile: 'colp-cel-v1', dependencies: [] },
    ]) {
      const source = core.compilePredicate(match), browser = bundled.compilePredicate(match);
      expect(browser.valid).toBe(source.valid);
      if (source.valid && browser.valid) expect(browser.evaluate(facts)).toEqual(source.evaluate(facts));
    }
    expect(bundled.validateM1Rule(compiledRule().definition)).toEqual([]);
  });

  it('fails closed for a schema it was not generated for', () => {
    expect(() => bundled.validateAutomation('Job' as core.AutomationSchemaName, {})).toThrow('automation_validator_unavailable');
  });
});

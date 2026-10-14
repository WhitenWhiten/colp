import { describe, expect, it } from 'vitest';
import { automationDigest, type RuleBundle } from '@know-n/colp/automation';
import { checkBundle, evaluateLocalRules, ruleSupported, type LocalFolder, type LocalRule } from '../src/automation/runtime-profile.js';
import { COLLECTION_ID, DAY, NOW, compiledRule, folderRef, intakeFacts, ruleBundle } from './automation-fixture.js';

const resolved = (nodeId: string, title = nodeId): LocalFolder => ({ status: 'resolved', folder: folderRef(nodeId), nativeId: `native-${nodeId}`, title });
const local = (rule = compiledRule(), folder: LocalFolder = resolved('academic', 'Academic')): LocalRule => ({ rule, folders: { academicRoot: folder } });
const redigest = (bundle: RuleBundle): RuleBundle => { const { digest: _old, ...content } = bundle; return { ...content, digest: automationDigest(content) }; };

describe('browser-bounded bundle checks', () => {
  it('accepts a bundle compiled like the server compiles it and reports its server identity', () => {
    const result = checkBundle(ruleBundle([compiledRule()]), NOW);
    expect(result).toMatchObject({ ok: true, serverUuid: 'server-fixture' });
  });

  it('rejects a whole bundle for any digest, profile, expiry or shape problem', () => {
    const good = ruleBundle([compiledRule()]);
    expect(checkBundle({ ...good, digest: '0'.repeat(64) }, NOW)).toEqual({ ok: false, reason: 'digest' });
    expect(checkBundle({ ...good, profile: 'server-cel-v1' }, NOW)).toEqual({ ok: false, reason: 'invalid' });
    expect(checkBundle(ruleBundle([compiledRule()], { issuedAt: NOW - 8 * DAY }), NOW)).toEqual({ ok: false, reason: 'expired' });
    expect(checkBundle({ ...good, rules: [...good.rules, { ...good.rules[0]!, nativeBindingId: 'x' }] }, NOW)).toEqual({ ok: false, reason: 'invalid' });
    expect(checkBundle(redigest({ ...good, rules: [good.rules[0]!, good.rules[0]!] }), NOW)).toEqual({ ok: false, reason: 'invalid' });
    expect(checkBundle(redigest({ ...good, paused: true }), NOW)).toEqual({ ok: false, reason: 'invalid' });
    expect(checkBundle('not a bundle', NOW)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses rules it cannot evaluate exactly instead of guessing from the hints', () => {
    const rule = compiledRule();
    expect(ruleSupported(rule)).toBe(true);
    expect(ruleSupported({ ...rule, semanticDigest: '0'.repeat(64) })).toBe(false);
    const { intake: _intake, ...noIntake } = rule.definition;
    expect(ruleSupported({ ...rule, definition: noIntake })).toBe(false);
    expect(ruleSupported({ ...rule, definition: { ...rule.definition, trigger: { mode: 'countBatch', count: 10, distinctBy: 'node', partition: 'rule' } } })).toBe(false);
    const unsupported = redigest(ruleBundle([{ ...rule, semanticDigest: '0'.repeat(64) }]));
    expect(checkBundle(unsupported, NOW)).toEqual({ ok: false, reason: 'unsupported' });
  });

  it('refuses bundles that mix server identities', () => {
    const other = compiledRule({ ruleId: 'rule-other', folder: { serverUuid: 'other-server', collectionId: COLLECTION_ID, nodeId: 'x' } });
    expect(checkBundle(ruleBundle([compiledRule(), other]), NOW)).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('local rule evaluation through the shared core', () => {
  const inbox = folderRef('inbox');

  it('places a matching default-location save into the rule folder', () => {
    const decision = evaluateLocalRules([local()], intakeFacts('https://arxiv.org/abs/1', inbox), 'userDefault');
    expect(decision).toMatchObject({ kind: 'place', ruleId: 'rule-arxiv', folder: { nativeId: 'native-academic', title: 'Academic' }, satisfies: ['classify.root'] });
  });

  it('keeps an explicit choice and reports which rules it skipped', () => {
    expect(evaluateLocalRules([local()], intakeFacts('https://arxiv.org/abs/1', inbox), 'userSelected')).toEqual({ kind: 'keep', ruleIds: ['rule-arxiv'] });
  });

  it('blocks instead of guessing when the destination is not mapped here', () => {
    const unmapped: LocalFolder = { status: 'unresolved', folder: folderRef('academic'), reason: 'unmapped' };
    expect(evaluateLocalRules([local(compiledRule(), unmapped)], intakeFacts('https://arxiv.org/abs/1', inbox), 'userDefault'))
      .toEqual({ kind: 'blocked', ruleIds: ['rule-arxiv'], reason: 'bindingUnavailable' });
  });

  it('lets a working rule place even when another matching rule is blocked', () => {
    const blocked = local(compiledRule({ ruleId: 'rule-blocked' }), { status: 'unresolved', folder: folderRef('gone'), reason: 'deleted' });
    const decision = evaluateLocalRules([blocked, local()], intakeFacts('https://arxiv.org/abs/1', inbox), 'userDefault');
    expect(decision).toMatchObject({ kind: 'place', ruleId: 'rule-arxiv' });
  });

  it('sends equal-priority disagreements to review and lets priority decide otherwise', () => {
    const other = local(compiledRule({ ruleId: 'rule-work', folder: folderRef('work') }), resolved('work', 'Work'));
    const facts = intakeFacts('https://arxiv.org/abs/1', inbox);
    expect(evaluateLocalRules([local(), other], facts, 'userDefault')).toEqual({ kind: 'conflict', ruleIds: ['rule-arxiv', 'rule-work'] });
    const higher = local(compiledRule({ ruleId: 'rule-work', folder: folderRef('work'), priority: 200 }), resolved('work', 'Work'));
    expect(evaluateLocalRules([local(), higher], facts, 'userDefault')).toMatchObject({ kind: 'place', ruleId: 'rule-work' });
  });

  it('ignores other sites, other origins and unknown intent', () => {
    expect(evaluateLocalRules([local()], intakeFacts('https://example.org/', inbox), 'userDefault')).toEqual({ kind: 'none' });
    expect(evaluateLocalRules([local()], { ...intakeFacts('https://arxiv.org/abs/1', inbox), origin: 'import' }, 'userDefault')).toEqual({ kind: 'none' });
    expect(evaluateLocalRules([local()], intakeFacts('https://arxiv.org/abs/1', inbox), 'unknown')).toEqual({ kind: 'review', ruleIds: ['rule-arxiv'] });
  });

  it('applies a scope folder only to bookmarks inside it', () => {
    const scoped = compiledRule({ definition: { scope: { folderRole: 'academicRoot', includeDescendants: true } } });
    const rule: LocalRule = { rule: scoped, folders: { academicRoot: resolved('academic', 'Academic') } };
    expect(evaluateLocalRules([rule], intakeFacts('https://arxiv.org/abs/1', inbox), 'userDefault')).toEqual({ kind: 'none' });
    const inside = intakeFacts('https://arxiv.org/abs/1', folderRef('sub'), { ancestors: [folderRef('sub'), folderRef('academic')] });
    expect(evaluateLocalRules([rule], inside, 'userDefault')).toMatchObject({ kind: 'place' });
  });
});

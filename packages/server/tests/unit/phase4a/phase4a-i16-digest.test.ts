/**
 * P4A-I16 contract suite: canonical digest over protocol/state facts only.
 *
 * The digest is a deterministic SHA-256 over a FIXED projection
 * `{ scenario, negativeControls[control+outcome], postRunChecks,
 * execution[control+exitClass+stableCode+sourceDigest+cleanupReceipt] }` with
 * canonical JSON ordering. It is stable under key insertion order, changes
 * when a protocol/state or in-run execution fact changes, and is UNAFFECTED
 * by non-protocol fields: browser UI, latency, SDK message, verification
 * source, dependency versions, commit/tree, config digest, and R2 control
 * facts never enter the digest. The runner therefore cannot paper over a
 * semantic change in the digest, and the validator recomputes it
 * independently.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  canonicalizeI16,
  computeI16CanonicalDigest,
  sha256HexI16,
} from '../../../scripts/evidence/phase4a-i16-acceptance.js';
import {
  buildI16FixtureEvidence,
  i16PostRunChecks,
  i16Scenario,
} from '../../support/phase4a-i16-test-helpers.js';

describe('P4A-I16 canonical digest over protocol/state facts', () => {
  test('canonicalization is deterministic and ordered', () => {
    // Object keys are sorted canonically; ARRAY order is preserved (arrays are
    // ordered lists, so [1, {d:4,c:3}] and [{c:3,d:4}, 1] canonicalize differently).
    assert.equal(
      canonicalizeI16({ b: 2, a: [1, { d: 4, c: 3 }], z: 's' }),
      canonicalizeI16({ z: 's', a: [1, { c: 3, d: 4 }], b: 2 }),
    );
    assert.notEqual(
      canonicalizeI16({ b: 2, a: [1, { d: 4, c: 3 }], z: 's' }),
      canonicalizeI16({ b: 2, a: [{ c: 3, d: 4 }, 1], z: 's' }),
    );
    assert.match(sha256HexI16(canonicalizeI16({ x: 1 })), /^[a-f0-9]{64}$/);
  });

  test('digest is stable under evidence field insertion order', () => {
    const bundle = buildI16FixtureEvidence();
    const first = computeI16CanonicalDigest({
      scenario: bundle.scenario,
      negativeControls: bundle.negativeControls.map(({ control, outcome }) => ({ control, outcome })),
      postRunChecks: bundle.postRunChecks,
      executionReceipts: bundle.executionReceipts,
    });
    const second = computeI16CanonicalDigest({
      negativeControls: bundle.negativeControls.map(({ outcome, control }) => ({ outcome, control })),
      postRunChecks: { ...bundle.postRunChecks },
      scenario: { ...bundle.scenario },
      executionReceipts: [...bundle.executionReceipts],
    });
    assert.equal(first, second);
    assert.equal(first, bundle.canonicalDigest, 'the bundle digest matches the recomputed digest');
  });

  test('a protocol fact change changes the digest', () => {
    const bundle = buildI16FixtureEvidence();
    const base = computeI16CanonicalDigest({
      scenario: bundle.scenario,
      negativeControls: bundle.negativeControls.map(({ control, outcome }) => ({ control, outcome })),
      postRunChecks: bundle.postRunChecks,
      executionReceipts: bundle.executionReceipts,
    });
    const changed = computeI16CanonicalDigest({
      scenario: i16Scenario({ verify: { outcome: 'quarantined' as never, verifiedSizeMatches: false, mediaCategory: 'suspicious' } }),
      negativeControls: bundle.negativeControls.map(({ control, outcome }) => ({ control, outcome })),
      postRunChecks: bundle.postRunChecks,
      executionReceipts: bundle.executionReceipts,
    });
    assert.notEqual(changed, base);
  });

  test('a post-run fact change changes the digest', () => {
    const bundle = buildI16FixtureEvidence();
    const base = computeI16CanonicalDigest({
      scenario: bundle.scenario,
      negativeControls: bundle.negativeControls.map(({ control, outcome }) => ({ control, outcome })),
      postRunChecks: bundle.postRunChecks,
      executionReceipts: bundle.executionReceipts,
    });
    const changed = computeI16CanonicalDigest({
      scenario: bundle.scenario,
      negativeControls: bundle.negativeControls.map(({ control, outcome }) => ({ control, outcome })),
      postRunChecks: i16PostRunChecks({ probeKeysAbsent: false }),
      executionReceipts: bundle.executionReceipts,
    });
    assert.notEqual(changed, base);
  });

  test('an in-run execution fact change changes the digest', () => {
    const bundle = buildI16FixtureEvidence();
    const base = computeI16CanonicalDigest({
      scenario: bundle.scenario,
      negativeControls: bundle.negativeControls.map(({ control, outcome }) => ({ control, outcome })),
      postRunChecks: bundle.postRunChecks,
      executionReceipts: bundle.executionReceipts,
    });
    const receipts = bundle.executionReceipts.map((receipt, index) => (
      index === 0 ? { ...receipt, cleanupReceipt: 'not_cleaned' } : receipt
    ));
    const changed = computeI16CanonicalDigest({
      scenario: bundle.scenario,
      negativeControls: bundle.negativeControls.map(({ control, outcome }) => ({ control, outcome })),
      postRunChecks: bundle.postRunChecks,
      executionReceipts: receipts,
    });
    assert.notEqual(changed, base);
  });

  test('non-protocol fields never enter the digest: verification source, binding, versions, browser UI, latency', () => {
    const bundle = buildI16FixtureEvidence();
    const digestOf = (b: typeof bundle): string => computeI16CanonicalDigest({
      scenario: b.scenario,
      negativeControls: b.negativeControls.map(({ control, outcome }) => ({ control, outcome })),
      postRunChecks: b.postRunChecks,
      executionReceipts: b.executionReceipts,
    });
    const base = digestOf(bundle);

    // verificationSource is provenance, not a protocol fact: the receipt is
    // derived from the entry, so the source swap leaves the digest unchanged.
    const sourceChanged = buildI16FixtureEvidence({
      negativeControls: bundle.negativeControls.map((control, index) => (
        index === 0 ? { ...control, verificationSource: 'unit-fault-suite' as const } : control
      )),
    });
    assert.equal(digestOf(sourceChanged), base);

    // binding (commit/tree/config/versions/control) is NOT part of the digest.
    const bindingChanged = buildI16FixtureEvidence({
      binding: { sourceRevision: 'f'.repeat(40), dependencyVersions: { ...bundle.binding.dependencyVersions, pg: '9.9.9' } },
    });
    assert.equal(digestOf(bindingChanged), base);

    // a simulated browser-UI/latency/SDK-message-only scenario change is not
    // representable in the closed scenario shape; assert the digest function
    // ignores extra keys when handed an object with non-protocol extras.
    const withExtras = computeI16CanonicalDigest({
      scenario: { ...bundle.scenario, browserDownloadBarText: 'x', latencyMs: 123, sdkMessage: 'y' } as never,
      negativeControls: bundle.negativeControls.map(({ control, outcome }) => ({ control, outcome })),
      postRunChecks: bundle.postRunChecks,
      executionReceipts: bundle.executionReceipts,
    });
    assert.equal(withExtras, base, 'extra non-protocol fields must be ignored by the canonical digest');
  });

  test('the canonical digest never contains a key/URL/credential/body/filename/digest value', () => {
    const bundle = buildI16FixtureEvidence();
    assert.match(bundle.canonicalDigest, /^[a-f0-9]{64}$/);
    assert.ok(!bundle.canonicalDigest.includes('http'));
    assert.ok(!bundle.canonicalDigest.includes('/'));
  });
});

/**
 * P4A-I15 alert conditions: sustained window + backlog growth rate only.
 *
 * Proves (with injected deterministic samples and a fixed clock):
 *  - verification backlog fires ONLY when the count stays above the threshold
 *    for the full sustained window AND the backlog is growing at or above the
 *    configured rate;
 *  - a single local spike followed by recovery never fires (below_threshold /
 *    not_sustained) — the anti-false-positive rule;
 *  - a sustained flat backlog with zero growth never fires (no_growth);
 *  - two samples that are too recent to cover the sustained window never fire
 *    (not_sustained);
 *  - fewer than two samples in the window never fire (insufficient_samples);
 *  - planned maintenance SUPPRESSES the alert but still records the event
 *    (underlyingFiring=true + full evidence) — suppression is not erasure;
 *  - cleanup backlog, quarantine growth, and dead-letter replay use the same
 *    sustained-window + growth-rate rule with their own thresholds.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  DEFAULT_ATTACHMENT_ALERT_CONFIG,
  evaluateAttachmentAlerts,
  type AttachmentAlertConfig,
  type AttachmentBacklogSample,
} from '../../../src/modules/attachments/index.js';

const NOW_ISO = '2026-08-08T00:10:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);

function sampleAt(
  secondsBeforeNow: number,
  counts: Partial<Omit<AttachmentBacklogSample, 'atIso'>> = {},
): AttachmentBacklogSample {
  return {
    atIso: new Date(NOW_MS - secondsBeforeNow * 1000).toISOString(),
    verificationBacklog: 0,
    cleanupBacklog: 0,
    quarantineCount: 0,
    deadLetterCount: 0,
    ...counts,
  };
}

const CONFIG: AttachmentAlertConfig = DEFAULT_ATTACHMENT_ALERT_CONFIG;

function verdicts(samples: AttachmentBacklogSample[], overrides: { maintenanceActive?: boolean } = {}) {
  return evaluateAttachmentAlerts({ samples, config: CONFIG, nowIso: NOW_ISO, ...overrides });
}

describe('P4A-I15 alerts: verification backlog', () => {
  test('sustained window + growth rate fires', () => {
    // 300s window, threshold 50, growth 10/min. 6 samples, 60s apart, growing
    // from 60 to 110 -> all above threshold, growth = 50/5min = 10/min.
    const samples = Array.from({ length: 6 }, (_unused, index) =>
      sampleAt(300 - index * 60, { verificationBacklog: 60 + index * 10 }));
    const verdict = verdicts(samples).verification_backlog;
    assert.equal(verdict.firing, true);
    assert.equal(verdict.underlyingFiring, true);
    assert.equal(verdict.suppressed, false);
    assert.equal(verdict.reason, 'sustained_and_growing');
    assert.equal(verdict.evidence.growthPerMinute, 10);
    assert.equal(verdict.evidence.samplesInWindow, 6);
  });

  test('a single spike then recovery never fires (anti-false-positive)', () => {
    const samples = [
      sampleAt(300, { verificationBacklog: 100 }),
      sampleAt(240, { verificationBacklog: 200 }),
      sampleAt(180, { verificationBacklog: 20 }),
    ];
    const verdict = verdicts(samples).verification_backlog;
    assert.equal(verdict.firing, false);
    assert.equal(verdict.underlyingFiring, false);
    assert.equal(verdict.reason, 'below_threshold');
  });

  test('a sustained flat backlog with zero growth never fires (no_growth)', () => {
    const samples = Array.from({ length: 6 }, (_unused, index) =>
      sampleAt(300 - index * 60, { verificationBacklog: 80 }));
    const verdict = verdicts(samples).verification_backlog;
    assert.equal(verdict.firing, false);
    assert.equal(verdict.underlyingFiring, false);
    assert.equal(verdict.reason, 'no_growth');
  });

  test('samples that do not cover the full sustained window never fire (not_sustained)', () => {
    const samples = [
      sampleAt(30, { verificationBacklog: 100 }),
      sampleAt(0, { verificationBacklog: 150 }),
    ];
    const verdict = verdicts(samples).verification_backlog;
    assert.equal(verdict.firing, false);
    assert.equal(verdict.underlyingFiring, false);
    assert.equal(verdict.reason, 'not_sustained');
  });

  test('fewer than two samples in the window never fire (insufficient_samples)', () => {
    const verdict = verdicts([sampleAt(0, { verificationBacklog: 500 })]).verification_backlog;
    assert.equal(verdict.firing, false);
    assert.equal(verdict.underlyingFiring, false);
    assert.equal(verdict.reason, 'insufficient_samples');
  });

  test('planned maintenance suppresses the alert but still records the event', () => {
    const samples = Array.from({ length: 6 }, (_unused, index) =>
      sampleAt(300 - index * 60, { verificationBacklog: 60 + index * 10 }));
    const verdict = verdicts(samples, { maintenanceActive: true }).verification_backlog;
    assert.equal(verdict.firing, false, 'maintenance suppresses the effective alert');
    assert.equal(verdict.suppressed, true);
    assert.equal(verdict.underlyingFiring, true, 'the event is still recorded');
    assert.equal(verdict.reason, 'suppressed_maintenance');
    assert.equal(verdict.evidence.growthPerMinute, 10, 'suppressed verdicts keep the full evidence');
  });
});

describe('P4A-I15 alerts: cleanup / quarantine / dead-letter', () => {
  test('cleanup backlog fires only when sustained and growing', () => {
    const samples = Array.from({ length: 6 }, (_unused, index) =>
      sampleAt(300 - index * 60, { cleanupBacklog: 30 + index * 6 }));
    const verdict = verdicts(samples).cleanup_backlog;
    assert.equal(verdict.firing, true);
    assert.equal(verdict.evidence.growthPerMinute, 6);
    // Same series but flat -> no growth -> no fire.
    const flat = Array.from({ length: 6 }, (_unused, index) =>
      sampleAt(300 - index * 60, { cleanupBacklog: 30 }));
    assert.equal(verdicts(flat).cleanup_backlog.firing, false);
    // Single spike then recovery -> no fire.
    const spike = [
      sampleAt(300, { cleanupBacklog: 100 }),
      sampleAt(240, { cleanupBacklog: 200 }),
      sampleAt(180, { cleanupBacklog: 5 }),
    ];
    assert.equal(verdicts(spike).cleanup_backlog.firing, false);
  });

  test('quarantine growth fires only when the quarantine count grows over a sustained window', () => {
    const samples = Array.from({ length: 6 }, (_unused, index) =>
      sampleAt(300 - index * 60, { quarantineCount: 2 + index }));
    const verdict = verdicts(samples).quarantine_growth;
    assert.equal(verdict.firing, true);
    const flat = Array.from({ length: 6 }, (_unused, index) =>
      sampleAt(300 - index * 60, { quarantineCount: 4 }));
    assert.equal(verdicts(flat).quarantine_growth.firing, false, 'flat quarantine count is not growth');
    const spike = [
      sampleAt(300, { quarantineCount: 0 }),
      sampleAt(240, { quarantineCount: 10 }),
      sampleAt(180, { quarantineCount: 0 }),
    ];
    assert.equal(verdicts(spike).quarantine_growth.firing, false, 'a spike that recovers never fires');
  });

  test('dead-letter replay fires when dead letters persist and grow', () => {
    const samples = Array.from({ length: 6 }, (_unused, index) =>
      sampleAt(300 - index * 60, { deadLetterCount: 1 + index }));
    const verdict = verdicts(samples).dead_letter_replay;
    assert.equal(verdict.firing, true);
    // A single dead-letter that is already draining (count falls to zero) never fires.
    const recovering = [
      sampleAt(300, { deadLetterCount: 3 }),
      sampleAt(240, { deadLetterCount: 2 }),
      sampleAt(180, { deadLetterCount: 0 }),
    ];
    assert.equal(verdicts(recovering).dead_letter_replay.firing, false);
  });

  test('all verdicts share the fixed alert name set (P4A-P10 extends I15 with redis_hot_key + pool_saturation) and carry no secrets', () => {
    const marker = `alert-marker-${Date.now()}`;
    const samples = Array.from({ length: 6 }, (_unused, index) =>
      sampleAt(300 - index * 60, { verificationBacklog: 60 + index * 10, cleanupBacklog: 30 + index * 6 }));
    const verdictsAll = verdicts(samples);
    assert.deepEqual(Object.keys(verdictsAll).sort(), [
      'cleanup_backlog', 'dead_letter_replay', 'pool_saturation',
      'quarantine_growth', 'redis_hot_key', 'verification_backlog',
    ]);
    const serialized = JSON.stringify(verdictsAll);
    assert.ok(!serialized.includes(marker));
    for (const forbidden of ['bucket', 'livePrefix', 'secretRef', 'accessKeyId', 'filename', 'digest']) {
      assert.ok(!serialized.includes(forbidden), `alert verdicts must not contain ${forbidden}`);
    }
  });
});
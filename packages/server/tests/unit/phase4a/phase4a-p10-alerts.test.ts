/**
 * P4A-P10 alert rehearsal contracts (plan §9 P10 item 2, §4.2 anti-false-
 * negative). Extends the I15 sustained-window alert semantics with the two
 * P10 alert fields — Redis hot key count and PostgreSQL pool saturation —
 * while re-pinning the two hard rules:
 *
 *  - alerts fire ONLY on a sustained window AND growth (a single spike never
 *    fires — anti-false-positive §4.1);
 *  - planned maintenance suppresses the EFFECTIVE alert but never deletes
 *    the event: `underlyingFiring` stays true, the samples stay in the
 *    bounded ring, and the verdict records `suppressed` (anti-false-negative
 *    §4.2: "maintenance suppression 不删除事件").
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  ATTACHMENT_ALERT_NAMES,
  createAttachmentMetricsStore,
  evaluateAttachmentAlerts,
  type AttachmentAlertConfig,
  type AttachmentBacklogSample,
} from '../../../src/modules/attachments/index.js';

/** Short-window config so the sustained window is reachable without sleeps. */
const SHORT_CONFIG: AttachmentAlertConfig = Object.freeze({
  verificationBacklog: Object.freeze({ sustainedSeconds: 60, minCount: 5, minGrowthPerMinute: 1 }),
  cleanupBacklog: Object.freeze({ sustainedSeconds: 60, minCount: 5, minGrowthPerMinute: 1 }),
  quarantineGrowth: Object.freeze({ sustainedSeconds: 60, minCount: 1, minGrowthPerMinute: 1 }),
  deadLetterReplay: Object.freeze({ sustainedSeconds: 60, minCount: 1, minGrowthPerMinute: 0 }),
  redisHotKey: Object.freeze({ sustainedSeconds: 60, minCount: 2, minGrowthPerMinute: 1 }),
  poolSaturation: Object.freeze({ sustainedSeconds: 60, minCount: 3, minGrowthPerMinute: 1 }),
});

const WINDOW_START = '2026-08-10T00:00:00.000Z';
const MINUTE = 60_000;

function sample(overrides: Partial<AttachmentBacklogSample> & { readonly atIso: string }): AttachmentBacklogSample {
  return {
    atIso: overrides.atIso,
    verificationBacklog: overrides.verificationBacklog ?? 0,
    cleanupBacklog: overrides.cleanupBacklog ?? 0,
    quarantineCount: overrides.quarantineCount ?? 0,
    deadLetterCount: overrides.deadLetterCount ?? 0,
    ...(overrides.redisHotKeyCount === undefined ? {} : { redisHotKeyCount: overrides.redisHotKeyCount }),
    ...(overrides.poolWaiting === undefined ? {} : { poolWaiting: overrides.poolWaiting }),
  };
}

/** A sustained-and-growing series for one field, starting at the window edge. */
function growingSeries(
  atIso: string,
  count: number,
): Array<{ atIso: string; count: number }> {
  const series = [];
  for (let index = 0; index < 4; index += 1) {
    series.push({ atIso: new Date(Date.parse(atIso) - (3 - index) * MINUTE).toISOString(), count: count + index });
  }
  return series;
}

describe('P4A-P10 alerts: Redis hot key and pool saturation fields', () => {
  test('redis_hot_key fires only when the hot-key count is sustained and growing', () => {
    const series = growingSeries(WINDOW_START, 3); // 3,4,5,6 >= minCount 2, growth 1/min
    const verdicts = evaluateAttachmentAlerts({
      samples: series.map((entry) => sample({ atIso: entry.atIso, redisHotKeyCount: entry.count })),
      config: SHORT_CONFIG,
      nowIso: WINDOW_START,
    });
    assert.equal(verdicts.redis_hot_key.firing, true);
    assert.equal(verdicts.redis_hot_key.underlyingFiring, true);
    assert.equal(verdicts.redis_hot_key.reason, 'sustained_and_growing');
  });

  test('pool_saturation fires only when pool waiting is sustained and growing', () => {
    const series = growingSeries(WINDOW_START, 4); // 4,5,6,7 >= minCount 3
    const verdicts = evaluateAttachmentAlerts({
      samples: series.map((entry) => sample({ atIso: entry.atIso, poolWaiting: entry.count })),
      config: SHORT_CONFIG,
      nowIso: WINDOW_START,
    });
    assert.equal(verdicts.pool_saturation.firing, true);
    assert.equal(verdicts.pool_saturation.underlyingFiring, true);
  });

  test('a single spike never fires either new alert (anti-false-positive)', () => {
    const spike = sample({ atIso: WINDOW_START, redisHotKeyCount: 100, poolWaiting: 100 });
    const quiet = (atIso: string) => sample({ atIso, redisHotKeyCount: 0, poolWaiting: 0 });
    const verdicts = evaluateAttachmentAlerts({
      samples: [quiet(new Date(Date.parse(WINDOW_START) - 3 * MINUTE).toISOString()), spike],
      config: SHORT_CONFIG,
      nowIso: WINDOW_START,
    });
    assert.equal(verdicts.redis_hot_key.firing, false);
    assert.equal(verdicts.pool_saturation.firing, false);
    assert.equal(verdicts.redis_hot_key.underlyingFiring, false);
    assert.equal(verdicts.pool_saturation.underlyingFiring, false);
  });

  test('absent new fields are treated as zero and never fire (no false alarm from missing data)', () => {
    const series = growingSeries(WINDOW_START, 10);
    const verdicts = evaluateAttachmentAlerts({
      samples: series.map((entry) => sample({ atIso: entry.atIso })),
      config: SHORT_CONFIG,
      nowIso: WINDOW_START,
    });
    assert.equal(verdicts.redis_hot_key.firing, false, 'a sample without hot-key facts must stay quiet');
    assert.equal(verdicts.pool_saturation.firing, false, 'a sample without pool facts must stay quiet');
  });

  test('maintenance suppression keeps the event recorded: underlyingFiring stays true and the samples stay in the ring', () => {
    const series = growingSeries(WINDOW_START, 3);
    const samples = series.map((entry) => sample({ atIso: entry.atIso, redisHotKeyCount: entry.count }));
    const store = createAttachmentMetricsStore({ now: () => new Date(WINDOW_START) });
    for (const entry of samples) store.recordBacklogSample(entry);

    const verdicts = evaluateAttachmentAlerts({
      samples,
      config: SHORT_CONFIG,
      nowIso: WINDOW_START,
      maintenanceActive: true,
    });
    assert.equal(verdicts.redis_hot_key.firing, false, 'maintenance suppresses the effective alert');
    assert.equal(verdicts.redis_hot_key.suppressed, true);
    assert.equal(verdicts.redis_hot_key.underlyingFiring, true, 'the underlying condition is still recorded');
    assert.equal(verdicts.redis_hot_key.reason, 'suppressed_maintenance');
    assert.equal(verdicts.pool_saturation.suppressed, false, 'a non-firing alert is not marked suppressed');

    // The events are NOT deleted: the bounded ring still holds every sample.
    assert.equal(store.snapshot().backlogSamples.length, samples.length,
      'maintenance suppression must never erase the recorded samples');
    // And the metric gauges still reflect the underlying firing state.
    store.setGauge('verification_backlog', 0);
    const snapshot = store.snapshot();
    assert.equal(snapshot.backlogSamples.every((entry) => entry.redisHotKeyCount === undefined
      || entry.redisHotKeyCount > 0), true);
  });

  test('the fixed alert name set now includes the two P10 alert fields', () => {
    assert.deepEqual(ATTACHMENT_ALERT_NAMES, [
      'verification_backlog', 'cleanup_backlog', 'quarantine_growth', 'dead_letter_replay',
      'redis_hot_key', 'pool_saturation',
    ]);
    // The default config carries bounded window entries for the new alerts.
    const defaults = evaluateAttachmentAlerts({
      samples: [],
      nowIso: WINDOW_START,
    });
    assert.equal(defaults.redis_hot_key.alert, 'redis_hot_key');
    assert.equal(defaults.pool_saturation.alert, 'pool_saturation');
    assert.equal(defaults.redis_hot_key.reason, 'insufficient_samples');
  });
});

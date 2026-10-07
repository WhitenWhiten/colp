/**
 * P4A-I15 attachment alert conditions: pure functions over backlog samples +
 * config. Alerts fire ONLY on a sustained window AND a backlog growth rate —
 * never on a single local latency/count spike (plan §6 I15 anti-false-positive:
 * "告警以持续窗口和backlog增长率判定，不用单次本地latency尖峰").
 *
 * Planned maintenance suppresses the EFFECTIVE alert (firing=false,
 * suppressed=true) but still records the event (underlyingFiring + full
 * evidence), so maintenance never erases the observation.
 */
import type {
  AttachmentBacklogSample,
} from './attachments-metrics.js';

export const ATTACHMENT_ALERT_NAMES = [
  'verification_backlog', 'cleanup_backlog', 'quarantine_growth', 'dead_letter_replay',
  // P4A-P10 (plan §9 P10 item 2): Redis hot key and PostgreSQL pool
  // saturation use the SAME sustained-window + growth semantics.
  'redis_hot_key', 'pool_saturation',
] as const;
export type AttachmentAlertName = typeof ATTACHMENT_ALERT_NAMES[number];

export interface AttachmentAlertWindowConfig {
  /** Trailing window (seconds) over which the condition must be sustained. */
  readonly sustainedSeconds: number;
  /** Minimum backlog/count required for EVERY sample in the window. */
  readonly minCount: number;
  /** Minimum backlog growth per minute over the window. */
  readonly minGrowthPerMinute: number;
}

export interface AttachmentAlertConfig {
  readonly verificationBacklog: AttachmentAlertWindowConfig;
  readonly cleanupBacklog: AttachmentAlertWindowConfig;
  readonly quarantineGrowth: AttachmentAlertWindowConfig;
  readonly deadLetterReplay: AttachmentAlertWindowConfig;
  /** P4A-P10: sustained Redis hot-key count window (default 5 min, min 1, growth 1/min). */
  readonly redisHotKey?: AttachmentAlertWindowConfig;
  /** P4A-P10: sustained PostgreSQL pool-waiting window (default 5 min, min 5, growth 2/min). */
  readonly poolSaturation?: AttachmentAlertWindowConfig;
}

export const DEFAULT_ATTACHMENT_ALERT_CONFIG: Required<AttachmentAlertConfig> = Object.freeze({
  verificationBacklog: Object.freeze({ sustainedSeconds: 300, minCount: 50, minGrowthPerMinute: 10 }),
  cleanupBacklog: Object.freeze({ sustainedSeconds: 300, minCount: 20, minGrowthPerMinute: 5 }),
  quarantineGrowth: Object.freeze({ sustainedSeconds: 300, minCount: 1, minGrowthPerMinute: 1 }),
  deadLetterReplay: Object.freeze({ sustainedSeconds: 300, minCount: 1, minGrowthPerMinute: 0 }),
  redisHotKey: Object.freeze({ sustainedSeconds: 300, minCount: 1, minGrowthPerMinute: 1 }),
  poolSaturation: Object.freeze({ sustainedSeconds: 300, minCount: 5, minGrowthPerMinute: 2 }),
});

export type AttachmentAlertReason =
  | 'sustained_and_growing'
  | 'below_threshold'
  | 'not_sustained'
  | 'no_growth'
  | 'insufficient_samples'
  | 'suppressed_maintenance';

export interface AttachmentAlertEvidence {
  readonly samplesInWindow: number;
  readonly firstCount: number;
  readonly lastCount: number;
  readonly growthPerMinute: number;
  readonly windowSeconds: number;
}

export interface AttachmentAlertVerdict {
  readonly alert: AttachmentAlertName;
  /** Effective alert: false while suppressed by planned maintenance. */
  readonly firing: boolean;
  /** True when planned maintenance suppressed a would-be firing alert. */
  readonly suppressed: boolean;
  /** True when the condition would fire absent maintenance (event recorded). */
  readonly underlyingFiring: boolean;
  readonly reason: AttachmentAlertReason;
  readonly evidence: AttachmentAlertEvidence;
}

function evaluateWindow(
  alert: AttachmentAlertName,
  samples: readonly AttachmentBacklogSample[],
  windowConfig: AttachmentAlertWindowConfig,
  nowMs: number,
  selector: (sample: AttachmentBacklogSample) => number,
): AttachmentAlertVerdict {
  const windowMs = windowConfig.sustainedSeconds * 1_000;
  const windowStartMs = nowMs - windowMs;
  const windowSamples = samples
    .map((sample) => ({ atMs: Date.parse(sample.atIso), count: selector(sample) }))
    .filter((sample) => Number.isFinite(sample.atMs) && sample.atMs >= windowStartMs && sample.atMs <= nowMs)
    .sort((left, right) => left.atMs - right.atMs);

  const baseEvidence: AttachmentAlertEvidence = {
    samplesInWindow: windowSamples.length,
    firstCount: 0,
    lastCount: 0,
    growthPerMinute: 0,
    windowSeconds: windowConfig.sustainedSeconds,
  };

  if (windowSamples.length < 2) {
    return Object.freeze({
      alert, firing: false, suppressed: false, underlyingFiring: false,
      reason: 'insufficient_samples', evidence: baseEvidence,
    });
  }

  const first = windowSamples[0]!;
  const last = windowSamples[windowSamples.length - 1]!;
  const evidence: AttachmentAlertEvidence = {
    samplesInWindow: windowSamples.length,
    firstCount: first.count,
    lastCount: last.count,
    growthPerMinute: 0,
    windowSeconds: windowConfig.sustainedSeconds,
  };

  // Sustained: the sample series must reach back to the start of the window,
  // otherwise the high state has only been observed for a short tail.
  if (first.atMs > windowStartMs) {
    return Object.freeze({
      alert, firing: false, suppressed: false, underlyingFiring: false,
      reason: 'not_sustained', evidence,
    });
  }
  if (windowSamples.some((sample) => sample.count < windowConfig.minCount)) {
    return Object.freeze({
      alert, firing: false, suppressed: false, underlyingFiring: false,
      reason: 'below_threshold', evidence,
    });
  }
  const windowMinutes = windowMs / 60_000;
  const growthPerMinute = (last.count - first.count) / windowMinutes;
  if (growthPerMinute < windowConfig.minGrowthPerMinute) {
    return Object.freeze({
      alert, firing: false, suppressed: false, underlyingFiring: false,
      reason: 'no_growth', evidence: { ...evidence, growthPerMinute },
    });
  }
  return Object.freeze({
    alert, firing: true, suppressed: false, underlyingFiring: true,
    reason: 'sustained_and_growing', evidence: { ...evidence, growthPerMinute },
  });
}

export function evaluateAttachmentAlerts(input: {
  readonly samples: readonly AttachmentBacklogSample[];
  readonly config?: AttachmentAlertConfig;
  readonly nowIso?: string;
  readonly maintenanceActive?: boolean;
}): Readonly<Record<AttachmentAlertName, AttachmentAlertVerdict>> {
  const config = { ...DEFAULT_ATTACHMENT_ALERT_CONFIG, ...input.config };
  const nowMs = Date.parse(input.nowIso ?? new Date().toISOString());
  if (!Number.isFinite(nowMs)) throw new Error('attachment_alert_nowIso_invalid');
  const maintenanceActive = input.maintenanceActive === true;

  const evaluate = (
    alert: AttachmentAlertName,
    windowConfig: AttachmentAlertWindowConfig,
    selector: (sample: AttachmentBacklogSample) => number,
  ): AttachmentAlertVerdict => {
    const verdict = evaluateWindow(alert, input.samples, windowConfig, nowMs, selector);
    if (!maintenanceActive || !verdict.underlyingFiring) return verdict;
    return Object.freeze({
      ...verdict,
      firing: false,
      suppressed: true,
      reason: 'suppressed_maintenance',
    });
  };

  return Object.freeze({
    verification_backlog: evaluate('verification_backlog', config.verificationBacklog,
      (sample) => sample.verificationBacklog),
    cleanup_backlog: evaluate('cleanup_backlog', config.cleanupBacklog,
      (sample) => sample.cleanupBacklog),
    quarantine_growth: evaluate('quarantine_growth', config.quarantineGrowth,
      (sample) => sample.quarantineCount),
    dead_letter_replay: evaluate('dead_letter_replay', config.deadLetterReplay,
      (sample) => sample.deadLetterCount),
    // P4A-P10: absent optional fields default to 0 (never a fabricated fact);
    // partial/legacy configs inherit the sealed defaults for the new fields.
    redis_hot_key: evaluate('redis_hot_key',
      config.redisHotKey ?? DEFAULT_ATTACHMENT_ALERT_CONFIG.redisHotKey,
      (sample) => sample.redisHotKeyCount ?? 0),
    pool_saturation: evaluate('pool_saturation',
      config.poolSaturation ?? DEFAULT_ATTACHMENT_ALERT_CONFIG.poolSaturation,
      (sample) => sample.poolWaiting ?? 0),
  });
}
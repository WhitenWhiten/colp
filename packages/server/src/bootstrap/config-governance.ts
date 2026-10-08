import type { ContentGovernanceFeatureConfig } from './config-types.js';

export type { ContentGovernanceFeatureConfig };

function parseBoolean(raw: string | undefined, label: string, fallback = false): boolean {
  const value = (raw ?? String(fallback)).trim().toLowerCase();
  if (value !== 'true' && value !== 'false') throw new Error(`${label} must be true or false`);
  return value === 'true';
}

function parseBase64url32ByteSecret(raw: string, label: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(raw)) {
    throw new Error(`${label} must be canonical base64url`);
  }
  const bytes = Buffer.from(raw, 'base64url');
  const canonical = bytes.length === 32 ? bytes.toString('base64url') : '';
  bytes.fill(0);
  if (canonical !== raw) {
    throw new Error(`${label} must be a canonical base64url 32-byte secret`);
  }
  return raw;
}

export function loadContentGovernanceConfig(
  env: NodeJS.ProcessEnv = process.env,
  _nodeEnv = env.NODE_ENV ?? 'development',
): ContentGovernanceFeatureConfig {
  const enabled = parseBoolean(env.KNOWN_FEATURE_CONTENT_GOVERNANCE, 'KNOWN_FEATURE_CONTENT_GOVERNANCE');
  const raw = env.GOVERNANCE_CURSOR_HMAC_KEY?.trim() ?? '';
  const constants = Object.freeze({
    evidenceMaxBytes: 65_536 as const,
    evidenceRetentionDays: 365 as const,
    reportRate: Object.freeze({ maxRequests: 10 as const, windowMs: 3_600_000 as const }),
    actionRate: Object.freeze({ maxRequests: 60 as const, windowMs: 60_000 as const }),
    appealRate: Object.freeze({ maxRequests: 10 as const, windowMs: 86_400_000 as const }),
  });
  if (!enabled) {
    return Object.freeze({
      enabled: false,
      cursorHmacKey: raw === '' ? null : parseBase64url32ByteSecret(raw, 'GOVERNANCE_CURSOR_HMAC_KEY'),
      ...constants,
    });
  }
  if (raw === '') {
    throw new Error('GOVERNANCE_CURSOR_HMAC_KEY is required when KNOWN_FEATURE_CONTENT_GOVERNANCE=true');
  }
  return Object.freeze({
    enabled: true,
    cursorHmacKey: parseBase64url32ByteSecret(raw, 'GOVERNANCE_CURSOR_HMAC_KEY'),
    ...constants,
  });
}

import { parseCanonicalUtcTimestamp, parsePositiveInt, requireNonEmpty } from './config-parse-helpers.js';
import type { CacheTtlConfig } from './config-types.js';

const REPORT_TITLE_MAX_LENGTH = 512;
const REPORT_SUMMARY_MAX_LENGTH = 2_000;
const REPORT_SLUG_MAX_LENGTH = 63;
const REPORT_ISSUE_KEY_MAX_LENGTH = 128;
const REPORT_RRULE_MAX_LENGTH = 1_024;
const REPORT_CURSOR_TTL_MS = 15 * 60 * 1_000;
const REPORT_CURSOR_MAX_PREVIOUS_KEYS = 8;

export interface ReportsCacheConfig {
  readonly metadata: CacheTtlConfig;
  readonly issues: CacheTtlConfig;
  readonly directory: CacheTtlConfig;
  readonly metadataEnabled: boolean;
  readonly issuesEnabled: boolean;
  readonly directoryEnabled: boolean;
}

export interface ReportsCursorKeyConfig {
  readonly id: string;
  readonly secret: string;
}

export interface ReportsRetainedCursorKeyConfig extends ReportsCursorKeyConfig {
  readonly lastIssuedAt: string;
  readonly retainUntil: string;
}

export interface ReportsFeatureConfig {
  readonly enabled: boolean;
  readonly publicEnabled: boolean;
  readonly mcpEnabled: boolean;
  readonly mcpWriteEnabled: boolean;
  readonly schedulerEnabled: boolean;
  readonly cursor: {
    readonly active: ReportsCursorKeyConfig;
    readonly retained: readonly ReportsRetainedCursorKeyConfig[];
    readonly ttlMs: number;
  };
  readonly limits: {
    readonly titleMaxLength: number;
    readonly summaryMaxLength: number;
    readonly slugMaxLength: number;
    readonly issueKeyMaxLength: number;
    readonly rruleMaxLength: number;
    readonly pageMaxLimit: number;
    readonly maxCatchUp: number;
    readonly maxAttempts: number;
  };
}

const DEV_REPORTS_CURSOR_SECRET = Buffer.alloc(32, 0x2a).toString('base64');
const DEV_REPORTS_CURSOR_KEY_ID = 'dev-reports-v1';
function parseBoolean(raw: string | undefined, label: string, fallback = false): boolean {
  const value = (raw ?? String(fallback)).trim().toLowerCase();
  if (value !== 'true' && value !== 'false') throw new Error(`${label} must be true or false`);
  return value === 'true';
}
function parseCursorSecret(raw: string, label: string): string {
  const bytes = Buffer.from(raw, 'base64'); const canonical = bytes.length >= 32 && bytes.toString('base64') === raw; bytes.fill(0);
  if (!canonical) throw new Error(`${label} must be canonical base64 and at least 32 bytes`); return raw;
}
function parseRetainedKeys(raw: string, ttlMs: number): readonly ReportsRetainedCursorKeyConfig[] {
  if (raw.trim() === '') return Object.freeze([]);
  let parsed: unknown; try { parsed = JSON.parse(raw); } catch { throw new Error('REPORTS_CURSOR_RETAINED_KEYS must be a JSON array'); }
  if (!Array.isArray(parsed) || parsed.length > REPORT_CURSOR_MAX_PREVIOUS_KEYS) throw new Error(`REPORTS_CURSOR_RETAINED_KEYS must contain at most ${REPORT_CURSOR_MAX_PREVIOUS_KEYS} keys`);
  return Object.freeze(parsed.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`REPORTS_CURSOR_RETAINED_KEYS[${index}] is invalid`);
    const item = entry as Record<string, unknown>;
    if (Object.keys(item).sort().join(',') !== 'id,lastIssuedAt,retainUntil,secret' || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(item.id) || typeof item.secret !== 'string' || typeof item.lastIssuedAt !== 'string' || typeof item.retainUntil !== 'string') throw new Error(`REPORTS_CURSOR_RETAINED_KEYS[${index}] is invalid`);
    const secret = parseCursorSecret(item.secret, `REPORTS_CURSOR_RETAINED_KEYS[${index}].secret`);
    const last = parseCanonicalUtcTimestamp(item.lastIssuedAt, `REPORTS_CURSOR_RETAINED_KEYS[${index}].lastIssuedAt`); const retain = parseCanonicalUtcTimestamp(item.retainUntil, `REPORTS_CURSOR_RETAINED_KEYS[${index}].retainUntil`);
    if (retain - last < ttlMs) throw new Error(`REPORTS_CURSOR_RETAINED_KEYS[${index}] does not cover cursor TTL`);
    return Object.freeze({ id: item.id, secret, lastIssuedAt: new Date(last).toISOString(), retainUntil: new Date(retain).toISOString() });
  }));
}
export function loadReportsFeatureConfig(env: NodeJS.ProcessEnv = process.env, nodeEnv = env.NODE_ENV ?? 'development'): ReportsFeatureConfig {
  const enabled = parseBoolean(env.KNOWN_FEATURE_REPORTS, 'KNOWN_FEATURE_REPORTS');
  const publicEnabled = parseBoolean(env.KNOWN_FEATURE_REPORTS_PUBLIC, 'KNOWN_FEATURE_REPORTS_PUBLIC'); const mcpEnabled = parseBoolean(env.KNOWN_FEATURE_REPORTS_MCP, 'KNOWN_FEATURE_REPORTS_MCP'); const mcpWriteEnabled = parseBoolean(env.KNOWN_FEATURE_REPORTS_MCP_WRITE, 'KNOWN_FEATURE_REPORTS_MCP_WRITE'); const schedulerEnabled = parseBoolean(env.KNOWN_FEATURE_REPORTS_SCHEDULER, 'KNOWN_FEATURE_REPORTS_SCHEDULER');
  if ((publicEnabled || mcpEnabled || mcpWriteEnabled || schedulerEnabled) && !enabled) throw new Error('KNOWN_FEATURE_REPORTS_PUBLIC/MCP/MCP_WRITE/SCHEDULER require KNOWN_FEATURE_REPORTS=true');
  const existingMcpWrite = parseBoolean(env.KNOWN_FEATURE_MCP_WRITE, 'KNOWN_FEATURE_MCP_WRITE'); if (mcpWriteEnabled && (!mcpEnabled || !existingMcpWrite)) throw new Error('KNOWN_FEATURE_REPORTS_MCP_WRITE requires KNOWN_FEATURE_REPORTS_MCP and KNOWN_FEATURE_MCP_WRITE');
  const activeId = enabled ? requireNonEmpty(env, 'REPORTS_CURSOR_ACTIVE_KEY_ID', nodeEnv === 'production' ? undefined : DEV_REPORTS_CURSOR_KEY_ID) : DEV_REPORTS_CURSOR_KEY_ID;
  const rawSecret = enabled ? requireNonEmpty(env, 'REPORTS_CURSOR_ACTIVE_SECRET', nodeEnv === 'production' ? undefined : DEV_REPORTS_CURSOR_SECRET) : DEV_REPORTS_CURSOR_SECRET;
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(activeId)) throw new Error('REPORTS_CURSOR_ACTIVE_KEY_ID is invalid'); const activeSecret = parseCursorSecret(rawSecret, 'REPORTS_CURSOR_ACTIVE_SECRET'); const retained = enabled ? parseRetainedKeys(env.REPORTS_CURSOR_RETAINED_KEYS ?? '', REPORT_CURSOR_TTL_MS) : Object.freeze([]); if (new Set([activeId, ...retained.map((key) => key.id)]).size !== retained.length + 1) throw new Error('REPORTS cursor key ids must be unique');
  return Object.freeze({ enabled, publicEnabled, mcpEnabled, mcpWriteEnabled, schedulerEnabled, cursor: Object.freeze({ active: Object.freeze({ id: activeId, secret: activeSecret }), retained, ttlMs: REPORT_CURSOR_TTL_MS }), limits: Object.freeze({ titleMaxLength: REPORT_TITLE_MAX_LENGTH, summaryMaxLength: REPORT_SUMMARY_MAX_LENGTH, slugMaxLength: REPORT_SLUG_MAX_LENGTH, issueKeyMaxLength: REPORT_ISSUE_KEY_MAX_LENGTH, rruleMaxLength: REPORT_RRULE_MAX_LENGTH, pageMaxLimit: parsePositiveInt(env.REPORTS_PAGE_MAX_LIMIT, 100, 'REPORTS_PAGE_MAX_LIMIT', { max: 100 }), maxCatchUp: parsePositiveInt(env.REPORTS_MAX_CATCH_UP, 10, 'REPORTS_MAX_CATCH_UP', { allowZero: true, max: 100 }), maxAttempts: parsePositiveInt(env.REPORTS_MAX_ATTEMPTS, 5, 'REPORTS_MAX_ATTEMPTS', { max: 20 }) }) });
}
export const parseReportsFeatureConfig = loadReportsFeatureConfig;

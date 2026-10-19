import { normalizeHost } from '@know-n/colp/automation';
import { registrableDomain } from '../automation/public-suffix.js';
import type { RiskException } from './risk-check.js';

/**
 * Risk alert settings (doc 17 §4.4, RS-16, R12): the mode — off unless the Owner turns it on — and the
 * exceptions kept *always*. Exceptions for *this session* live in `chrome.storage.session` and end with
 * the browser. An exception names a host or a registrable domain and silences risk alerts only; it never
 * touches placement (RS-17.3).
 */
export const RISK_SETTINGS_KEY = 'known.risk.settings.v1';
export const RISK_SESSION_EXCEPTIONS_KEY = 'known.risk.sessionExceptions';
export const RISK_EXCEPTION_LIMIT = 500;
/** Browsing alerts read each page's address as it commits: both asked for in the mode switch (RS-16.3). */
export const BROWSE_PERMISSIONS = ['tabs', 'webNavigation'];
export type RiskMode = 'off' | 'onSave' | 'onSaveAndBrowse';
export interface StoredRiskException extends RiskException { readonly id: string; readonly createdAt: number }
export interface RiskSettings { readonly mode: RiskMode; readonly exceptions: readonly StoredRiskException[] }
export const DEFAULT_RISK_SETTINGS: RiskSettings = { mode: 'off', exceptions: [] };

const MODES = new Set<string>(['off', 'onSave', 'onSaveAndBrowse']);
const ID = /^[\w-]{1,128}$/u;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** The value an exception keeps for a host or domain the Owner typed or picked, or null when it names none. */
export function exceptionValue(scope: RiskException['scope'], raw: string): string | null {
  const host = normalizeHost(raw.trim());
  if (!host) return null;
  return scope === 'host' ? host : registrableDomain(host) === host ? host : null;
}

const exception = (value: unknown): value is StoredRiskException => record(value) && Object.keys(value).length === 4 && typeof value.id === 'string'
  && ID.test(value.id) && (value.scope === 'host' || value.scope === 'domain') && typeof value.value === 'string'
  && exceptionValue(value.scope, value.value) === value.value && typeof value.createdAt === 'number' && Number.isFinite(value.createdAt);

/** Settings this build can read; anything else reads as the defaults, so a broken value never turns alerts on. */
export function parseRiskSettings(value: unknown): RiskSettings {
  if (!record(value) || Object.keys(value).length !== 2 || typeof value.mode !== 'string' || !MODES.has(value.mode)
    || !Array.isArray(value.exceptions) || value.exceptions.length > RISK_EXCEPTION_LIMIT || !value.exceptions.every(exception)) return DEFAULT_RISK_SETTINGS;
  return value as unknown as RiskSettings;
}
/** This session's exceptions, as `chrome.storage.session` holds them. */
export function parseSessionExceptions(value: unknown): StoredRiskException[] {
  return Array.isArray(value) ? value.filter(exception).slice(0, RISK_EXCEPTION_LIMIT) : [];
}

/**
 * Test-only link-health probe injection. Real-stack and unit tests supply a JSON
 * file of per-URL responses so the worker never opens a socket. Production CLI
 * refuses this env var.
 */
import { readFileSync } from 'node:fs';
import {
  HardenedEgressError,
  type HardenedEgressConnector,
  type HardenedEgressResolver,
} from '../egress/index.js';
import type { LinkHealthWorkerLoopOptions } from './link-health-worker.js';

export const LINK_HEALTH_PROBE_FIXTURE_ENV = 'KNOWN_LINK_HEALTH_PROBE_FIXTURE';

interface LinkHealthProbeScript {
  readonly status: number;
  readonly location?: string;
  readonly denied?: boolean;
  readonly timeout?: boolean;
  readonly tls?: boolean;
}

interface LinkHealthProbeFixtureDocument {
  readonly pin: string;
  readonly scripts: Readonly<Record<string, LinkHealthProbeScript>>;
}

export type LinkHealthProbeInjection = Pick<LinkHealthWorkerLoopOptions, 'resolve' | 'connect'>;

export function linkHealthProbeInjectionFromEnv(
  env: NodeJS.ProcessEnv,
  nodeEnv: string,
): LinkHealthProbeInjection | undefined {
  const path = env[LINK_HEALTH_PROBE_FIXTURE_ENV]?.trim();
  if (!path) return undefined;
  if (nodeEnv === 'production') {
    throw new Error(
      'worker composition refused: KNOWN_LINK_HEALTH_PROBE_FIXTURE is not allowed in production',
    );
  }
  return createLinkHealthProbeFixtureFromFile(path);
}

export function createLinkHealthProbeFixtureFromFile(path: string): LinkHealthProbeInjection {
  const document = parseFixtureDocument(readFileSync(path, 'utf8'));
  const resolve: HardenedEgressResolver = async () => [document.pin];
  const connect: HardenedEgressConnector = async (target) => {
    const script = document.scripts[target.url.href];
    if (script === undefined) {
      return new Response(null, { status: 404 });
    }
    if (script.timeout === true) {
      const timeout = new Error('link-health probe timed out');
      timeout.name = 'AbortError';
      throw timeout;
    }
    if (script.tls === true) {
      const tls = new Error('unable to verify the first certificate');
      Object.assign(tls, { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' });
      throw tls;
    }
    if (script.denied === true) {
      throw new HardenedEgressError('denied_address', 'link-health resolves to a disallowed address');
    }
    const headers = script.location === undefined ? undefined : { location: script.location };
    return new Response(null, {
      status: script.status,
      ...(headers === undefined ? {} : { headers }),
    });
  };
  return Object.freeze({ resolve, connect });
}

function parseFixtureDocument(raw: string): LinkHealthProbeFixtureDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('link-health probe fixture is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('link-health probe fixture must be an object');
  }
  const record = parsed as { pin?: unknown; scripts?: unknown };
  if (typeof record.pin !== 'string' || record.pin.trim() === '') {
    throw new Error('link-health probe fixture pin must be a non-empty string');
  }
  if (record.scripts === null || typeof record.scripts !== 'object' || Array.isArray(record.scripts)) {
    throw new Error('link-health probe fixture scripts must be an object');
  }
  const scripts: Record<string, LinkHealthProbeScript> = {};
  for (const [url, value] of Object.entries(record.scripts as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`link-health probe fixture script for ${url} must be an object`);
    }
    const script = value as {
      status?: unknown; location?: unknown; denied?: unknown; timeout?: unknown; tls?: unknown;
    };
    if (!Number.isInteger(script.status) || Number(script.status) < 100 || Number(script.status) > 599) {
      throw new Error(`link-health probe fixture script for ${url} needs an HTTP status`);
    }
    if (script.location !== undefined && typeof script.location !== 'string') {
      throw new Error(`link-health probe fixture location for ${url} must be a string`);
    }
    if (script.denied !== undefined && typeof script.denied !== 'boolean') {
      throw new Error(`link-health probe fixture denied for ${url} must be a boolean`);
    }
    if (script.timeout !== undefined && typeof script.timeout !== 'boolean') {
      throw new Error(`link-health probe fixture timeout for ${url} must be a boolean`);
    }
    if (script.tls !== undefined && typeof script.tls !== 'boolean') {
      throw new Error(`link-health probe fixture tls for ${url} must be a boolean`);
    }
    scripts[url] = Object.freeze({
      status: Number(script.status),
      ...(typeof script.location === 'string' ? { location: script.location } : {}),
      ...(script.denied === true ? { denied: true } : {}),
      ...(script.timeout === true ? { timeout: true } : {}),
      ...(script.tls === true ? { tls: true } : {}),
    });
  }
  return Object.freeze({ pin: record.pin, scripts: Object.freeze(scripts) });
}

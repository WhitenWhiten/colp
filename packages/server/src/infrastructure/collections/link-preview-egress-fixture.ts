/**
 * Test-only link preview egress. Real-stack runs point the worker at a JSON
 * file of per-URL responses so it never opens a socket (hardened egress would
 * rightly refuse a localhost fixture server). Production refuses the env var.
 *
 * Document: { "pin": "<public ip>", "routes": { "<absolute url>":
 *   { "status"?: 200, "contentType": "...", "bodyBase64": "..." } } }
 * Unrouted URLs answer 404.
 */
import { readFileSync } from 'node:fs';
import type { HardenedEgressConnector, HardenedEgressResolver } from '../egress/index.js';

export const LINK_PREVIEW_EGRESS_FIXTURE_ENV = 'KNOWN_LINK_PREVIEW_EGRESS_FIXTURE';

interface LinkPreviewFixtureRoute {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
}

export interface LinkPreviewEgressInjection {
  readonly resolve: HardenedEgressResolver;
  readonly connect: HardenedEgressConnector;
}

export function linkPreviewEgressFromEnv(env: NodeJS.ProcessEnv, nodeEnv: string): LinkPreviewEgressInjection | undefined {
  const path = env[LINK_PREVIEW_EGRESS_FIXTURE_ENV]?.trim();
  if (!path) return undefined;
  if (nodeEnv === 'production') {
    throw new Error(`worker composition refused: ${LINK_PREVIEW_EGRESS_FIXTURE_ENV} is not allowed in production`);
  }
  return createLinkPreviewEgressFixture(readFileSync(path, 'utf8'));
}

export function createLinkPreviewEgressFixture(raw: string): LinkPreviewEgressInjection {
  const parsed = JSON.parse(raw) as { pin?: unknown; routes?: unknown };
  if (typeof parsed.pin !== 'string' || parsed.pin.trim() === '') {
    throw new Error('link preview egress fixture pin must be a non-empty string');
  }
  if (parsed.routes === null || typeof parsed.routes !== 'object' || Array.isArray(parsed.routes)) {
    throw new Error('link preview egress fixture routes must be an object');
  }
  const routes = new Map<string, LinkPreviewFixtureRoute>();
  for (const [url, value] of Object.entries(parsed.routes as Record<string, unknown>)) {
    const route = value as { status?: unknown; contentType?: unknown; bodyBase64?: unknown };
    if (typeof route.contentType !== 'string' || typeof route.bodyBase64 !== 'string') {
      throw new Error(`link preview egress fixture route ${url} needs contentType and bodyBase64`);
    }
    routes.set(new URL(url).href, {
      status: Number.isInteger(route.status) ? Number(route.status) : 200,
      contentType: route.contentType,
      body: Buffer.from(route.bodyBase64, 'base64'),
    });
  }
  const pin = parsed.pin;
  const resolve: HardenedEgressResolver = async () => [pin];
  const connect: HardenedEgressConnector = async (target) => {
    const route = routes.get(target.url.href);
    if (route === undefined) return new Response('missing', { status: 404 });
    return new Response(new Uint8Array(route.body), { status: route.status, headers: { 'content-type': route.contentType } });
  };
  return Object.freeze({ resolve, connect });
}

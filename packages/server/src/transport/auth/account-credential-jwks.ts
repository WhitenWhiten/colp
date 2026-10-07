import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { mergeAutomationJwks, type AccountCredentialsEs256PublicJwk } from '../../modules/auth/index.js';

const JWKS_PATH = '/api/v1/auth/jwks';

export function registerAccountCredentialJwks(
  app: FastifyInstance,
  deps: {
    readonly enabled: boolean;
    readonly oauthIssuerEnabled: boolean;
    readonly publicKeys: readonly AccountCredentialsEs256PublicJwk[];
  },
): void {
  if (!deps.enabled || deps.publicKeys.length === 0) return;
  const current = deps.publicKeys[0] ?? null;
  const previous = deps.publicKeys.slice(1);
  app.addHook('onSend', async (request, reply, payload) => {
    if (!isJwksGet(request) || reply.statusCode !== 200) return payload;
    const document = parseJwksPayload(payload);
    if (document === null) return payload;
    return sendMergedJwks(reply, mergeAutomationJwks(document, current, previous));
  });
  if (!deps.oauthIssuerEnabled) {
    app.get(JWKS_PATH, {
      exposeHeadRoute: false,
      config: {
        productTransport: { allowedQuery: [], cacheControl: 'no-store' },
      },
    }, async (_request, reply) => {
      return sendJwks(reply, mergeAutomationJwks({ keys: [] }, current, previous));
    });
  }
}

function isJwksGet(request: FastifyRequest): boolean {
  return request.method === 'GET' && (request.url.split('?', 1)[0] ?? request.url) === JWKS_PATH;
}

function parseJwksPayload(payload: unknown): { keys: Record<string, unknown>[] } | null {
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && !Buffer.isBuffer(payload)) {
    const keys = (payload as { keys?: unknown }).keys;
    if (!Array.isArray(keys)) return { keys: [] };
    return { keys: keys as Record<string, unknown>[] };
  }
  const text = typeof payload === 'string'
    ? payload
    : Buffer.isBuffer(payload)
      ? payload.toString('utf8')
      : null;
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as { keys?: unknown };
    if (!parsed || !Array.isArray(parsed.keys)) return { keys: [] };
    return { keys: parsed.keys as Record<string, unknown>[] };
  } catch {
    return null;
  }
}

function sendMergedJwks(
  reply: FastifyReply,
  document: { readonly keys: readonly Record<string, unknown>[] },
): string {
  const body = JSON.stringify(document);
  reply.header('Cache-Control', 'no-store');
  reply.header('Content-Length', String(Buffer.byteLength(body)));
  reply.type('application/json; charset=utf-8');
  return body;
}

function sendJwks(reply: FastifyReply, document: { readonly keys: readonly Record<string, unknown>[] }): FastifyReply {
  return reply.code(200).header('Cache-Control', 'no-store').type('application/json; charset=utf-8').send(document);
}

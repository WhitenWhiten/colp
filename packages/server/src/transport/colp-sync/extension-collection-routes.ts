import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ExtensionAuthError, type ExtensionCredentialEvidencePort,
  type ExtensionOwnerSubjectPort } from '../../modules/identity/index.js';
import {
  assertValidCollectionTitle,
  createOwnedCollectionCanonical,
  getOwnedCollectionsPage,
  type GetOwnedCollectionsPagePorts,
  type OwnedCollectionFact,
  type ProductCollectionMutationUnitOfWork,
} from '../../modules/collections/index.js';
import { canonicalCommandFingerprint } from '../../modules/commands/index.js';
import { httpCommandScopeV1 } from '../http-command-scope.js';
import { colpAuthorizationFromRawHeaders } from './sync-colp-authorization.js';
import type { SyncTransportSecurity } from './sync-transport-security.js';

export const EXTENSION_COLLECTIONS_PATH = '/colp/v0.1/sync/collections';
const MAX_ITEMS = 100;
const IDEMPOTENCY = /^[A-Za-z0-9._~-]{1,512}$/u;
const COLP_CREATE_SCOPE = httpCommandScopeV1('POST', EXTENSION_COLLECTIONS_PATH);

export type { ExtensionOwnerSubjectPort };

export interface ExtensionOwnerAccount {
  readonly accountId: string;
  readonly subjectId: string;
}

export interface ExtensionOwnerAccountPort {
  resolveActiveAccount(identity: {
    readonly issuer: string; readonly subject: string;
  }): Promise<ExtensionOwnerAccount | null>;
}

export interface ExtensionCollectionRouteDependencies {
  readonly credentialVerifier: ExtensionCredentialEvidencePort;
  readonly ownedCollectionsQuery: GetOwnedCollectionsPagePorts;
  readonly ownerSubject: ExtensionOwnerSubjectPort;
  readonly allowedOrigins: readonly string[];
  readonly ownerAccount?: ExtensionOwnerAccountPort;
  readonly collectionMutation?: ProductCollectionMutationUnitOfWork;
  /** Shared Sync TLS/ingress admission; helper routes must not bypass it. */
  readonly transportSecurity?: SyncTransportSecurity;
}

interface ExtensionCollectionView {
  readonly id: string;
  readonly title: string;
  readonly kind: OwnedCollectionFact['kind'];
  readonly visibility: OwnedCollectionFact['visibility'];
  readonly rootNodeId: string;
}

/** COLP list is owned-only by contract (C-11), not an accident. */
export function registerExtensionCollectionRoutes(
  app: FastifyInstance,
  dependencies: ExtensionCollectionRouteDependencies,
): void {
  app.get(EXTENSION_COLLECTIONS_PATH, {
    config: { productTransport: { allowedQuery: [], cacheControl: 'private-no-store' } },
  }, async (request, reply) => {
    if (dependencies.transportSecurity && !dependencies.transportSecurity.isSecure(request)) {
      return deny(reply, 'authentication_required', 'A secure transport is required.');
    }
    const origin = normalizeOrigin(readHeader(request, 'origin'));
    if (origin !== undefined && !dependencies.allowedOrigins.includes(origin)) {
      return deny(reply, 'origin_not_allowed', 'The request origin is not allowed.');
    }
    const authorization = authorizationOf(request);
    try {
      const credential = await dependencies.credentialVerifier.verify({ authorization });
      const ownerSubjectId = await dependencies.ownerSubject.resolveOwnerSubject({
        issuer: credential.issuer, subject: credential.subject,
      });
      if (ownerSubjectId === null) {
        return deny(reply, 'invalid_token', 'The credential is not bound to an active account.');
      }
      const page = await getOwnedCollectionsPage(dependencies.ownedCollectionsQuery, {
        actor: { subjectId: ownerSubjectId }, limit: MAX_ITEMS,
      });
      const items: readonly ExtensionCollectionView[] = page.items.map((collection) => ({
        id: collection.id, title: collection.title, kind: collection.kind, visibility: collection.visibility,
        rootNodeId: collection.rootNodeId,
      }));
      return reply.code(200).type('application/json; charset=utf-8').send({ items });
    } catch (error: unknown) {
      return mapListError(request, reply, error);
    }
  });

  app.post(EXTENSION_COLLECTIONS_PATH, {
    config: { productTransport: { allowedQuery: [], acceptedMediaTypes: ['application/json'],
      bodyLimitBytes: 16_384, cacheControl: 'private-no-store' } },
  }, async (request, reply) => {
    if (dependencies.transportSecurity && !dependencies.transportSecurity.isSecure(request)) {
      return deny(reply, 'authentication_required', 'A secure transport is required.');
    }
    const origin = normalizeOrigin(readHeader(request, 'origin'));
    if (origin !== undefined && !dependencies.allowedOrigins.includes(origin)) {
      return deny(reply, 'origin_not_allowed', 'The request origin is not allowed.');
    }
    if (!dependencies.ownerAccount || !dependencies.collectionMutation) {
      return reply.code(503).type('application/json; charset=utf-8')
        .send({ error: { code: 'collections_unavailable', message: 'Owned collections are temporarily unavailable.' } });
    }
    const idempotencyKey = readIdempotencyKey(request);
    if (idempotencyKey === undefined) {
      return reply.code(400).type('application/json; charset=utf-8')
        .send({ error: { code: 'invalid_json', message: 'Idempotency-Key is required.' } });
    }
    const title = readCreateTitle(request.body);
    if (title === undefined) {
      return reply.code(400).type('application/json; charset=utf-8')
        .send({ error: { code: 'invalid_json', message: 'Body must be an object with title only.' } });
    }
    const authorization = authorizationOf(request);
    try {
      const credential = await dependencies.credentialVerifier.verify({ authorization });
      const owner = await dependencies.ownerAccount.resolveActiveAccount({
        issuer: credential.issuer, subject: credential.subject,
      });
      if (owner === null) {
        return deny(reply, 'invalid_token', 'The credential is not bound to an active account.');
      }
      const commandId = commandIdFromIdempotencyKey(idempotencyKey);
      const fingerprint = canonicalCommandFingerprint({
        method: 'POST', route: EXTENSION_COLLECTIONS_PATH, mediaType: 'application/json',
        body: { title }, query: {}, conditions: {},
      });
      const outcome = await dependencies.collectionMutation.execute((ports) =>
        createOwnedCollectionCanonical(ports, {
          actor: { principalId: owner.accountId, principalType: 'account', subjectId: owner.subjectId },
          command: { commandId, fingerprint, commandScope: COLP_CREATE_SCOPE },
          title, summary: null, kind: 'bookmarks',
        }));
      return sendColpCreate(reply, outcome);
    } catch (error: unknown) {
      if (error instanceof ExtensionAuthError || /authorization|credential|token|bearer/i.test(
        error instanceof Error ? error.message : '',
      )) {
        return deny(reply, 'invalid_token', error instanceof Error ? error.message : 'invalid_token');
      }
      request.log.warn({ reason: error instanceof Error ? error.message : 'create_failed' },
        'extension collection create failed');
      return reply.code(503).type('application/json; charset=utf-8')
        .send({ error: { code: 'collections_unavailable', message: 'Owned collections are temporarily unavailable.' } });
    }
  });
}

function sendColpCreate(
  reply: FastifyReply,
  outcome: Awaited<ReturnType<typeof createOwnedCollectionCanonical>>,
): FastifyReply {
  if (outcome.kind === 'created') {
    return reply.code(201).type('application/json; charset=utf-8').send({
      id: outcome.collection.id, title: outcome.collection.title, kind: outcome.collection.kind,
      visibility: outcome.collection.visibility, rootNodeId: outcome.collection.rootNodeId,
    } satisfies ExtensionCollectionView);
  }
  if (outcome.kind === 'replay') {
    const view = colpViewFromProductBody(outcome.body);
    if (view) return reply.code(200).type('application/json; charset=utf-8').send(view);
    return reply.code(409).type('application/json; charset=utf-8')
      .send({ error: { code: 'command_id_reused', message: 'The Idempotency-Key replay body is unusable.' } });
  }
  if (outcome.kind === 'in_progress') {
    reply.header('Retry-After', String(outcome.retryAfterSeconds));
    return reply.code(409).type('application/json; charset=utf-8')
      .send({ error: { code: 'command_in_progress', message: 'This create is still in progress.' } });
  }
  if (outcome.kind === 'reused') {
    return reply.code(409).type('application/json; charset=utf-8')
      .send({ error: { code: 'command_id_reused', message: 'This Idempotency-Key was used with a different body.' } });
  }
  return reply.code(410).type('application/json; charset=utf-8')
    .send({ error: { code: 'command_result_expired', message: 'The stored create result expired.' } });
}

function colpViewFromProductBody(body: Uint8Array): ExtensionCollectionView | null {
  try {
    const parsed = JSON.parse(Buffer.from(body).toString('utf8')) as Record<string, unknown>;
    const collection = parsed.collection;
    if (!collection || typeof collection !== 'object' || Array.isArray(collection)) return null;
    const record = collection as Record<string, unknown>;
    if (typeof record.id !== 'string' || typeof record.title !== 'string'
        || typeof record.kind !== 'string' || typeof record.visibility !== 'string'
        || typeof record.rootNodeId !== 'string') return null;
    return {
      id: record.id, title: record.title,
      kind: record.kind as OwnedCollectionFact['kind'],
      visibility: record.visibility as OwnedCollectionFact['visibility'],
      rootNodeId: record.rootNodeId,
    };
  } catch {
    return null;
  }
}

function commandIdFromIdempotencyKey(key: string): string {
  const hash = createHash('sha256').update('known.colp.sync.collections.v1\0').update(key).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x40;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function readCreateTitle(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || typeof record.title !== 'string') return undefined;
  try {
    return assertValidCollectionTitle(record.title);
  } catch {
    return undefined;
  }
}

function readIdempotencyKey(request: FastifyRequest): string | undefined {
  const fields = collectRawHeaders(request.raw.rawHeaders);
  const values = fields.get('idempotency-key') ?? [];
  if (values.length !== 1) return undefined;
  return IDEMPOTENCY.test(values[0]!) ? values[0] : undefined;
}

function mapListError(request: FastifyRequest, reply: FastifyReply, error: unknown): FastifyReply {
  const message = error instanceof Error ? error.message : 'collection_list_failed';
  if (error instanceof ExtensionAuthError || /authorization|credential|token|bearer/i.test(message)) {
    return deny(reply, 'invalid_token', message);
  }
  request.log.warn({ reason: message }, 'extension collection list failed');
  return reply.code(503).type('application/json; charset=utf-8')
    .send({ error: { code: 'collections_unavailable', message: 'Owned collections are temporarily unavailable.' } });
}

function readHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) return undefined;
  return typeof value === 'string' ? value : undefined;
}
function normalizeOrigin(origin: string | undefined): string | undefined {
  return origin?.replace(/\/$/u, '');
}
function authorizationOf(request: FastifyRequest): string | undefined {
  const admitted = colpAuthorizationFromRawHeaders(collectRawHeaders(request.raw.rawHeaders));
  return 'authorization' in admitted ? admitted.authorization : undefined;
}
function collectRawHeaders(raw: readonly string[]): Map<string, string[]> {
  const fields = new Map<string, string[]>();
  for (let index = 0; index < raw.length; index += 2) {
    const name = raw[index]!.toLowerCase();
    const values = fields.get(name) ?? [];
    values.push(raw[index + 1]!);
    fields.set(name, values);
  }
  return fields;
}
function deny(reply: FastifyReply, code: string, message: string): FastifyReply {
  return reply.code(401).type('application/json; charset=utf-8').send({ error: { code, message } });
}

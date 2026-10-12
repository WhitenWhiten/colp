import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { Request } from '@playwright/test';
import { domainSeparatedPhase3MetadataDigest } from '../scripts/phase3-marker-scan.mjs';

export function sha(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

export function splitMarker(value: string): string[] {
  const middle = Math.floor(value.length / 2);
  return [value.slice(0, middle), value.slice(middle)];
}

export function secretMarkers(value: string) {
  const suffix = sha(value).slice(0, 20);
  return [`P3-38 confidential ${suffix}`,
    `https://marker.invalid/${suffix}`, `p3-38-extension-${suffix}`] as const;
}

export function redactUrl(value: string) {
  const url = new URL(value);
  const fixedPath = /^\/(?:colp\/v0\.1\/sync\/(?:sessions|push|pull|ack|snapshot)|oauth2\/token)$/u.test(url.pathname);
  const pathname = fixedPath ? url.pathname
    : `/__redacted_path__/${domainSeparatedPhase3MetadataDigest('url-path', url.pathname)}`;
  return `${url.origin}${pathname}`;
}

export function containsJsonString(value: unknown, expected: string): boolean {
  if (value === expected) return true;
  if (Array.isArray(value)) return value.some((item) => containsJsonString(item, expected));
  return !!value && typeof value === 'object'
    && Object.values(value as Record<string, unknown>).some((item) => containsJsonString(item, expected));
}

export function containsFieldValue(value: unknown, field: string, expected: string): boolean {
  if (Array.isArray(value)) return value.some((item) => containsFieldValue(item, field, expected));
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record[field] === expected || Object.values(record).some((item) => containsFieldValue(item, field, expected));
}

export function secretMetadata(value: string | null, label: string) {
  return value === null ? { present: false, length: 0 }
    : { present: true, length: value.length, digest: domainSeparatedPhase3MetadataDigest(label, value) };
}

export function credentialTokenMetadata(value: string | null, label: string) {
  if (value === null) return { present: false, length: 0, segments: 0 };
  const segments = value.split('.');
  return { present: true, length: value.length,
    digest: domainSeparatedPhase3MetadataDigest(label, value), segments: segments.length,
    firstSegmentDigest: domainSeparatedPhase3MetadataDigest(`${label}-first-segment`, segments[0] ?? '') };
}

export function diagnosticMetadata(value: unknown, label: string) {
  if (value === undefined) return { present: false, type: 'undefined' };
  const serialized = JSON.stringify(value);
  return { present: true, type: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
    bytes: new TextEncoder().encode(serialized ?? '').byteLength,
    digest: domainSeparatedPhase3MetadataDigest(label, serialized ?? '') };
}

export function snapshotMetadata(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { shape: 'non-object' };
  const snapshot = value as Record<string, unknown>;
  const collection = snapshot.collection && typeof snapshot.collection === 'object'
    && !Array.isArray(snapshot.collection) ? snapshot.collection as Record<string, unknown> : {};
  const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
  const parentRevisions = Array.isArray(snapshot.parentRevisions) ? snapshot.parentRevisions : [];
  return {
    keys: Object.keys(snapshot).sort(),
    protocolVersion: snapshot.protocolVersion,
    nodeCount: nodes.length,
    parentRevisionCount: parentRevisions.length,
    nodes: nodes.map((node) => {
      const record = node && typeof node === 'object' && !Array.isArray(node)
        ? node as Record<string, unknown> : {};
      return { kind: record.kind, isRoot: record.id === collection.rootNodeId,
        parentNull: record.parentId === null, positionType: record.position === null ? 'null' : typeof record.position };
    }),
  };
}

export function safeDiagnosticCode(value: unknown) {
  return typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/iu.test(value)
    ? value : undefined;
}

export function pullQueryMetadata(url: URL) {
  const fields = [...url.searchParams.keys()];
  const sessionId = url.searchParams.get('sessionId');
  const cursor = url.searchParams.get('cursor');
  const cursorPrefix = cursor?.startsWith('spc2.') ? 'spc2'
    : cursor?.startsWith('src1.') ? 'src1' : cursor ? 'other' : 'missing';
  return { fields, fieldCount: fields.length, sessionId: secretMetadata(sessionId, 'pull-session-id'), cursor: {
    ...secretMetadata(cursor, 'pull-cursor'), prefix: cursorPrefix }, limit: url.searchParams.get('limit') };
}

export function snapshotQueryMetadata(url: URL) {
  const fields = [...url.searchParams.keys()];
  return { fields, fieldCount: fields.length,
    session: secretMetadata(url.searchParams.get('sessionId'), 'snapshot-session-id'),
    pageCursor: secretMetadata(url.searchParams.get('pageCursor'), 'snapshot-page-cursor'),
    limit: url.searchParams.get('limit') };
}

export function syncAuthorityMetadata(request: Request) {
  const headers = request.headers();
  const session = headers['known-sync-session'] ?? null;
  const cookie = headers.cookie ?? null;
  const authorization = headers.authorization ?? '';
  const token = authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length) : '';
  let claims: Record<string, unknown> = {};
  try { claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>; }
  catch { claims = {}; }
  const claim = (name: string) => typeof claims[name] === 'string' ? claims[name] as string : null;
  const audience = typeof claims.aud === 'string' ? claims.aud
    : Array.isArray(claims.aud) && claims.aud.every((value) => typeof value === 'string')
      ? [...claims.aud].sort().join('\n') : null;
  const facts = { headerSession: secretMetadata(session, 'authority-header-session'),
    cookie: secretMetadata(cookie, 'authority-cookie'),
    credentialSubject: secretMetadata(claim('sub'), 'authority-credential-subject'),
    credentialId: secretMetadata(claim('jti'), 'authority-credential-id'),
    issuer: secretMetadata(claim('iss'), 'authority-issuer'),
    audience: secretMetadata(audience, 'authority-audience') };
  return { ...facts, authorityDigest: sha(JSON.stringify(facts)) };
}

export function syncRequestMetadata(url: URL, raw: string | null) {
  if (raw === null) return { present: false, bytes: 0 };
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return { present: true, bytes: raw.length, parse: 'invalid_json' }; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { present: true, bytes: raw.length, parse: 'non_object' };
  }
  const record = body as Record<string, unknown>;
  const fields = Object.keys(record);
  if (url.pathname.endsWith('/sync/sessions')) return { present: true, bytes: raw.length, fields, fieldCount: fields.length };
  const sessionId = typeof record.sessionId === 'string' ? record.sessionId : null;
  const cursor = typeof record.cursor === 'string' ? record.cursor : null;
  return { present: true, bytes: raw.length, fields, fieldCount: fields.length,
    sessionId: secretMetadata(sessionId, 'request-session-id'), cursor: { ...secretMetadata(cursor, 'request-cursor'),
      prefix: cursor?.startsWith('spc2.') ? 'spc2' : cursor?.startsWith('src1.') ? 'src1' : cursor ? 'other' : 'missing' } };
}

export function boundedRetryAfter(value: unknown) {
  const parsed = typeof value === 'string' && /^[1-9][0-9]{0,3}$/u.test(value)
    ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 3_600 ? parsed : undefined;
}

export function safeProblemFields(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { parse: 'non_object' };
  const problem = value as Record<string, unknown>;
  const recovery = problem.recovery && typeof problem.recovery === 'object'
    && !Array.isArray(problem.recovery) ? problem.recovery as Record<string, unknown> : null;
  const retryAfterSeconds = boundedRetryAfter(problem.retryAfterSeconds ?? recovery?.retryAfterSeconds);
  const code = typeof problem.code === 'string'
    && /^[a-z][a-z0-9_]{0,63}$/u.test(problem.code) ? problem.code : undefined;
  return {
    ...(code ? { code } : {}),
    ...(typeof problem.retryable === 'boolean' ? { retryable: problem.retryable } : {}),
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
}

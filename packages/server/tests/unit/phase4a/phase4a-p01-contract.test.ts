/**
 * P4A-P01 owner-private Attachment Product contract (machine contract).
 *
 * This suite reads the REAL authored OpenAPI (openapi/product-v1.yaml), pins
 * the 1.15.0 additive surface operation-by-operation, compiles the REAL
 * request/response schemas with AJV to prove unknown-field rejection and the
 * size/media boundaries, cross-checks the media allowlist and the hard size
 * ceiling against the PRODUCTION attachments module constants, pins the
 * secret/non-loggable grant fields and their isolation (grant appears only in
 * the one-time issue response), pins the error-code table against the
 * production transport table, and re-runs the real catalog / breaking /
 * generated-drift gates. Text-only YAML greps are never enough here: every
 * semantic is exercised through the parsed schema or the gate scripts.
 *
 * Anti-false-negative notes (plan §4.2): 404 concealment is the contract and
 * internal 403s are NOT required; the generated client version and the schema
 * digest are pinned exactly (no formatting-tolerant matching).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';
import { test } from 'vitest';
import {
  ATTACHMENTS_ALLOWED_MEDIA_ALLOWLIST,
  ATTACHMENTS_SINGLE_PUT_HARD_CEILING_BYTES,
} from '../../../src/modules/attachments/index.js';
import {
  ATTACHMENT_ERROR_CODES, ATTACHMENT_ERROR_STATUS,
} from '../../../src/transport/product/attachment-error.js';
import { PRODUCT_ROUTE_MANIFEST } from '../../../generated/openapi/product-v1.routes.js';

const backendRoot = resolve(import.meta.dirname, '../../..');
const sourcePath = 'openapi/product-v1.yaml';

type UnknownRecord = Record<string, unknown>;
interface OpenApiDocument {
  info: { version: string };
  tags: Array<{ name: string; description?: string }>;
  paths: Record<string, Record<string, Operation>>;
  components: {
    headers: Record<string, UnknownRecord>;
    parameters: Record<string, UnknownRecord>;
    responses: Record<string, UnknownRecord>;
    schemas: Record<string, UnknownRecord>;
    securitySchemes: Record<string, UnknownRecord>;
  };
}
interface Operation {
  operationId: string;
  security?: Array<Record<string, unknown>>;
  parameters?: Array<{ $ref?: string }>;
  requestBody?: UnknownRecord;
  responses: Record<string, UnknownRecord>;
}

const httpMethods = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace']);
function readDocument(path = sourcePath): OpenApiDocument {
  return parse(readFileSync(path, 'utf8')) as OpenApiDocument;
}

function operations(document: OpenApiDocument): Array<{ path: string; method: string; operation: Operation }> {
  return Object.entries(document.paths).flatMap(([path, pathItem]) =>
    Object.entries(pathItem)
      .filter(([method]) => httpMethods.has(method))
      .map(([method, operation]) => ({ path, method, operation: operation as Operation })),
  );
}

function parameterRefs(operation: Operation): Set<string> {
  return new Set((operation.parameters ?? []).map((parameter) => parameter.$ref).filter(Boolean) as string[]);
}

function resolveRef(document: OpenApiDocument, ref: string): unknown {
  assert.match(ref, /^#\//);
  return ref
    .slice(2)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce<unknown>((current, segment) => {
      assert.ok(current && typeof current === 'object' && segment in current, `unresolved reference: ${ref}`);
      return (current as UnknownRecord)[segment];
    }, document);
}

/** Deep-dereferences local $refs so AJV can compile a standalone schema. */
function dereference(document: OpenApiDocument, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => dereference(document, item));
  if (value === null || typeof value !== 'object') return value;
  const record = value as UnknownRecord;
  if (typeof record.$ref === 'string') return dereference(document, resolveRef(document, record.$ref));
  return Object.fromEntries(
    Object.entries(record).map(([key, child]) => [key, dereference(document, child)]),
  );
}

function compileSchema(document: OpenApiDocument, name: string): (value: unknown) => boolean {
  const schema = document.components.schemas[name];
  assert.ok(schema, `missing schema ${name}`);
  const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: true });
  addFormats(ajv);
  const validate = ajv.compile(dereference(document, schema) as object);
  return (value: unknown) => validate(value) === true;
}

function resolvedResponse(document: OpenApiDocument, response: UnknownRecord): UnknownRecord {
  if (typeof response.$ref === 'string') {
    return resolveRef(document, response.$ref) as UnknownRecord;
  }
  return response;
}

function responseSchemaRef(response: UnknownRecord): string | undefined {
  const content = response.content as UnknownRecord | undefined;
  const media = content?.['application/json'] as UnknownRecord | undefined;
  const schema = media?.schema as UnknownRecord | undefined;
  return typeof schema?.$ref === 'string' ? schema.$ref : undefined;
}

function collectPropertyNames(schema: UnknownRecord, out: string[] = []): string[] {
  const properties = schema.properties as UnknownRecord | undefined;
  if (properties) {
    for (const [name, child] of Object.entries(properties)) {
      out.push(name);
      if (child && typeof child === 'object') collectPropertyNames(child as UnknownRecord, out);
    }
  }
  return out;
}

const EXPECTED_OPERATIONS: ReadonlyArray<readonly [string, string, string]> = [
  ['post', '/api/v1/attachments/issue', 'issueAttachmentUpload'],
  ['post', '/api/v1/attachments/complete', 'completeAttachmentUpload'],
  ['get', '/api/v1/attachments/{blobId}', 'getAttachmentStatus'],
  ['post', '/api/v1/attachments/{blobId}/finalize', 'finalizeAttachment'],
  ['post', '/api/v1/attachments/{blobId}/replacement', 'issueAttachmentReplacement'],
  ['post', '/api/v1/attachments/{blobId}/retire', 'retireAttachment'],
  ['post', '/api/v1/attachments/{blobId}/download', 'admitAttachmentDownload'],
] as const;

const ERROR_STATUSES = ['400', '401', '403', '404', '409', '413', '415', '422', '429', '500', '503'];

test('P4A-P01 freezes the additive 1.15.0 Attachment operation surface', () => {
  const document = readDocument();
  const tag = document.tags.find((entry) => entry.name === 'Attachments');
  assert.ok(tag, 'Attachments tag missing');
  assert.match(String(tag.description ?? ''), /owner-private/i);
  assert.match(String(tag.description ?? ''), /public|shared|inline/i);

  const byId = new Map(operations(document).map(({ operation }) => [operation.operationId, operation]));
  for (const [method, path, operationId] of EXPECTED_OPERATIONS) {
    const operation = byId.get(operationId);
    assert.ok(operation, operationId);
    assert.deepEqual(operation.security, [{ cookieAuth: [] }], `${operationId} must be session-private`);
    const refs = parameterRefs(operation);
    if (path.includes('{blobId}')) {
      assert.ok(refs.has('#/components/parameters/AttachmentBlobIdPath'), `${operationId} missing blobId path parameter`);
    }
    if (operationId === 'getAttachmentStatus') {
      assert.deepEqual([...refs].sort(), ['#/components/parameters/AttachmentBlobIdPath']);
    } else if (operationId === 'admitAttachmentDownload') {
      assert.deepEqual([...refs].sort(),
        ['#/components/parameters/AttachmentBlobIdPath', '#/components/parameters/CsrfToken', '#/components/parameters/Origin']);
    } else {
      for (const ref of ['#/components/parameters/Origin', '#/components/parameters/CsrfToken', '#/components/parameters/CommandId']) {
        assert.ok(refs.has(ref), `${operationId} is missing the idempotency/CSRF header ${ref}`);
      }
    }
  }
});

test('every Attachment operation documents the full closed-state error contract', () => {
  const document = readDocument();
  const byId = new Map(operations(document).map(({ operation }) => [operation.operationId, operation]));
  for (const [method, , operationId] of EXPECTED_OPERATIONS) {
    const operation = byId.get(operationId)!;
    const statuses = new Set(Object.keys(operation.responses));
    const isRead = operationId === 'getAttachmentStatus' || operationId === 'admitAttachmentDownload';
    const success = isRead ? '200' : (operationId === 'issueAttachmentUpload' || operationId === 'issueAttachmentReplacement' ? '201' : '200');
    assert.ok(statuses.has(success), `${operationId} missing ${success}`);
    for (const status of ERROR_STATUSES) {
      const required = isRead
        ? ['400', '401', '404', '429', '500', '503'].includes(status)
        : status !== '403' || method === 'post';
      if (required) assert.ok(statuses.has(status), `${operationId} missing ${status}`);
    }
    // Concealment contract: 404 is present on every operation, and the
    // read/status operation must NOT hard-bind an internal 403.
    assert.ok(statuses.has('404'), `${operationId} must conceal with 404`);
    if (operationId === 'getAttachmentStatus') {
      assert.equal(statuses.has('403'), false, 'status read must not hard-bind an internal 403');
    }
  }
});

test('every Attachment response uses private no-store and the single Attachment envelope', () => {
  const document = readDocument();
  const byId = new Map(operations(document).map(({ operation }) => [operation.operationId, operation]));
  for (const [, , operationId] of EXPECTED_OPERATIONS) {
    const operation = byId.get(operationId)!;
    for (const [status, rawResponse] of Object.entries(operation.responses)) {
      const response = resolvedResponse(document, rawResponse);
      const headers = response.headers as UnknownRecord;
      assert.equal((headers['Cache-Control'] as UnknownRecord)?.$ref, '#/components/headers/PrivateNoStore',
        `${operationId} ${status} cache policy`);
      assert.equal((headers['X-Request-Id'] as UnknownRecord)?.$ref, '#/components/headers/XRequestId',
        `${operationId} ${status} request id`);
      const ref = responseSchemaRef(response);
      if (status === '200' || status === '201') {
        assert.ok(ref, `${operationId} ${status} must declare a success body`);
      } else {
        assert.equal(ref, '#/components/schemas/AttachmentErrorEnvelope',
          `${operationId} ${status} must use the Attachment envelope`);
      }
    }
  }
  // 429 carries Retry-After + RateLimit-Policy; 503 rate-limit unavailable and
  // 409 conflict must NOT carry a fabricated Retry-After quota fact.
  const rateLimited = document.components.responses.AttachmentRateLimited;
  assert.ok((rateLimited.headers as UnknownRecord)['Retry-After']);
  assert.ok((rateLimited.headers as UnknownRecord)['RateLimit-Policy']);
  const unavailable = document.components.responses.AttachmentServiceUnavailable;
  assert.equal((unavailable.headers as UnknownRecord)['Retry-After'], undefined,
    '503 rate_limit_unavailable/not-implemented must not carry Retry-After');
  const conflict = document.components.responses.AttachmentStateConflict;
  assert.equal((conflict.headers as UnknownRecord)['Retry-After'], undefined,
    '409 conflict must not carry Retry-After');
  assert.match(String(conflict.description), /attachment_idempotency_conflict/);
});

test('AttachmentErrorCode is pinned to the production transport table', () => {
  const document = readDocument();
  const schema = document.components.schemas.AttachmentErrorCode as UnknownRecord;
  const codes = schema.enum as string[];
  assert.deepEqual(codes, [...ATTACHMENT_ERROR_CODES], 'OpenAPI enum must equal the transport table');
  for (const code of codes) {
    assert.equal(typeof ATTACHMENT_ERROR_STATUS[code as (typeof ATTACHMENT_ERROR_CODES)[number]], 'number',
      `transport status missing for ${code}`);
    assert.doesNotMatch(code, /clean|safe|scan|malware/i, `${code} must not imply safety`);
  }
  assert.ok(codes.includes('rate_limit_unavailable'), '503 rate_limit_unavailable missing');
  assert.ok(codes.includes('attachments_not_implemented'), '503 attachments_not_implemented missing');
  assert.ok(codes.includes('resource_not_found'), '404 concealment code missing');
  assert.ok(codes.includes('attachment_state_conflict'), '409 state conflict code missing');
  // The frozen shared ProductErrorCode enum must not have been widened.
  const shared = document.components.schemas.ProductErrorCode as UnknownRecord;
  assert.equal(shared.enum.includes('rate_limit_unavailable'), false);
  assert.equal(shared.enum.includes('attachments_not_implemented'), false);
});

test('unknown fields, size and media boundaries are enforced by the real schemas', () => {
  const document = readDocument();
  const issueRequest = compileSchema(document, 'AttachmentIssueRequest');
  const completeRequest = compileSchema(document, 'AttachmentCompleteRequest');
  const replacementRequest = compileSchema(document, 'AttachmentReplacementRequest');
  const envelope = compileSchema(document, 'AttachmentErrorEnvelope');

  const validIssue = {
    collectionId: 'collection-1',
    declaredSize: 1024,
    declaredSha256: 'a'.repeat(64),
    mediaHint: 'image/png',
    expectedPolicyRevision: 'policy-1',
  };
  assert.equal(issueRequest(validIssue), true);
  assert.equal(issueRequest({ ...validIssue, unexpectedField: true }), false, 'unknown field must be rejected');
  assert.equal(issueRequest({ ...validIssue, declaredSize: ATTACHMENTS_SINGLE_PUT_HARD_CEILING_BYTES }), true,
    'exact hard ceiling must pass');
  assert.equal(issueRequest({ ...validIssue, declaredSize: ATTACHMENTS_SINGLE_PUT_HARD_CEILING_BYTES + 1 }), false,
    'one byte over the hard ceiling must fail');
  assert.equal(issueRequest({ ...validIssue, declaredSize: -1 }), false);
  assert.equal(issueRequest({ ...validIssue, declaredSize: 0 }), true);
  assert.equal(issueRequest({ ...validIssue, declaredSha256: 'A'.repeat(64) }), false, 'uppercase digest must fail');
  assert.equal(issueRequest({ ...validIssue, declaredSha256: 'xyz' }), false);
  assert.equal(issueRequest({ ...validIssue, mediaHint: 'image/gif' }), true);
  assert.equal(issueRequest({ ...validIssue, mediaHint: 'text/html' }), false, 'media outside the allowlist must fail');
  assert.equal(issueRequest({ ...validIssue, mediaHint: null }), true);

  const validComplete = {
    binding: { intentId: 'intent-1', generationId: 'generation-1', blobId: 'blob-1' },
    declared: { size: 1024, sha256: 'b'.repeat(64), mediaType: 'application/pdf', etag: '"etag-1"' },
  };
  assert.equal(completeRequest(validComplete), true);
  assert.equal(completeRequest({ ...validComplete, binding: { ...validComplete.binding, key: 'physical-key' } }), false,
    'a physical key field must never be accepted');
  assert.equal(completeRequest({ ...validComplete, declared: { ...validComplete.declared, mediaType: 'video/mp4' } }), false);
  assert.equal(completeRequest({ ...validComplete, declared: { ...validComplete.declared, size: 67108865 } }), false);

  assert.equal(replacementRequest({ declaredSize: 2048, mediaHint: null }), true);
  assert.equal(replacementRequest({ declaredSize: 2048, extra: 1 }), false);

  const validEnvelope = {
    error: {
      code: 'attachments_not_implemented', message: 'not implemented', requestId: 'req-1',
      recovery: 'none', sameRequestRetrySafe: false, precondition: null, currentEtag: null,
      retryAfterSeconds: null, fieldErrors: [],
    },
  };
  assert.equal(envelope(validEnvelope), true);
  assert.equal(envelope({ ...validEnvelope, error: { ...validEnvelope.error, grant: { url: 'x' } } }), false,
    'a grant must never fit inside an error envelope');
  assert.equal(envelope({ ...validEnvelope, error: { ...validEnvelope.error, code: 'clean' } }), false,
    'a clean verdict code must never be expressible');

  // Machine contract links the OpenAPI boundaries to the PRODUCTION constants
  // (anti-false-positive: no hand-written duplicate of the module contract).
  const sizeSchema = (document.components.schemas.AttachmentIssueRequest as UnknownRecord)
    .properties as UnknownRecord;
  assert.equal((sizeSchema.declaredSize as UnknownRecord).maximum, ATTACHMENTS_SINGLE_PUT_HARD_CEILING_BYTES);
  assert.deepEqual(
    (document.components.schemas.AttachmentMediaType as UnknownRecord).enum,
    [...ATTACHMENTS_ALLOWED_MEDIA_ALLOWLIST],
  );
});

test('grant and capability fields are secret-marked, one-time, and isolated', () => {
  const document = readDocument();
  const grantUrl = ((document.components.schemas.UploadGrantDto as UnknownRecord)
    .properties as UnknownRecord).url as UnknownRecord;
  assert.equal(grantUrl['x-known-secret'], true, 'grant url must be machine-marked secret');
  const downloadUrl = ((document.components.schemas.AttachmentDownloadAdmission as UnknownRecord)
    .properties as UnknownRecord).downloadUrl as UnknownRecord;
  assert.equal(downloadUrl['x-known-secret'], true, 'capability url must be machine-marked secret');

  // Exactly two secret-marked fields exist in the whole Attachment surface.
  const secretFields: string[] = [];
  for (const [name, schema] of Object.entries(document.components.schemas)) {
    if (!name.startsWith('Attachment') && name !== 'UploadGrantDto') continue;
    const walk = (value: UnknownRecord, path: string) => {
      if (value['x-known-secret'] === true) secretFields.push(path);
      for (const [key, child] of Object.entries(value.properties ?? {})) {
        if (child && typeof child === 'object') walk(child as UnknownRecord, `${path}.${key}`);
      }
    };
    walk(schema, name);
  }
  assert.deepEqual(secretFields.sort(),
    ['AttachmentDownloadAdmission.downloadUrl', 'UploadGrantDto.url']);

  // The grant is referenced ONLY by the one-time issue/replacement result.
  const grantRefs: string[] = [];
  for (const [name, schema] of Object.entries(document.components.schemas)) {
    const walk = (value: unknown) => {
      if (Array.isArray(value)) return value.forEach(walk);
      if (value === null || typeof value !== 'object') return;
      if ((value as UnknownRecord).$ref === '#/components/schemas/UploadGrantDto') grantRefs.push(name);
      Object.values(value as UnknownRecord).forEach(walk);
    };
    walk(schema);
  }
  assert.deepEqual(grantRefs, ['AttachmentIssueResult']);

  // URI fields in the Attachment surface are exactly grant.url, deliveryOrigin,
  // downloadUrl — nothing else can carry a provider URL.
  const uriFields: string[] = [];
  for (const [name, schema] of Object.entries(document.components.schemas)) {
    if (!name.startsWith('Attachment') && name !== 'UploadGrantDto') continue;
    const walk = (value: UnknownRecord, path: string) => {
      for (const [key, child] of Object.entries(value.properties ?? {})) {
        if (!child || typeof child !== 'object') continue;
        const record = child as UnknownRecord;
        if (record.format === 'uri') uriFields.push(`${path}.${key}`);
        walk(record, `${path}.${key}`);
      }
    };
    walk(schema, name);
  }
  assert.deepEqual(uriFields.sort(), [
    'AttachmentDownloadAdmission.deliveryOrigin',
    'AttachmentDownloadAdmission.downloadUrl',
    'UploadGrantDto.url',
  ]);

  // Receipt/status/error DTOs must never expose URL/key/credential-shaped fields.
  for (const name of ['AttachmentReceipt', 'AttachmentStatusDto', 'AttachmentCompleteResult',
    'AttachmentFinalizeResult', 'AttachmentRetireResult', 'AttachmentError', 'AttachmentErrorEnvelope']) {
    const names = collectPropertyNames(document.components.schemas[name]!);
    for (const property of names) {
      assert.doesNotMatch(property, /url|key|credential|token|grant|capability|signature/i,
        `${name} must not expose ${property}`);
    }
  }
});

test('status vocabulary never implies safety and no shared/public/inline capability is declared', () => {
  const document = readDocument();
  assert.deepEqual((document.components.schemas.AttachmentLogicalState as UnknownRecord).enum,
    ['issued', 'uploaded', 'verifying', 'stored_private', 'attached_private', 'quarantined', 'expired', 'retired']);
  assert.deepEqual((document.components.schemas.AttachmentVerificationStatus as UnknownRecord).enum,
    ['pending', 'verifying', 'verified', 'failed']);
  assert.deepEqual((document.components.schemas.AttachmentAvailability as UnknownRecord).enum,
    ['unavailable', 'available']);
  assert.match(String((document.components.schemas.AttachmentVerificationStatus as UnknownRecord).description ?? ''),
    /malware/i);

  for (const [name, schema] of Object.entries(document.components.schemas)) {
    if (!name.startsWith('Attachment') && name !== 'UploadGrantDto') continue;
    assert.doesNotMatch(name, /clean|safe|scan|public|shared|inline/i, `schema name ${name}`);
    const names = collectPropertyNames(schema);
    for (const property of names) {
      // sameRequestRetrySafe is the pre-existing generic retry-safety flag of
      // the shared Product error envelope (it answers "may I replay the same
      // request?", never "is this blob malware-safe") and is pinned by the
      // routes suite; it is not Attachment status vocabulary.
      if (property === 'sameRequestRetrySafe') continue;
      assert.doesNotMatch(property, /clean|safe|scan|malware|public|shared|inline/i,
        `${name}.${property} must not imply safety or sharing`);
    }
    const walk = (value: unknown) => {
      if (Array.isArray(value)) return value.forEach(walk);
      if (value === null || typeof value !== 'object') return;
      if (Array.isArray((value as UnknownRecord).enum)) {
        for (const entry of (value as UnknownRecord).enum as string[]) {
          assert.doesNotMatch(String(entry), /clean|safe|scan|public|shared|inline/i,
            `${name} enum value ${entry}`);
        }
      }
      Object.values(value as UnknownRecord).forEach(walk);
    };
    walk(schema);
  }
});

test('the generated client, route manifest, and type samples are pinned to the frozen surface', { timeout: 90_000 }, () => {
  const routes = JSON.parse(readFileSync('generated/openapi/product-v1.routes.json', 'utf8')) as Array<{
    method: string; path: string; operationId: string;
  }>;
  const client = readFileSync('generated/openapi/product-v1.client.ts', 'utf8');
  const samples = readFileSync('tests/fixtures/openapi/generated-client-types.ts', 'utf8');
  for (const [method, path, operationId] of EXPECTED_OPERATIONS) {
    assert.ok(routes.some((route) => route.method === method.toUpperCase()
      && route.path === path && route.operationId === operationId), `${operationId} missing from routes.json`);
  }
  assert.match(client, /createProductAttachmentClient/u);
  for (const type of ['AttachmentIssueResult', 'AttachmentCompleteResult', 'AttachmentStatus',
    'AttachmentFinalizeResult', 'AttachmentRetireResult', 'AttachmentDownloadAdmission', 'AttachmentProblem']) {
    assert.match(client, new RegExp(`export type ${type} =`));
  }
  for (const sample of ['AttachmentIssueRequest', 'AttachmentCompleteRequest', 'AttachmentReplacementRequest',
    'AttachmentStatusDto', 'AttachmentIssueResult', "operations['issueAttachmentUpload']['responses'][201]"]) {
    assert.match(samples, new RegExp(sample.replaceAll('[', '\\[').replaceAll(']', '\\]')));
  }
  // The route manifest count is the frozen catalog (54 accepted + 7 additive)
  // extended through avatar, phase5 /api/v1/me/*, PI-02 ingest, 1.18 Collaboration,
  // 1.19 shared Collection list, 1.22 bookmark favicon, 1.23 Explore directory,
  // 1.26 public Profile Activity, 1.28 owned bookmark link-health GET,
  // 1.29 owned bookmark link-health POST, 1.33 export jobs, 1.34 members cursor,
  // 1.35–1.37 classify inbox, 1.38 organize-plan create/get, 1.39 organize-plan
  // apply, 1.40 collection tree versions, 1.41 version restore, RX-01
  // readable replica GET, and RX-02 readable replica POST. Catalog size is
  // owned by product-route-manifest.test.ts — do not hand-write a second
  // count here (that is how 101 !== 10x came back after worktree merges).
  assert.equal(routes.length, PRODUCT_ROUTE_MANIFEST.length);
});

test('catalog, additive-breaking, and generated-drift gates pass for the real sources', { timeout: 90_000 }, () => {
  const run = (script: string, args: string[]) => {
    const result = spawnSync(process.execPath, [resolve(backendRoot, script), ...args], {
      cwd: backendRoot, encoding: 'utf8', timeout: 90_000,
    });
    assert.equal(result.status, 0, `${script} failed\n${result.stdout}\n${result.stderr}`);
  };
  run('scripts/check-openapi-catalog.mjs', [sourcePath]);
  // 1.14.0 old client must remain additive against the 1.15.0 bundle.
  run('scripts/check-openapi-breaking.mjs', [
    '--baseline', 'openapi/baselines/product-v1.1.14.0.yaml',
    '--candidate', 'generated/openapi/product-v1.bundle.yaml',
  ]);
  // The committed generated artifacts must match the authored YAML exactly.
  run('scripts/generate-openapi.mjs', ['--check']);
});

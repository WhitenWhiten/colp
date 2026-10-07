/**
 * AC-03 capability inventory. Rows are derived from actual registration
 * sources (PRODUCT_ROUTE_MANIFEST, AUTH_ROUTE_MANIFEST, MCP catalogs, COLP
 * protocol carriers). Do not mark a registered entry as unsupported.
 */
import { PRODUCT_ROUTE_MANIFEST } from '../../../generated/openapi/product-v1.routes.js';
import { AUTH_ROUTE_MANIFEST } from '../../../src/transport/auth/auth-route-manifest.js';
import { MCP_COMPAT_ENDPOINT_PATH } from '../../../src/modules/mcp/mcp-compat-protocol.js';
import { PHASE4B_MCP_READ_TOOL_NAMES } from '../../../src/modules/mcp/read-tools.js';
import { PHASE4B_MCP_WRITE_MOUNTED_TOOL_NAMES } from '../../../src/modules/mcp/write-tools.js';
import { PHASE4B_MCP_COLLECTIONS_LIST_TOOL_NAME } from '../../../src/modules/mcp/owned-collection-mcp.js';

export type IdentitySource =
  | 'cookie'
  | 'product-bearer'
  | 'anonymous'
  | 'parent-key'
  | 'mcp-strict'
  | 'mcp-compat'
  | 'colp';

export type CapabilityFamily =
  | 'profile'
  | 'security'
  | 'collections'
  | 'classify-organize'
  | 'collaboration'
  | 'search-social'
  | 'digest-plan'
  | 'mcp-colp'
  | 'credentials'
  | 'attachments'
  | 'session-sync'
  | 'auth-browser';

export interface CapabilityRow {
  readonly family: CapabilityFamily;
  readonly method: string;
  readonly url: string;
  readonly identitySource: readonly IdentitySource[];
  readonly requiredScope: string;
  readonly objectPolicy: string;
  readonly extraProof: string | null;
  readonly idempotency: string;
  readonly testPath: string;
  readonly registered: true;
}

const AC03 = 'tests/integration/auth/account-bearer-product-http.integration.test.ts';
const AC02 = 'tests/integration/auth/machine-issuer-product-http.integration.test.ts';
const AC04 = 'tests/integration/auth/machine-mcp-interoperability.integration.test.ts';
const AC01 = 'tests/integration/auth/account-credential-lifecycle.integration.test.ts';
const AC05 = 'tests/integration/auth/credential-grant-plan.integration.test.ts';
const MCP_STRICT = '/collections/-/mcp';

const AUTOMATION_KEYS = Object.freeze([
  'isBot', 'automation', 'credentialId', 'issuanceSource', 'issuance_source',
  'known_credential_id', 'knownCredentialId', 'identitySource', 'identity_source',
]);

export const AUTOMATION_IDENTITY_FIELD_NAMES: readonly string[] = AUTOMATION_KEYS;

export function normalizeCapabilityPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/gu, '{$1}');
}

function rowKey(method: string, url: string): string {
  return `${method.toUpperCase()} ${normalizeCapabilityPath(url)}`;
}

function uniqueSources(values: readonly IdentitySource[]): readonly IdentitySource[] {
  return Object.freeze([...new Set(values)]);
}

function familyOf(path: string): CapabilityFamily {
  if (path.includes('/credential') || path.includes('/key-token') || path.includes('/jwks')) {
    return 'credentials';
  }
  if (path.includes('/attachments')) return 'attachments';
  if (path.includes('/reports') || path.includes('/digest') || path.includes('public-reports')) {
    return 'digest-plan';
  }
  if (
    path.includes('/members')
    || path.includes('/invite')
    || path.includes('/collaboration')
    || path.includes('/publishing-insights')
    || path.includes('/insights')
  ) {
    return 'collaboration';
  }
  if (
    path.includes('/search')
    || path.includes('/explore')
    || path.includes('/feed')
    || path.includes('/follow')
    || path.includes('/notification')
    || path.includes('/profiles/')
    || path.includes('/activity')
  ) {
    return 'search-social';
  }
  if (
    path.includes('/classify')
    || path.includes('/organize')
    || path.includes('/export')
    || path.includes('/readable')
    || path.includes('/link-health')
    || path.includes('/saved-resource')
    || path.includes('/reading-progress')
    || path.includes('/library-order')
  ) {
    return 'classify-organize';
  }
  if (path.includes('/collections') || path.includes('/nodes') || path.includes('/annotations')
    || path.includes('/relations') || path.includes('/editor') || path.includes('/versions')) {
    return 'collections';
  }
  if (path.includes('/sync')) return 'session-sync';
  if (path === '/api/v1/me' || path.includes('/avatar') || path.includes('/me/avatar')) return 'profile';
  if (path.startsWith('/api/v1/auth/')) return 'auth-browser';
  if (path === '/api/v1/session') return 'session-sync';
  if (path.startsWith('/collections/-/mcp') || path.includes('/colp') || path.includes('/runtime/')) {
    return 'mcp-colp';
  }
  return 'session-sync';
}

function isPublicRead(method: string, path: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  if (path === '/api/v1/avatar/{avatarId}') return true;
  if (path === '/api/v1/search' || path.startsWith('/api/v1/explore')) return true;
  if (path.startsWith('/api/v1/profiles/')) return true;
  if (path === '/api/v1/collections/{collectionId}') return true;
  if (path.includes('/public') || path.includes('/publication') || path.includes('/sitemap')) return true;
  if (path.startsWith('/api/v1/public-reports') || path.startsWith('/api/v1/reports/{slug}')) return true;
  if (path.includes('/.well-known') || path.endsWith('/jwks')) return true;
  return false;
}

function isParentKeyRoute(path: string): boolean {
  return path.startsWith('/api/v1/auth/credential-children');
}

function isSensitiveAuth(path: string, operationId: string): boolean {
  return path.includes('change-password')
    || path.includes('change-email')
    || path.includes('two-factor')
    || path.includes('/account/delete')
    || path.includes('unlink-account')
    || path.includes('/oauth2/link')
    || operationId.toLowerCase().includes('password')
    || operationId.toLowerCase().includes('mfa')
    || operationId.toLowerCase().includes('twofactor');
}

function classifyProduct(entry: (typeof PRODUCT_ROUTE_MANIFEST)[number]): CapabilityRow {
  const path = entry.path;
  const method = entry.method;
  const family = familyOf(path);
  if (path === '/api/v1/me/credential-identity') {
    return {
      family: 'credentials', method, url: path,
      identitySource: ['product-bearer'],
      requiredScope: 'inspect (any product token scope)',
      objectPolicy: 'current credential account; Cookie is 403',
      extraProof: null, idempotency: 'none', testPath: AC02, registered: true,
    };
  }
  if (path === '/api/v1/reports/{reportId}/issues/{editionId}/publish') {
    return {
      family: 'digest-plan', method, url: path,
      identitySource: ['cookie', 'product-bearer'],
      requiredScope: 'Cookie: product:write; bearer: reports:publish AND valid grant/Plan approval',
      objectPolicy: 'owner/member unchanged; bearer publish is the gated final commit',
      extraProof: 'Plan approval for bearer (reports:publish AND Plan/approval; AC-05)',
      idempotency: 'Known-Command-Id where contracted',
      testPath: AC05, registered: true,
    };
  }
  if (path === '/api/v1/auth/key-token') {
    return {
      family: 'credentials', method, url: path,
      identitySource: ['anonymous'],
      requiredScope: 'none (child key in JSON body)',
      objectPolicy: 'rejects Cookie and Authorization carriers',
      extraProof: 'child credential secret', idempotency: 'new jti each exchange',
      testPath: AC02, registered: true,
    };
  }
  if (isParentKeyRoute(path)) {
    return {
      family: 'credentials', method, url: path,
      identitySource: ['parent-key'],
      requiredScope: 'parent raw key; not a Product JWT',
      objectPolicy: 'manager of that parent only; Cookie rejected',
      extraProof: null,
      idempotency: method === 'GET' ? 'none' : 'Known-Command-Id',
      testPath: AC01, registered: true,
    };
  }
  if (path === '/api/v1/session') {
    return {
      family: 'session-sync', method, url: path,
      identitySource: method === 'GET' ? ['cookie'] : ['cookie'],
      requiredScope: 'browser session',
      objectPolicy: 'bootstrap / logout; mixed Cookie+Authorization rejected',
      extraProof: method === 'DELETE' ? 'Origin + CSRF' : null,
      idempotency: method === 'DELETE' ? 'idempotent 204' : 'none',
      testPath: AC03, registered: true,
    };
  }
  if (isPublicRead(method, path)) {
    return {
      family, method, url: path,
      identitySource: ['anonymous', 'cookie', 'product-bearer'],
      requiredScope: method === 'GET' || method === 'HEAD' ? 'product:read when bearer' : 'none',
      objectPolicy: 'anonymous vs personal cache isolation; current visibility',
      extraProof: null, idempotency: 'none', testPath: AC03, registered: true,
    };
  }
  const write = method !== 'GET' && method !== 'HEAD';
  return {
    family, method, url: path,
    identitySource: ['cookie', 'product-bearer'],
    requiredScope: write ? 'product:write' : 'product:read',
    objectPolicy: 'owner/editor/member unchanged; write scope does not grant objects',
    extraProof: write ? 'Cookie requires Origin + CSRF; bearer never uses CSRF' : null,
    idempotency: write ? 'Known-Command-Id where contracted' : 'none',
    testPath: AC03, registered: true,
  };
}

function classifyAuth(entry: (typeof AUTH_ROUTE_MANIFEST)[number]): CapabilityRow | null {
  if (entry.status !== 'registered') return null;
  const path = normalizeCapabilityPath(entry.path);
  const method = entry.method;
  if (isParentKeyRoute(path) || path === '/api/v1/auth/key-token') return null;
  if (path === '/api/v1/me' || path === '/api/v1/me/avatar' || path === '/api/v1/session') return null;
  const sensitive = isSensitiveAuth(path, entry.operationId);
  if (entry.scope === 'better-auth') {
    const signIn = path.includes('sign-in') || path.includes('sign-up') || path.includes('callback');
    return {
      family: sensitive ? 'security' : 'auth-browser',
      method, url: path,
      identitySource: signIn ? ['anonymous', 'cookie'] : ['cookie'],
      requiredScope: 'browser/OAuth session as registered',
      objectPolicy: 'raw account key is not accepted; Product bearer does not rewrite the contract',
      extraProof: sensitive ? 'existing mailbox / password / MFA / reauth proof' : null,
      idempotency: 'existing Better Auth contract',
      testPath: AC03, registered: true,
    };
  }
  if (path === '/api/v1/auth/sessions' || path.startsWith('/api/v1/auth/sessions')) {
    return {
      family: 'session-sync', method, url: path,
      identitySource: ['cookie'],
      requiredScope: 'browser session',
      objectPolicy: 'session inventory is cookie-bound; mixed carriers rejected',
      extraProof: method === 'POST' ? 'Origin + CSRF' : null,
      idempotency: 'none', testPath: AC03, registered: true,
    };
  }
  return {
    family: sensitive ? 'security' : 'auth-browser',
    method, url: path,
    identitySource: ['cookie'],
    requiredScope: 'browser session',
    objectPolicy: 'existing product auth surface; raw key not accepted',
    extraProof: sensitive ? 'existing reauth / mailbox proof' : (method === 'GET' ? null : 'Origin + CSRF'),
    idempotency: 'none', testPath: AC03, registered: true,
  };
}

function mcpRows(): CapabilityRow[] {
  const tools = [
    ...PHASE4B_MCP_READ_TOOL_NAMES,
    PHASE4B_MCP_COLLECTIONS_LIST_TOOL_NAME,
    ...PHASE4B_MCP_WRITE_MOUNTED_TOOL_NAMES,
    'reports.plan',
    'reports.commit',
  ];
  const unique = [...new Set(tools)];
  const rows: CapabilityRow[] = [];
  for (const source of ['mcp-strict', 'mcp-compat'] as const) {
    const url = source === 'mcp-strict' ? MCP_STRICT : MCP_COMPAT_ENDPOINT_PATH;
    rows.push({
      family: 'mcp-colp', method: 'POST', url,
      identitySource: [source],
      requiredScope: source === 'mcp-strict'
        ? 'mcp:read:* / native write scopes on mcp_strict audience'
        : 'same native catalog on mcp_compat audience',
      objectPolicy: 'protocol carrier is MCP OAuth; Product JWT is the wrong audience',
      extraProof: 'Plan/approval still required for publish; not an account inability',
      idempotency: 'native tool receipt',
      testPath: AC04, registered: true,
    });
    for (const tool of unique) {
      rows.push({
        family: tool.startsWith('reports.') ? 'digest-plan' : 'mcp-colp',
        method: 'tools/call', url: `${url}#${tool}`,
        identitySource: [source],
        requiredScope: tool.startsWith('collections.get') || tool === 'nodes.get' || tool === 'collections.list'
          ? 'mcp:read:public|own' : 'native write/read scope for that tool',
        objectPolicy: 'canonical service; HTTP/SDK if no native tool',
        extraProof: tool.includes('commit') || tool.includes('publish') ? 'Plan approval' : null,
        idempotency: 'native tool digest', testPath: AC04, registered: true,
      });
    }
  }
  return rows;
}

function colpRows(): CapabilityRow[] {
  const paths = [
    '/.well-known/collection-protocol',
    '/runtime/session',
    '/runtime/snapshot',
    '/runtime/push',
    '/runtime/pull',
    '/runtime/ack',
    '/runtime/retire',
  ];
  return paths.map((url) => ({
    family: 'mcp-colp' as const,
    method: url.includes('well-known') ? 'GET' : 'POST',
    url,
    identitySource: ['colp'] as const,
    requiredScope: 'COLP replica session credential',
    objectPolicy: 'Cookie wins when both Cookie and Authorization are present (COLP replica session); not Product JWT or MCP token',
    extraProof: null,
    idempotency: 'COLP command/ack',
    testPath: AC03,
    registered: true as const,
  }));
}

export function buildAccountBearerCapabilityMatrix(): readonly CapabilityRow[] {
  const byKey = new Map<string, CapabilityRow>();
  const add = (row: CapabilityRow): void => {
    const key = row.method.startsWith('tools/') ? `${row.method} ${row.url}` : rowKey(row.method, row.url);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, row);
      return;
    }
    byKey.set(key, {
      ...existing,
      identitySource: uniqueSources([...existing.identitySource, ...row.identitySource]),
    });
  };
  for (const entry of PRODUCT_ROUTE_MANIFEST) add(classifyProduct(entry));
  for (const entry of AUTH_ROUTE_MANIFEST) {
    const row = classifyAuth(entry);
    if (row) add(row);
  }
  for (const row of mcpRows()) add(row);
  for (const row of colpRows()) add(row);
  return Object.freeze([...byKey.values()]);
}

export function assertCapabilityMatrixCoversManifests(
  rows: readonly CapabilityRow[],
  assert: { ok(value: unknown, message?: string): void },
): void {
  const keys = new Set(rows.map((row) => `${row.method} ${normalizeCapabilityPath(row.url)}`));
  for (const entry of PRODUCT_ROUTE_MANIFEST) {
    assert.ok(keys.has(rowKey(entry.method, entry.path)), `missing product ${entry.method} ${entry.path}`);
  }
  for (const entry of AUTH_ROUTE_MANIFEST) {
    if (entry.status !== 'registered') continue;
    const key = rowKey(entry.method, entry.path);
    assert.ok(keys.has(key), `missing auth ${entry.method} ${entry.path}`);
  }
  for (const source of ['mcp-strict', 'mcp-compat'] as const) {
    const url = source === 'mcp-strict' ? MCP_STRICT : MCP_COMPAT_ENDPOINT_PATH;
    assert.ok(rows.some((row) => row.url === url && row.identitySource.includes(source)), `missing ${source} carrier`);
  }
  assert.ok(rows.some((row) => row.identitySource.includes('colp')), 'missing COLP carrier');
  for (const family of [
    'profile', 'security', 'collections', 'classify-organize', 'collaboration',
    'search-social', 'digest-plan', 'mcp-colp', 'credentials',
  ] as const) {
    assert.ok(rows.some((row) => row.family === family), `missing family ${family}`);
  }
  assert.ok(rows.every((row) => row.registered === true), 'registered entry marked unsupported');
  assert.ok(rows.every((row) => row.identitySource.length > 0), 'empty identity source');
}

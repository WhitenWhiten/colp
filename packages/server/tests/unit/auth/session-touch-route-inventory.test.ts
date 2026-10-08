/**
 * C-07 route inventory: every product GET's session-touch boolean is pinned by
 * scanning production transport source (requireSessionActor /
 * requireMutationActor / bootstrap), not a drift-prone copy of the table.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'vitest';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '../../..');
const transportDir = join(root, 'src/transport');
const HEARTBEAT_GET = '/api/v1/me';
const SESSIONS_GET = '/api/v1/auth/sessions';
const SESSION_BOOTSTRAP_GET = '/api/v1/session';
const APP_ROUTE = /\bapp\.(get|post|put|patch|delete|head|route)\(/g;
const CONST_PATH = /(?:const|let)\s+([A-Za-z_][\w]*)\s*=\s*(['"`])((?:\/|\$\{)[^'"`]*?)\2/g;

type ReadAuth =
  | { readonly kind: 'touch'; readonly touch: boolean; readonly evidence: string }
  | { readonly kind: 'bootstrap'; readonly evidence: string }
  | { readonly kind: 'optional'; readonly evidence: string }
  | { readonly kind: 'unresolved'; readonly evidence: string }
  | { readonly kind: 'none' };

interface GetSite {
  readonly file: string;
  readonly route: string;
  readonly method: 'GET' | 'HEAD';
  readonly auth: ReadAuth;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function braceBody(source: string, openIndex: number): string {
  if (source[openIndex] !== '{') return '';
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex, index + 1);
    }
  }
  return source.slice(openIndex);
}

function functionBodyNamed(source: string, name: string): string | null {
  const patterns = [
    new RegExp(`(?:export\\s+)?async\\s+function\\s+${name}\\b`),
    new RegExp(`(?:export\\s+)?function\\s+${name}\\b`),
    new RegExp(`const\\s+${name}\\s*=\\s*async\\s*`),
    new RegExp(`async\\s+${name}\\s*\\(`),
  ];
  let foundAt = -1;
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match?.index !== undefined && (foundAt < 0 || match.index < foundAt)) {
      foundAt = match.index;
    }
  }
  if (foundAt < 0) return null;
  // The body brace comes after the parameter list. A naive "first {" picks up
  // return-type object literals (`): Promise<{ account: ... }> {`), so scan
  // past the balanced parens and only accept a brace outside generics.
  const paramsOpen = source.indexOf('(', foundAt);
  if (paramsOpen < 0) return null;
  let parenDepth = 0;
  let paramsClose = -1;
  for (let index = paramsOpen; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') parenDepth += 1;
    else if (char === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        paramsClose = index;
        break;
      }
    }
  }
  if (paramsClose < 0) return null;
  let angleDepth = 0;
  for (let index = paramsClose + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === '<') angleDepth += 1;
    else if (char === '>') angleDepth = Math.max(0, angleDepth - 1);
    else if (char === ';' && angleDepth === 0) return null;
    else if (char === '{' && angleDepth === 0) {
      const body = braceBody(source, index);
      return body.length > 2 ? body : null;
    }
  }
  return null;
}

function constMap(source: string): Map<string, string> {
  const paths = new Map<string, string>();
  for (const match of source.matchAll(CONST_PATH)) {
    const name = match[1];
    const path = match[3];
    if (name && path) paths.set(name, path);
  }
  // Report route groups import their stable path constants from the contract
  // module instead of repeating literals. Resolve that small alias chain so
  // the inventory remains complete after the route-file decomposition.
  const reportPaths: Record<string, string> = {
    base: '/api/v1/reports',
    issue: '/api/v1/reports/:reportId/issues',
    edition: '/api/v1/reports/:reportId/issues/:editionId',
    member: '/api/v1/reports/:reportId/members/:subjectId',
  };
  for (const match of source.matchAll(
    /(?:const|let)\s+([A-Za-z_][\w]*)\s*=\s*REPORT_ROUTE_PATHS\.([A-Za-z_][\w]*)/g,
  )) {
    const name = match[1];
    const path = match[2] === undefined ? undefined : reportPaths[match[2]];
    if (name && path) paths.set(name, path);
  }
  for (let pass = 0; pass < 8; pass += 1) {
    let changed = false;
    for (const match of source.matchAll(
      /(?:const|let)\s+([A-Za-z_][\w]*)\s*=\s*([A-Za-z_][\w]*)\s*\+\s*(["'])([^"']*)\3/g,
    )) {
      const name = match[1];
      const prefix = match[2] === undefined ? undefined : paths.get(match[2]);
      const suffix = match[4];
      if (name && prefix !== undefined && suffix !== undefined && !paths.has(name)) {
        paths.set(name, prefix + suffix);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return paths;
}

function firstArg(call: string): string {
  const inner = call.slice(call.indexOf('(') + 1).trim();
  if (inner.startsWith("'") || inner.startsWith('"') || inner.startsWith('`')) {
    const quote = inner[0]!;
    const end = inner.indexOf(quote, 1);
    return inner.slice(1, end);
  }
  const ident = inner.match(/^([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)/);
  return ident?.[1] ?? inner.slice(0, 80);
}

function expandRouteTemplate(value: string, consts: Map<string, string>): string {
  let expanded = value;
  for (let pass = 0; pass < 8; pass += 1) {
    const next = expanded.replace(/\$\{([A-Za-z_][\w]*)\}/g, (match, name: string) => consts.get(name) ?? match);
    if (next === expanded) break;
    expanded = next;
  }
  return expanded;
}

function resolveRoute(arg: string, consts: Map<string, string>, fileSource: string): string {
  if (arg.startsWith('/') || arg.startsWith('${')) return expandRouteTemplate(arg, consts);
  const fromConst = consts.get(arg);
  if (fromConst) return expandRouteTemplate(fromConst, consts);
  const names = [...consts.keys()].filter((name) => /^[A-Za-z_][\w]*$/.test(name));
  if (arg === 'path' && names.length > 0) {
    const callers = [...fileSource.matchAll(new RegExp(
      `\\bregisterList\\s*\\([^)]*\\b(${names.join('|')})\\b`,
      'g',
    ))];
    if (callers.length > 0) {
      return callers.map((match) => expandRouteTemplate(consts.get(match[1]!) ?? match[1]!, consts)).join('|');
    }
  }
  return arg;
}

function literalsIn(region: string, pattern: RegExp): boolean[] {
  return [...region.matchAll(pattern)].map((match) => match[1] === 'true');
}

function readAuth(region: string, fileSource: string): ReadAuth {
  // The final route chunk in a module can include helper declarations after
  // the registration call. Do not mistake `function sessionActor(...)` in
  // that tail for a call made by a public handler.
  const routeRegion = region.split(/\n\s*(?:export\s+)?(?:async\s+)?function\s+sessionActor\b/u, 1)[0] ?? region;
  if (/\b(?:authority\.)?bootstrap\s*\(/.test(routeRegion) || /\bbootstrapBrowserSession\s*\(/.test(routeRegion)) {
    return { kind: 'bootstrap', evidence: 'bootstrap(' };
  }
  if (/\boptionalSessionActor\s*\(/.test(routeRegion)) {
    return { kind: 'optional', evidence: 'optionalSessionActor' };
  }

  // Report routes share their session wrapper from a separate helper module.
  // Follow that small, explicitly allowlisted seam so splitting the route
  // file cannot make this inventory silently classify every GET as public.
  if (/\bsessionActor\s*\(/.test(routeRegion)
      && /from\s+['"]\.\/report-route-helpers\.js['"]/.test(fileSource)) {
    const helperSource = stripComments(readFileSync(
      join(transportDir, 'product/report-route-helpers.ts'),
      'utf8',
    ));
    const helperBody = functionBodyNamed(helperSource, 'sessionActor') ?? '';
    const helperTouch = literalsIn(
      helperBody,
      /requireSessionActor\s*\([\s\S]*?\{[\s\S]*?touch:\s*(true|false)/g,
    );
    if (helperTouch.length === 1) {
      return { kind: 'touch', touch: helperTouch[0]!, evidence: `report helper touch: ${helperTouch[0]}` };
    }
    return { kind: 'unresolved', evidence: 'report sessionActor helper without an explicit touch literal' };
  }

  const direct = literalsIn(
    routeRegion,
    /(?:requireSessionActor|requireBrowserSessionActor|requireMutationActor)\s*\([\s\S]*?\{[\s\S]*?touch:\s*(true|false)/g,
  );
  const collab = literalsIn(routeRegion, /collaborationActor\s*\([\s\S]*?touch:\s*(true|false)/g);
  const actorArg = literalsIn(routeRegion, /\bactor\s*\(\s*request\s*,\s*\w+\s*,\s*(true|false)\s*,/g);
  const found = [...direct, ...collab, ...actorArg];

  if (/\bsessionActor\s*\(/.test(routeRegion)) {
    const helper = functionBodyNamed(fileSource, 'sessionActor') ?? '';
    const helperTouch = literalsIn(
      helper,
      /requireSessionActor\s*\([\s\S]*?touch:\s*(true|false)/g,
    );
    found.push(...helperTouch);
  }

  // Route files may wrap the session pin in a local `*Actor(request, deps)`
  // helper (e.g. owned-collection-routes' requireOwnedCollectionActor) or an
  // `account(request, deps, family)` helper (agent-routes).
  // Follow that indirection so renaming the seam cannot silently drop a pin.
  for (const call of routeRegion.matchAll(
    /\b(\w*(?:[Aa]ctor|[Aa]ccount)\w*)\s*\(\s*request\s*,\s*deps\s*[,)]/g,
  )) {
    const body = functionBodyNamed(fileSource, call[1]!);
    if (body === null) continue;
    found.push(...literalsIn(
      body,
      /(?:requireSessionActor|requireBrowserSessionActor|requireMutationActor)\s*\([\s\S]*?\{[\s\S]*?touch:\s*(true|false)/g,
    ));
  }

  if (found.length === 0) {
    // Community routes resolve the viewer through an explicitly allowlisted
    // seam in community-routes.ts: communityAdmission (the onRequest hook)
    // and communitySessionActor (the handler read) both delegate to a
    // per-request memoized optionalSessionActor wrapper. Follow that seam —
    // like the report helper above — so the fold cannot silently classify
    // the community GETs as public.
    if (/\bcommunitySessionActor\s*\(/.test(routeRegion)
        || /\bcommunityAdmission\s*\(/.test(routeRegion)) {
      const helperSource = stripComments(readFileSync(
        join(transportDir, 'product/community-routes.ts'),
        'utf8',
      ));
      const helperBody = functionBodyNamed(helperSource, 'communitySessionActor') ?? '';
      if (/\boptionalSessionActor\s*\(/.test(helperBody)) {
        return { kind: 'optional', evidence: 'communitySessionActor wraps optionalSessionActor' };
      }
      return { kind: 'unresolved', evidence: 'communitySessionActor helper without optionalSessionActor' };
    }
    const handler = routeRegion.match(/,\s*(handler)\s*\)\s*;?\s*$/);
    if (handler?.[1]) {
      const body = functionBodyNamed(fileSource, handler[1]);
      if (body) return readAuth(body, fileSource);
    }
    if (/\b(?:requireSessionActor|requireBrowserSessionActor|requireMutationActor)\s*\(/.test(routeRegion)) {
      return { kind: 'unresolved', evidence: 'session actor without an explicit touch literal' };
    }
    return { kind: 'none' };
  }
  if (found.some((value) => value !== found[0])) {
    return { kind: 'touch', touch: true, evidence: `disagreeing literals ${found.join(',')}` };
  }
  return { kind: 'touch', touch: found[0]!, evidence: `touch: ${found[0]}` };
}

/**
 * End of the `app.METHOD(...)` call expression starting at its open paren.
 * Balanced-paren scan that skips string and template literals so a `)` in a
 * message cannot truncate the registration call.
 */
function registrationCallEnd(source: string, openParen: number): number {
  let depth = 0;
  for (let index = openParen; index < source.length; index += 1) {
    const char = source[index];
    if (char === "'" || char === '"' || char === '`') {
      index += 1;
      while (index < source.length && source[index] !== char) {
        if (source[index] === '\\') index += 1;
        index += 1;
      }
      continue;
    }
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return source.length;
}

function routeChunks(source: string): Array<{ method: string; call: string }> {
  const chunks: Array<{ method: string; call: string }> = [];
  const matches = [...source.matchAll(APP_ROUTE)];
  for (const [index, match] of matches.entries()) {
    if (match.index === undefined || match[1] === undefined) continue;
    const next = index + 1 < matches.length ? matches[index + 1]!.index! : source.length;
    // A chunk is the registration call itself; helper declarations between
    // two `app.*` calls (e.g. community-comment-routes' manageActor) belong
    // to neither route and must not leak their session literals into the
    // preceding chunk.
    const open = source.indexOf('(', match.index);
    const end = open < 0 ? next : Math.min(registrationCallEnd(source, open), next);
    chunks.push({ method: match[1].toUpperCase(), call: source.slice(match.index, end) });
  }
  return chunks;
}

function collectGets(file: string, source: string): GetSite[] {
  const stripped = stripComments(source);
  const consts = constMap(stripped);
  const alternatives = new Map<string, readonly string[]>();
  const syntax = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const routeValues = (expression: ts.Expression): readonly string[] => {
    if (ts.isConditionalExpression(expression)) {
      return [...routeValues(expression.whenTrue), ...routeValues(expression.whenFalse)];
    }
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return [expression.text];
    if (ts.isTemplateExpression(expression)) return [expandRouteTemplate(expression.getText(syntax).slice(1, -1), consts)];
    return [resolveRoute(expression.getText(syntax), consts, stripped)];
  };
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && ts.isConditionalExpression(node.initializer)) {
      alternatives.set(node.name.text, routeValues(node.initializer));
    }
    ts.forEachChild(node, visit);
  };
  visit(syntax);
  const sites: GetSite[] = [];
  for (const chunk of routeChunks(stripped)) {
    if (chunk.method === 'ROUTE') continue;
    if (chunk.method !== 'GET' && chunk.method !== 'HEAD') continue;
    const arg = firstArg(chunk.call);
    for (const route of alternatives.get(arg) ?? [resolveRoute(arg, consts, stripped)]) {
      sites.push({ file, route, method: chunk.method, auth: readAuth(chunk.call, stripped) });
    }
  }
  return sites;
}

function collectTransportFiles(directory: string, prefix = ''): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return collectTransportFiles(join(directory, entry.name), relative);
    return relative.endsWith('.ts') ? [relative] : [];
  });
}

function collectTransportGets(): GetSite[] {
  const files = collectTransportFiles(transportDir).sort();
  return files.flatMap((name) => collectGets(name, readFileSync(join(transportDir, name), 'utf8')));
}

test('requireSessionActor requires an explicit touch boolean (no silent default)', () => {
  const source = readFileSync(join(transportDir, 'session-auth.ts'), 'utf8');
  assert.match(
    source,
    /options:\s*\{\s*readonly touch:\s*boolean\s*\}/,
    'requireSessionActor must require { touch: boolean }',
  );
  assert.equal(source.includes('touch ?? true'), false, 'must not default touch to true');
  assert.equal(source.includes('touch?:'), false, 'touch must not be optional on requireSessionActor');
  assert.match(source, /optionalSessionActor[\s\S]*touch:\s*false/, 'optionalSessionActor stays touch: false');
});

test('GET /session bootstrap implementations do not idle-slide', () => {
  const authority = readFileSync(
    join(root, 'src/modules/auth/application/browser-session-authority.ts'),
    'utf8',
  );
  const identity = readFileSync(
    join(root, 'src/modules/identity/application/session.ts'),
    'utf8',
  );
  const authorityBootstrap = functionBodyNamed(stripComments(authority), 'bootstrap');
  const identityBootstrap = functionBodyNamed(stripComments(identity), 'bootstrapBrowserSession');
  assert.ok(authorityBootstrap && authorityBootstrap.length > 80, 'authority bootstrap body');
  assert.ok(identityBootstrap && identityBootstrap.length > 80, 'identity bootstrap body');
  assert.equal(
    /(?:store|sessions)\.touch\s*\(/.test(authorityBootstrap),
    false,
    'createBrowserSessionAuthority().bootstrap must not store.touch',
  );
  assert.equal(
    /(?:store|sessions)\.touch\s*\(/.test(identityBootstrap),
    false,
    'bootstrapBrowserSession must not sessions.touch',
  );
  assert.match(authorityBootstrap, /touch:\s*false/, 'bootstrap loadUsableActor stays touch: false');
});

test('every product GET pins heartbeat vs no-touch against production source', () => {
  const gets = collectTransportGets().filter((site) => site.method === 'GET');
  const sessionGated = gets.filter((site) => site.auth.kind !== 'none');
  assert.ok(sessionGated.length >= 20, `expected a full GET inventory, got ${sessionGated.length}`);

  const unresolved = sessionGated.filter((site) => site.auth.kind === 'unresolved');
  assert.deepEqual(
    unresolved.map((site) => `${site.file} ${site.route}`),
    [],
    'every session-gated GET must pin an explicit touch boolean or bootstrap/optional',
  );

  const heartbeat = sessionGated.filter((site) => site.route === HEARTBEAT_GET);
  assert.equal(heartbeat.length, 1, `GET ${HEARTBEAT_GET} must appear once, got ${heartbeat.length}`);
  assert.equal(heartbeat[0]?.auth.kind, 'touch');
  assert.equal(heartbeat[0]?.auth.kind === 'touch' && heartbeat[0].auth.touch, true, 'GET /me must touch');

  const sessions = sessionGated.filter((site) => site.route === SESSIONS_GET);
  assert.equal(sessions.length, 1, `GET ${SESSIONS_GET} must appear once`);
  assert.equal(sessions[0]?.auth.kind, 'touch');
  assert.equal(sessions[0]?.auth.kind === 'touch' && sessions[0].auth.touch, false, 'P-07 sessions GET must not touch');

  const bootstrap = sessionGated.filter((site) => site.route === SESSION_BOOTSTRAP_GET);
  assert.equal(bootstrap.length, 1, `GET ${SESSION_BOOTSTRAP_GET} must appear once`);
  assert.equal(bootstrap[0]?.auth.kind, 'bootstrap', 'GET /session must use bootstrap, not requireSessionActor touch');

  const illegal = sessionGated.filter((site) => {
    if (site.route === HEARTBEAT_GET) return false;
    return site.auth.kind === 'touch' && site.auth.touch === true;
  });
  assert.deepEqual(
    illegal.map((site) => `${site.file} ${site.route}`),
    [],
    'no GET other than /me may use touch: true',
  );

  const disagreeing = sessionGated.filter((site) =>
    site.auth.kind === 'touch' && site.auth.evidence.startsWith('disagreeing'));
  assert.deepEqual(disagreeing.map((site) => `${site.file} ${site.route} ${site.auth.kind === 'touch' ? site.auth.evidence : ''}`), []);

  const gatedRoutes = [...new Set(sessionGated.map((site) => site.route))].sort();
  assert.deepEqual(
    gatedRoutes,
    [...SESSION_GATED_GET_GOLD].sort(),
    'session-gated GET routes must match the gold list so a wrapper the regex misses cannot silently drop a pin',
  );
});

/** Gold list of session-gated GET paths scanned from src/transport. Update when adding a GET. */
const SESSION_GATED_GET_GOLD = [
  '/api/v1/auth/linked-accounts',
  '/api/v1/auth/sessions',
  '/api/v1/collections',
  '/api/v1/collections/:collectionId',
  '/api/v1/collections/:collectionId/annotations',
  '/api/v1/collections/:collectionId/annotations/:annotationId',
  '/api/v1/collections/:collectionId/capture-decisions',
  '/api/v1/collections/:collectionId/capture-decisions/:decisionId',
  '/api/v1/collections/:collectionId/classification-settings',
  '/api/v1/collections/:collectionId/children',
  '/api/v1/collections/:collectionId/editor',
  '/api/v1/collections/:collectionId/export',
  '/api/v1/collections/:collectionId/members',
  '/api/v1/collections/:collectionId/organize-plans/:planId',
  '/api/v1/collections/:collectionId/versions',
  '/api/v1/collections/:collectionId/versions/:versionId',
  '/api/v1/collections/:collectionId/nodes/:nodeId/favicon-source',
  '/api/v1/collections/:collectionId/nodes/:nodeId/preview-image-mode',
  '/api/v1/collections/:collectionId/nodes/:nodeId/readable',
  '/api/v1/collections/:collectionId/relations',
  '/api/v1/collections/:collectionId/relations/:relationId',
  '/api/v1/mcp/approvals',
  '/api/v1/mcp/approvals/:planId',
  '/api/v1/me',
  '/api/v1/me/bookmark-preferences',
  '/api/v1/me/bookmark-captures',
  '/api/v1/me/bookmark-captures/aggregate',
  '/api/v1/me/capture-capabilities',
  '/api/v1/me/capture-learning',
  '/api/v1/me/classify-inbox',
  '/api/v1/me/collaboration-invites',
  '/api/v1/me/credits',
  '/api/v1/me/credits/ledger',
  '/api/v1/me/credits/ledger/:entryId',
  '/api/v1/me/export-jobs',
  '/api/v1/me/export-jobs/:jobId',
  '/api/v1/me/export-jobs/:jobId/download',
  '/api/v1/me/favicon-jobs/:jobId',
  '/api/v1/me/favicon-policy',
  '/api/v1/me/library-order',
  '/api/v1/me/link-health',
  '/api/v1/me/publishing-insights',
  '/api/v1/me/shared-collections',
  '/api/v1/me/agents',
  '/api/v1/me/agents/:id/audit',
  '/api/v1/me/agents/:clientId/policy',
  '/api/v1/session',
  '/api/v1/sync/conflicts',
  '/api/v1/sync/status',
  '/api/v1/sync/trash',
  '/api/v1/sync/trash/:deletionId',
] as const;

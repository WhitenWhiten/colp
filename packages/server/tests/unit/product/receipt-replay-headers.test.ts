/**
 * Receipt-replay header parity (defect class: a write route serves its live
 * response with ETag, but the durable `Known-Command-Id` receipt stored a
 * `ProductCommandResult.stableHeaders` snapshot without `etag`, so exact
 * replays silently drop the validator). Seen twice already: the FO favicon
 * commands (PATCH /me/favicon-policy, PUT .../favicon-source, POST
 * .../favicon-refresh) and the extension helper capture path.
 *
 * The scan derives the invariant from production source, not a hand copy:
 * every transport mutation route that (a) replays stored receipts and
 * (b) sets an ETag on its live send path is discovered by walking
 * `app.<method>(...)` registrations plus their `send*`/`write*` helpers. Each
 * discovered route must be pinned below, and each pin's `receipts.complete`
 * result builders must snapshot `etag` into `stableHeaders` — literal keys,
 * shorthand, conditional spreads, and imperative `stableHeaders.etag =`
 * assignments all count. New ETag-bearing receipt routes go red until the
 * author adds a pin (and stores the header).
 *
 * Exempt: non-2xx stored outcomes (e.g. the 429 rate-limit short-circuit —
 * the live path never emits ETag there) and `{...x, stableHeaders:
 * x.stableHeaders}` claim-failure passthroughs that re-store the original
 * snapshot verbatim. Routes whose replay branch re-derives ETag outside
 * stored headers are pinned separately (legacy helper-capture fallback).
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, test } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const transportDir = join(root, 'src/transport');
const APP_ROUTE = /\bapp\.(get|post|put|patch|delete|head|route)\(/g;
const REPLAY_RE = /sendProductCommandReceiptOutcome\s*\(|Object\.entries\(\s*[\w.(){}[\]'"\s]*stableHeaders/;
const ETAG_RE = /\.header\(\s*['"]etag['"]/i;

// ---- static slicing helpers (same family as the session-touch inventory) ----

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
function skipString(source: string, index: number): number {
  const quote = source[index]!;
  for (index += 1; index < source.length && source[index] !== quote; index += 1) {
    if (source[index] === '\\') index += 1;
  }
  return index;
}
function braceBody(source: string, openIndex: number): string {
  if (source[openIndex] !== '{') return '';
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index]!;
    if (char === "'" || char === '"' || char === '`') { index = skipString(source, index); continue; }
    if (char === '{') depth += 1;
    else if (char === '}' && (depth -= 1) === 0) return source.slice(openIndex, index + 1);
  }
  return source.slice(openIndex);
}
function callEnd(source: string, openParen: number): number {
  let depth = 0;
  for (let index = openParen; index < source.length; index += 1) {
    const char = source[index]!;
    if (char === "'" || char === '"' || char === '`') { index = skipString(source, index); continue; }
    if (char === '(') depth += 1;
    else if (char === ')' && (depth -= 1) === 0) return index + 1;
  }
  return source.length;
}
function arrowBody(source: string, afterArrow: number): string | null {
  let cursor = afterArrow;
  while (/\s/.test(source[cursor] ?? '')) cursor += 1;
  if (source[cursor] === '{') {
    const body = braceBody(source, cursor);
    return body.length > 2 ? body : null;
  }
  let depth = 0;
  for (let index = cursor; index < source.length; index += 1) {
    const char = source[index]!;
    if (char === "'" || char === '"' || char === '`') { index = skipString(source, index); continue; }
    if ('({['.includes(char)) depth += 1;
    else if (')}]'.includes(char)) { if (depth === 0) return source.slice(cursor, index); depth -= 1; }
    else if ((char === ';' || char === ',') && depth === 0) return source.slice(cursor, index);
  }
  return source.slice(cursor);
}
/** Body text for `name`: function decls, method shorthand, `x: (...) =>`, const arrows/aliases. */
function bodyOf(source: string, name: string, depth = 0): string | null {
  if (depth > 4) return null;
  // Priority order matters: `name: (` also matches TYPE members like
  // `readonly decide: (input) => Promise<...>;`, so `name(` shorthand wins.
  const patterns = [
    new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\b`, 'g'),
    new RegExp(`(?:export\\s+)?const\\s+${name}\\s*(?::[^=\\n]+)?=`, 'g'),
    new RegExp(`(?:async\\s+)?${name}\\s*\\(`, 'g'),
    new RegExp(`\\b${name}\\s*:\\s*(?:async\\s+)?\\(`, 'g'),
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const index = match.index!;
    const rest = source.slice(index);
    const alias = rest.match(
      new RegExp(`^(?:export\\s+)?const\\s+${name}\\s*(?::[^=\\n]+)?=\\s*([A-Za-z_$][\\w$]*)\\s*;`));
    if (alias?.[1] !== undefined) return bodyOf(source, alias[1], depth + 1);
    const single = rest.match(
      new RegExp(`^(?:export\\s+)?const\\s+${name}\\s*(?::[^=\\n]+)?=\\s*(?:async\\s+)?[A-Za-z_$][\\w$]*\\s*=>`));
    if (single !== null) return arrowBody(source, index + single[0].length);
    const open = source.indexOf('(', index);
    if (open < 0 || /[;{}]/.test(source.slice(index, open))) continue; // e.g. `const x = {` — not a function
    const close = callEnd(source, open) - 1;
    if (close < open) continue;
    let cursor = close + 1;
    while (/\s/.test(source[cursor] ?? '')) cursor += 1;
    if (source.startsWith('=>', cursor)) return arrowBody(source, cursor + 2);
    let angle = 0;
    for (; cursor < source.length; cursor += 1) {
      const char = source[cursor]!;
      if (char === "'" || char === '"' || char === '`') { cursor = skipString(source, cursor); continue; }
      if (char === '<') { angle += 1; continue; }
      if (char === '>') { angle = Math.max(0, angle - 1); continue; }
      if (angle !== 0) continue;
      if (char === ':') {
        // Return-type annotation: a bare `: { ... }` object type literal is not
        // the body — skip its balanced braces and keep scanning for the real one.
        let peek = cursor + 1;
        while (/\s/.test(source[peek] ?? '')) peek += 1;
        if (source[peek] === '{') { cursor = peek + braceBody(source, peek).length - 1; continue; }
        continue;
      }
      if (char === '{') {
        const body = braceBody(source, cursor);
        return body.length > 2 ? body : null;
      }
      if (char === '=' && source[cursor + 1] === '>') return arrowBody(source, cursor + 2);
      if (';,)]}.'.includes(char)) break; // call site, not a definition
    }
    }
  }
  return null;
}
function routeChunks(source: string): Array<{ method: string; call: string }> {
  const matches = [...source.matchAll(APP_ROUTE)];
  return matches.map((match, index) => {
    const next = index + 1 < matches.length ? matches[index + 1]!.index! : source.length;
    const open = source.indexOf('(', match.index!);
    const end = open < 0 ? next : Math.min(callEnd(source, open), next);
    return { method: match[1]!.toUpperCase(), call: source.slice(match.index!, end) };
  });
}
function firstArg(call: string): string {
  const inner = call.slice(call.indexOf('(') + 1).trim();
  if (inner.startsWith('{')) {
    return inner.match(/\burl\s*:\s*['"`]([^'"`]+)['"`]/)?.[1] ?? inner.slice(0, 60);
  }
  if (inner.startsWith("'") || inner.startsWith('"') || inner.startsWith('`')) {
    return inner.slice(1, inner.indexOf(inner[0]!, 1));
  }
  return inner.match(/^([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)/)?.[1] ?? inner.slice(0, 80);
}
const REPORT_ROUTE_PATHS: Record<string, string> = {
  base: '/api/v1/reports',
  issue: '/api/v1/reports/:reportId/issues',
  edition: '/api/v1/reports/:reportId/issues/:editionId',
  member: '/api/v1/reports/:reportId/members/:subjectId',
};
function constMap(source: string): Map<string, string> {
  const paths = new Map<string, string>();
  for (const m of source.matchAll(/(?:const|let)\s+([A-Za-z_][\w]*)\s*=\s*(['"`])((?:\/|\$\{)[^'"`]*?)\2/g)) {
    paths.set(m[1]!, m[3]!);
  }
  for (const m of source.matchAll(/(?:const|let)\s+([A-Za-z_][\w]*)\s*=\s*REPORT_ROUTE_PATHS\.([A-Za-z_][\w]*)/g)) {
    const mapped = REPORT_ROUTE_PATHS[m[2]!];
    if (mapped) paths.set(m[1]!, mapped);
  }
  for (let pass = 0; pass < 8; pass += 1) {
    let changed = false;
    for (const m of source.matchAll(/(?:const|let)\s+([A-Za-z_][\w]*)\s*=\s*([A-Za-z_][\w]*)\s*\+\s*["']([^"']*)["']/g)) {
      const prefix = paths.get(m[2]!);
      if (prefix !== undefined && !paths.has(m[1]!)) { paths.set(m[1]!, prefix + m[3]!); changed = true; }
    }
    if (!changed) break;
  }
  return paths;
}
function resolveRoute(arg: string, consts: Map<string, string>): string {
  let route = arg.startsWith('/') || arg.startsWith('${') ? arg : (consts.get(arg) ?? arg);
  for (let pass = 0; pass < 8; pass += 1) {
    const next = route.replace(/\$\{([A-Za-z_][\w]*)\}/g, (m, name: string) => consts.get(name) ?? m);
    if (next === route) break;
    route = next;
  }
  return route;
}
function collectFiles(directory: string, prefix = ''): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? collectFiles(join(directory, entry.name), relative)
      : relative.endsWith('.ts') ? [relative] : [];
  });
}
const fileCache = new Map<string, string | null>();
function loadStripped(absPath: string): string | null {
  if (!fileCache.has(absPath)) {
    fileCache.set(absPath, existsSync(absPath) ? stripComments(readFileSync(absPath, 'utf8')) : null);
  }
  return fileCache.get(absPath) ?? null;
}
function resolveSpec(fromAbs: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  let target = resolve(dirname(fromAbs), spec);
  if (target.endsWith('.js')) target = `${target.slice(0, -3)}.ts`;
  for (const candidate of [target, `${target}.ts`, join(target, 'index.ts')]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
function importMap(fileAbs: string, source: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const target = resolveSpec(fileAbs, m[2]!);
    if (!target) continue;
    for (const raw of m[1]!.split(',')) {
      const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()!.trim();
      if (name) map.set(name, target);
    }
  }
  return map;
}
/** Resolve `name` through bodies, `const` aliases, `export {a as b}`, and barrel `export *`. */
function resolveFunction(fileAbs: string, name: string, depth = 0): { file: string; body: string } | null {
  if (depth > 6) return null;
  const source = loadStripped(fileAbs);
  if (!source) return null;
  const body = bodyOf(source, name);
  if (body !== null) return { file: fileAbs, body };
  for (const m of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    for (const raw of m[1]!.split(',')) {
      const parts = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/).map((s) => s.trim());
      if (parts[parts.length - 1] === name) {
        const target = resolveSpec(fileAbs, m[2]!);
        const hit = target ? resolveFunction(target, parts[0]!, depth + 1) : null;
        if (hit) return hit;
      }
    }
  }
  for (const m of source.matchAll(/export\s+\*\s*from\s*['"]([^'"]+)['"]/g)) {
    const target = resolveSpec(fileAbs, m[1]!);
    const hit = target ? resolveFunction(target, name, depth + 1) : null;
    if (hit) return hit;
  }
  return null;
}
/** Registration call, a directly returned same-file handler, and reachable `send*`/`write*` helpers. */
function sendPathCode(region: string, fileAbs: string, fileSource: string): string {
  const imports = importMap(fileAbs, fileSource);
  const seen = new Set<string>();
  const queue = [region];
  let combined = region;
  // Reading Progress delegates the whole handler with `return await putReadingProgress(...)`.
  // Follow that one hop so the receipt and ETag inside the helper stay visible.
  for (const match of region.matchAll(/\breturn\s+(?:await\s+)?([a-z][\w$]*)\s*\(/g)) {
    const name = match[1]!;
    if (seen.has(name) || /^(?:send|write)/u.test(name)) continue;
    const body = bodyOf(fileSource, name);
    if (body === null) continue;
    seen.add(name);
    combined += `\n${body}`;
    queue.push(body);
  }
  while (queue.length > 0) {
    for (const match of queue.shift()!.matchAll(/\b(send|write)[A-Z][\w$]*/g)) {
      const name = match[0]!;
      if (seen.has(name)) continue;
      seen.add(name);
      const target = imports.get(name);
      const body = bodyOf(fileSource, name) ?? (target ? resolveFunction(target, name)?.body ?? null : null);
      if (body !== null) { combined += `\n${body}`; queue.push(body); }
    }
  }
  return combined;
}
/** `if (... 'replay' ...) { ... }` blocks that set ETag outside the stored headers. */
function replayBranchEtag(code: string): boolean {
  for (const m of code.matchAll(/if\s*\([^)]*'replay'[^)]*\)\s*\{/g)) {
    if (ETAG_RE.test(braceBody(code, code.indexOf('{', m.index! + m[0].length - 1)))) return true;
  }
  return false;
}

// ---- command side: what every `receipts.complete` call can store ----

function topArgs(callText: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = 1; // skip the opening paren of the sliced call
  const inner = callText;
  for (let index = 1; index < inner.length - 1; index += 1) {
    const char = inner[index]!;
    if (char === "'" || char === '"' || char === '`') { index = skipString(inner, index); continue; }
    if ('({['.includes(char)) depth += 1;
    else if (')}]'.includes(char)) depth -= 1;
    else if (char === ',' && depth === 0) { args.push(inner.slice(start, index).trim()); start = index + 1; }
  }
  args.push(inner.slice(start, -1).trim());
  return args;
}
function reachableBodies(source: string, entry: string): Array<{ name: string; body: string }> {
  const bodies: Array<{ name: string; body: string }> = [];
  const seen = new Set<string>();
  const walk = (name: string, depth: number): void => {
    if (seen.has(name) || depth > 3) return;
    seen.add(name);
    const body = bodyOf(source, name);
    if (body === null) return;
    bodies.push({ name, body });
    for (const m of body.matchAll(/\b([a-zA-Z_$][\w$]*)\s*\(/g)) walk(m[1]!, depth + 1);
  };
  walk(entry, 0);
  return bodies;
}
function literalHasEtag(obj: string): boolean {
  return /[,{]\s*['"]?etag['"]?\s*:/u.test(obj) || /[,{]\s*etag\s*[,}]/u.test(obj);
}
function storesEtag(region: string): boolean {
  for (const m of region.matchAll(/\bstableHeaders\s*:\s*\{/g)) {
    if (literalHasEtag(braceBody(region, region.indexOf('{', m.index! + m[0].length - 1)))) return true;
  }
  for (const m of region.matchAll(/\bstableHeaders\s*:\s*[A-Za-z_$][\w$.]*\s*\(/g)) {
    const open = region.indexOf('(', m.index! + m[0].length - 1);
    if (literalHasEtag(region.slice(open, callEnd(region, open)))) return true;
  }
  // `stableHeaders: ident` or `stableHeaders,` shorthand — follow `const ident = {...}`.
  for (const m of region.matchAll(/\bstableHeaders\s*:\s*([A-Za-z_$][\w$]*)\s*[,}]|[,{]\s*stableHeaders\s*[,}]/g)) {
    const ident = m[1] ?? 'stableHeaders';
    const init = region.match(new RegExp(`(?:const|let)\\s+${ident}\\s*(?::[^=\\n]+)?=\\s*\\{`));
    if (init && literalHasEtag(braceBody(region, region.indexOf('{', init.index! + init[0].length - 1)))) {
      return true;
    }
  }
  // Imperative `stableHeaders.etag =` / `stableHeaders['etag'] =`.
  return /\bstableHeaders\s*(?:\.\s*etag|\[\s*['"]etag['"]\s*\])\s*=[^=]/u.test(region);
}
/**
 * `stableHeaders: product.stableHeaders` where `const product = helperFn(...)`: follow
 * the producer call into a reachable body and check ITS stableHeaders literal. This is
 * how a computed snapshot (e.g. `catalogBody`) differs from a claim-failure re-store.
 */
function storesEtagViaMember(
  region: string,
  bodies: ReadonlyArray<{ name: string; body: string }>,
  source: string,
  fileAbs: string,
): boolean {
  for (const m of region.matchAll(/\bstableHeaders\s*:\s*([A-Za-z_$][\w$]*)\.stableHeaders\s*[,}]/g)) {
    const ident = m[1]!;
    for (const { body } of bodies) {
      const init = body.match(
        new RegExp(`(?:const|let)\\s+${ident}\\s*(?::[^=\\n]+)?=\\s*(?:await\\s+)?([A-Za-z_$][\\w$]*)\\s*\\(`));
      if (init === null) continue;
      const callee = init[1]!;
      const local = bodyOf(source, callee);
      const target = local === null ? importMap(fileAbs, source).get(callee) : undefined;
      const calleeBody = local ?? (target ? resolveFunction(target, callee)?.body ?? null : null);
      if (calleeBody !== null && storesEtag(calleeBody)) return true;
    }
  }
  return false;
}
interface StoredResult {
  readonly site: string;
  readonly hasEtag: boolean;
  readonly status: number | null; // literal `status:` when statically known
  readonly passthrough: boolean;  // `{...x, stableHeaders: x.stableHeaders}` re-store of a saved snapshot
  readonly resolved: boolean;
}
interface AnalyzeCtx {
  readonly bodies: ReadonlyArray<{ name: string; body: string }>;
  readonly source: string;
  readonly fileAbs: string;
}
function analyzeRegion(region: string, site: string, resolved: boolean, ctx?: AnalyzeCtx): StoredResult {
  const status = region.match(/\bstatus\s*:\s*(\d{3})/u);
  const passthrough = /\bstableHeaders\s*:\s*[A-Za-z_$][\w$]*(?:\.[\w$]+)+\s*[,}]/u.test(region)
    || /\.\.\.\s*claim\.result\b/u.test(region);
  let hasEtag = storesEtag(region);
  let claim = passthrough;
  if (!hasEtag && passthrough && ctx !== undefined
      && storesEtagViaMember(region, ctx.bodies, ctx.source, ctx.fileAbs)) {
    hasEtag = true;
    claim = false; // a computed producer that snapshots etag, not a claim-result re-store
  }
  return { site, hasEtag, status: status ? Number(status[1]) : null, passthrough: claim, resolved };
}
function resolveResultArg(
  arg: string,
  bodies: ReadonlyArray<{ name: string; body: string }>,
  source: string,
  fileAbs: string,
): StoredResult {
  const trimmed = arg.trim();
  if (trimmed.startsWith('{')) return analyzeRegion(trimmed, '{literal}', true, { bodies, source, fileAbs });
  const callMatch = trimmed.match(/^([A-Za-z_$][\w$]*)\s*\(/);
  if (callMatch) {
    const local = bodyOf(source, callMatch[1]!);
    const target = local === null ? importMap(fileAbs, source).get(callMatch[1]!) : undefined;
    const hit = local ?? (target ? resolveFunction(target, callMatch[1]!)?.body ?? null : null);
    if (hit === null) return analyzeRegion('', `${callMatch[1]}(...)`, false);
    const analyzed = analyzeRegion(hit, `${callMatch[1]}(...)`, true);
    // `jsonResult(..., { etag })` spreads that argument into stableHeaders.
    if (!analyzed.hasEtag && /\{[^{}]*\betag\s*:/u.test(trimmed)
        && /\bstableHeaders\s*:\s*\{[\s\S]*?\.\.\.\s*[A-Za-z_$]/u.test(hit)) {
      return { ...analyzed, hasEtag: true, passthrough: false };
    }
    return analyzed;
  }
  const ident = trimmed.match(/^([A-Za-z_$][\w$]*)$/);
  if (ident) {
    for (const { body } of bodies) {
      const init = body.match(new RegExp(`(?:const|let)\\s+${ident[1]}\\s*(?::[^=\\n]+)?=\\s*`));
      if (init === null) continue;
      const rest = body.slice(init.index! + init[0].length);
      const nested = resolveResultArg(rest, bodies, source, fileAbs);
      return { ...nested, site: `${ident[1]} = ${nested.site}` };
    }
    return analyzeRegion('', ident[1]!, false);
  }
  return analyzeRegion('', trimmed.slice(0, 40), false);
}
function storedResultsOf(file: string, fn: string): StoredResult[] {
  const fileAbs = join(root, file);
  const source = loadStripped(fileAbs);
  assert.ok(source !== null, `receipt file missing: ${file}`);
  const bodies = reachableBodies(source, fn);
  assert.ok(bodies.length > 0, `cannot resolve ${fn} in ${file}`);
  const results: StoredResult[] = [];
  for (const { name, body } of bodies) {
    for (const m of body.matchAll(/\breceipts\.complete\s*\(/g)) {
      const open = body.indexOf('(', m.index! + m[0].length - 1);
      const arg = topArgs(body.slice(open, callEnd(body, open)))[2] ?? '';
      const resolved = resolveResultArg(arg, bodies, source, fileAbs);
      results.push({ ...resolved, site: `${name} -> ${resolved.site}` });
    }
  }
  return results;
}

// ---- pinned inventory ----

interface PinnedRoute {
  readonly label: string;
  readonly transport: string;
  readonly call: string; // identifier the handler invokes for the receipted command
  readonly receiptFile: string;
  readonly receiptFn: string;
  readonly viaFile?: string; // facade/ports file proving `call` reaches `receiptFn`
  readonly via?: RegExp;
}
function pin(
  label: string, transport: string, call: string,
  receiptFile: string, receiptFn?: string, viaFile?: string, via?: RegExp,
): PinnedRoute {
  return { label, transport, call, receiptFile, receiptFn: receiptFn ?? call.split('.').pop()!, viaFile, via };
}

const GRANTS = 'src/modules/auth/application/account-credentials/grant-commands.ts';
const CRED = 'src/modules/auth/application/account-credentials/commands.ts';
const CRED_FACADE = 'src/infrastructure/auth/account-credentials-postgres.ts';
const COLL = 'src/modules/collections/application';
const IDENTITY = 'src/modules/identity/application';
const via = (name: RegExp): [string, RegExp] => [CRED_FACADE, name];

/** Every discovered ETag-replay route, pinned to the command whose stored result must snapshot `etag`. */
const REQUIRED_ETAG_RECEIPTS: readonly PinnedRoute[] = [
  pin('POST /api/v1/collections/:collectionId/nodes/:nodeId/classification-confirmations', 'product/classification-confirmation-routes.ts', 'confirmCollectionBookmarkClassification', `${COLL}/confirm-classification.ts`),
  pin('PATCH /api/v1/collections/:collectionId/classification-settings', 'product/classification-settings-routes.ts', 'updateClassificationSettings', `${COLL}/classification-settings.ts`),
  // FO favicon commands — the fixed instances of this defect class.
  pin('PATCH /api/v1/me/favicon-policy', 'product/favicon-policy-routes.ts', 'updateMyFaviconPolicy', `${COLL}/favicon-policy.ts`),
  pin('PUT /api/v1/collections/:collectionId/nodes/:nodeId/favicon-source', 'product/favicon-policy-routes.ts', 'setBookmarkFaviconSource', `${COLL}/favicon-icon-source.ts`),
  pin('PUT /api/v1/collections/:collectionId/nodes/:nodeId/preview-image-mode', 'product/link-preview-command-routes.ts', 'setBookmarkPreviewMode', `${COLL}/link-preview-commands.ts`),
  pin('POST /api/v1/collections/:collectionId/nodes/:nodeId/favicon-refresh', 'product/favicon-policy-routes.ts', 'enqueueBookmarkFaviconRefresh', `${COLL}/favicon-job.ts`),
  // Extension helper capture/clear (replay keeps a live recompute fallback for pre-snapshot receipts).
  pin('POST /colp/v0.1/sync/collections/:collectionId/nodes/:nodeId/favicon', 'colp-sync/sync-favicon-helper-routes.ts', 'captureBookmarkFavicon', `${COLL}/favicon-helper-capture.ts`),
  pin('DELETE /colp/v0.1/sync/collections/:collectionId/nodes/:nodeId/favicon', 'colp-sync/sync-favicon-helper-routes.ts', 'clearCapturedBookmarkFavicon', `${COLL}/favicon-helper-capture.ts`),
  // Account credentials (reached through the `api.*` facade).
  pin('POST /api/v1/me/credential-grants', 'product/account-credential-grant-routes.ts', 'createCredentialGrant', GRANTS),
  pin('POST /api/v1/me/credential-grants/:grantId/revoke', 'product/account-credential-grant-routes.ts', 'revokeCredentialGrant', GRANTS),
  pin('POST /api/v1/me/credential-grants/:grantId/authorize-plan', 'product/account-credential-grant-routes.ts', 'authorizePlanWithCredentialGrant', GRANTS),
  pin('POST /api/v1/auth/credential-children', 'auth/account-credential-parent-key-routes.ts', 'api.createChild', CRED, 'createChildCredential', ...via(/createChild[\s\S]{0,240}?createChildCredential\s*\(/)),
  pin('POST /api/v1/auth/credential-children/:credentialId/rotate', 'auth/account-credential-parent-key-routes.ts', 'api.rotate', CRED, 'rotateCredential', ...via(/rotate[\s\S]{0,240}?rotateCredential\s*\(/)),
  pin('POST /api/v1/auth/credential-children/:credentialId/revoke', 'auth/account-credential-parent-key-routes.ts', 'api.revoke', CRED, 'revokeCredential', ...via(/revoke[\s\S]{0,240}?revokeCredential\s*\(/)),
  // MCP write approval decision.
  pin('POST /api/v1/mcp/approvals/:planId/decision', 'mcp/mcp-write-approval-routes.ts', 'decide', 'src/modules/mcp/write-approval-api.ts'),
  // Collections canonical mutations.
  pin('POST /api/v1/collections', 'product/collection-resource-routes.ts', 'createOwnedCollectionCanonical', `${COLL}/create-owned-collection.ts`),
  pin('PATCH /api/v1/collections/:collectionId', 'product/collection-resource-routes.ts', 'updateCollectionMetadataCanonical', `${COLL}/update-collection-metadata.ts`),
  pin('POST /api/v1/collections/:collectionId/versions', 'product/collection-version-routes.ts', 'createCollectionVersion', `${COLL}/create-collection-version.ts`),
  pin('POST /api/v1/collections/:collectionId/organize-plans', 'product/organize-plan-routes.ts', 'createCollectionOrganizePlan', `${COLL}/create-collection-organize-plan.ts`),
  pin('POST /api/v1/collections/:collectionId/nodes', 'product/node-routes.ts', 'createCollectionNode', `${COLL}/create-collection-node.ts`),
  pin('PATCH /api/v1/collections/:collectionId/nodes/:nodeId', 'product/node-routes.ts', 'updateCollectionNode', `${COLL}/update-collection-node.ts`),
  pin('POST /api/v1/collections/:collectionId/nodes/:nodeId/move', 'product/node-routes.ts', 'moveCollectionNode', `${COLL}/move-collection-node.ts`),
  pin('POST /api/v1/collections/:collectionId/nodes/:nodeId/readable', 'product/readable-replica-routes.ts', 'enqueueNodeReadableExtract', `${COLL}/enqueue-node-readable-extract.ts`),
  pin('POST /api/v1/collections/:collectionId/annotations', 'product/annotation-routes.ts', 'createAnnotation', `${COLL}/create-annotation.ts`),
  pin('PATCH /api/v1/collections/:collectionId/annotations/:annotationId', 'product/annotation-routes.ts', 'updateAnnotation', `${COLL}/update-annotation.ts`),
  pin('DELETE /api/v1/collections/:collectionId/annotations/:annotationId', 'product/annotation-routes.ts', 'deleteAnnotation', `${COLL}/delete-annotation.ts`),
  pin('POST /api/v1/collections/:collectionId/relations', 'product/relation-routes.ts', 'createRelation', `${COLL}/create-relation.ts`),
  pin('PATCH /api/v1/collections/:collectionId/relations/:relationId', 'product/relation-routes.ts', 'updateRelation', `${COLL}/update-relation.ts`),
  pin('DELETE /api/v1/collections/:collectionId/relations/:relationId', 'product/relation-routes.ts', 'deleteRelation', `${COLL}/delete-relation.ts`),
  // Product sync commands (reached through `ports.*` -> shared infra helpers).
  pin('POST /api/v1/sync/conflicts/:conflictId/resolution', 'product/product-sync-center-routes.ts', 'ports.resolveConflict', 'src/infrastructure/sync/product-sync-center-postgres.ts', 'command', 'src/infrastructure/sync/product-sync-center-postgres.ts', /resolveConflict\s*:\s*\(input\)\s*=>\s*command\s*\(/),
  pin('DELETE /api/v1/sync/replicas/:replicaId', 'product/product-sync-center-routes.ts', 'ports.retireReplica', 'src/infrastructure/sync/product-sync-center-postgres.ts', 'command', 'src/infrastructure/sync/product-sync-center-postgres.ts', /retireReplica\s*:\s*\(input\)\s*=>\s*command\s*\(/),
  pin('POST /api/v1/sync/trash/:deletionId/restore', 'product/product-sync-trash-routes.ts', 'ports.restoreTrash', 'src/infrastructure/sync/product-sync-trash-shared-postgres.ts', 'productTrashCommand', 'src/infrastructure/sync/product-sync-trash-postgres.ts', /restoreTrash\s*:\s*\(input\)\s*=>\s*productTrashCommand\s*\(/),
  pin('PATCH /api/v1/me/bookmark-preferences', 'product/bookmark-preferences-routes.ts', 'updateBookmarkPreferences', `${IDENTITY}/bookmark-preferences.ts`),
  // Bookmark subscription mutations register through one shared
  // `app.route({method,url:route,...})` loop (POST/PATCH rows of
  // BOOKMARK_SUBSCRIPTION_ROUTES), so the scanner pins the registration-site
  // label rather than a per-path label. `p.receipts.complete` stores the live
  // `etag` into stableHeaders.
  pin('ROUTE {method,url:route,exposeHeadRoute:false,bodyLimit:operation=', 'product/bookmark-subscription-routes.ts', 'p.receipts.complete', 'src/transport/product/bookmark-subscription-routes.ts', 'registerBookmarkSubscriptionRoutes'),
];

/** Notification preference gaps left with the removed notification routes. */
const KNOWN_GAPS: readonly PinnedRoute[] = [];

/** Routes whose replay branch re-derives ETag outside stored headers. */
const REPLAY_ETAG_FALLBACK_ROUTES = [
  'DELETE /colp/v0.1/sync/collections/:collectionId/nodes/:nodeId/favicon',
  'POST /colp/v0.1/sync/collections/:collectionId/nodes/:nodeId/favicon',
];

// ---- tests ----

interface DiscoveredRoute { readonly transport: string; readonly label: string; readonly call: string; readonly replayOverride: boolean }
function discoverEtagReceiptRoutes(): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = [];
  for (const rel of collectFiles(transportDir).sort()) {
    const abs = join(transportDir, rel);
    const fileSource = stripComments(readFileSync(abs, 'utf8'));
    const consts = constMap(fileSource);
    for (const chunk of routeChunks(fileSource)) {
      if (chunk.method === 'GET' || chunk.method === 'HEAD') continue;
      const code = sendPathCode(chunk.call, abs, fileSource);
      if (!REPLAY_RE.test(code) || !ETAG_RE.test(code)) continue;
      routes.push({ transport: rel, label: `${chunk.method} ${resolveRoute(firstArg(chunk.call), consts)}`,
        call: chunk.call, replayOverride: replayBranchEtag(code) });
    }
  }
  return routes;
}

describe('receipt-replay ETag parity', () => {
  const discovered = discoverEtagReceiptRoutes();
  const byLabel = new Map(discovered.map((route) => [route.label, route]));

  test('the scan finds a real inventory (fail-closed)', () => {
    assert.ok(discovered.length >= 34,
      `expected a broad ETag-receipt route inventory, found ${discovered.length} — the scanner is silently broken`);
  });

  test('every mutation route that replays receipts and sends ETag is pinned', () => {
    assert.deepEqual(discovered.map((route) => route.label).sort(),
      [...REQUIRED_ETAG_RECEIPTS, ...KNOWN_GAPS].map((entry) => entry.label).sort(),
      'a new ETag-bearing receipt route appeared (or a pin went stale) — snapshot `etag` into its stored stableHeaders and pin it in REQUIRED_ETAG_RECEIPTS, or record an intentional KNOWN_GAPS exception');
    assert.deepEqual(discovered.filter((route) => route.replayOverride).map((route) => route.label).sort(),
      [...REPLAY_ETAG_FALLBACK_ROUTES].sort(),
      'replay-side ETag recompute outside stored headers must stay limited to the pinned legacy fallback routes');
  });

  test('pinned routes really invoke their receipted command', () => {
    for (const entry of [...REQUIRED_ETAG_RECEIPTS, ...KNOWN_GAPS]) {
      const route = byLabel.get(entry.label);
      assert.ok(route !== undefined, `${entry.label} was not discovered (is the pin stale?)`);
      assert.equal(route.transport, entry.transport, `${entry.label} moved transport files — update the pin`);
      assert.ok(new RegExp(`\\b${entry.call.replace(/\./g, '\\.')}\\b`).test(route.call),
        `${entry.label} never references ${entry.call} — the pin no longer reflects the handler`);
    }
  });

  test('every required receipt command snapshots etag into stableHeaders', () => {
    const failures: string[] = [];
    for (const entry of REQUIRED_ETAG_RECEIPTS) {
      if (entry.via !== undefined && entry.viaFile !== undefined) {
        const viaSource = loadStripped(join(root, entry.viaFile));
        assert.ok(viaSource !== null, `${entry.label}: missing ${entry.viaFile}`);
        assert.match(viaSource, entry.via, `${entry.label}: wiring for ${entry.call} -> ${entry.receiptFn} not found in ${entry.viaFile}`);
      }
      const results = storedResultsOf(entry.receiptFile, entry.receiptFn);
      const checked = results.filter((r) => !r.passthrough && (r.status === null || r.status < 400));
      assert.ok(checked.length > 0, `${entry.label}: no success-path receipts.complete under ${entry.receiptFn}`);
      for (const result of checked) {
        if (!result.resolved) failures.push(`${entry.label}: unresolvable result expression ${result.site} — extend the scanner`);
        else if (!result.hasEtag) failures.push(`${entry.label}: ${result.site} in ${entry.receiptFile} stores no 'etag' — replays drop the live ETag`);
      }
    }
    assert.deepEqual(failures, []);
  });

  test('known gaps stay pinned as gaps until fixed', () => {
    for (const entry of KNOWN_GAPS) {
      const results = storedResultsOf(entry.receiptFile, entry.receiptFn)
        .filter((r) => !r.passthrough && (r.status === null || r.status < 400));
      assert.ok(results.length > 0, `${entry.label}: no success-path receipts.complete under ${entry.receiptFn}`);
      assert.ok(results.every((r) => !r.hasEtag),
        `${entry.label} now stores etag — move it from KNOWN_GAPS into REQUIRED_ETAG_RECEIPTS`);
    }
  });
});

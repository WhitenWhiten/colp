/**
 * COLP-MCP-15: Legacy MCP absence scanner.
 *
 * Scans production source, generated declarations and the packed tarball for
 * Legacy MCP wire symbols (`McpSessionBinding`, `initialize`,
 * `subscribeResource`/`unsubscribeResource`/`resources/subscribe`,
 * GET/DELETE MCP transport verbs, `Last-Event-ID`, `Mcp-Session-Id`, the
 * legacy `@modelcontextprotocol/sdk` import, ...). The scanner is
 * MCP-specific:
 * - COLP Sync Session symbols (`SyncSession*`) and the lowercase
 *   legacy-header rejection literals used by `request-context.ts` are legal
 *   and never flagged.
 * - GET/DELETE transport verbs are only scanned on MCP-scoped paths
 *   (`src/mcp/**`, `dist/mcp/**`, `src/security/mcp-oauth-client.ts`,
 *   `src/conformance/mcp-conformance.ts`), so the publication endpoint
 *   contracts (`method: "GET"` for `publication` profiles) are never
 *   confused with the Legacy MCP GET/DELETE transport.
 * - The pre-Modern internal helper factories (`createMcpReadToolGateway`,
 *   `createMcpReadMountAdapter`, ...) are intentionally retained inside
 *   `src/mcp/` but never exported; they are API names, not wire symbols, and
 *   are covered by the package-surface contracts instead.
 *
 * Two tiers:
 * - `identifier`: session/wire symbols that must never appear anywhere.
 * - `wire`: wire tokens that may legitimately appear inside documented
 *   rejection text (comments and normative requirement records that say they
 *   are rejected/removed/not supported). `isDocumentedRejectionLine` allows
 *   those lines; comment stripping additionally removes doc-comment mentions.
 */

const identifierTier = Object.freeze([
  'McpSessionBinding',
  'McpReadResourceServerSession',
  'McpSessionId',
  'McpSessionStore',
  'McpSession',
  'subscribeResource',
  'unsubscribeResource',
  'McpStdioCredentialBinding',
  'createMcpStdioCredentialBinding',
  'createMcpReadResourceServer',
  'createMcpResourceServer',
]);

/**
 * Curated Legacy MCP absence symbols. `source` is a case-sensitive regular
 * expression source; identifiers are word-bounded so `McpSessionBinding`
 * never matches `SyncSessionBinding`. `mcpScoped` symbols (GET/DELETE MCP
 * transport verbs) are only scanned on MCP-scoped paths.
 */
export const legacyMcpAbsenceSymbols = Object.freeze([
  ...identifierTier.map((id) => ({
    id,
    tier: 'identifier',
    mcpScoped: false,
    source: `\\b${id}\\b`,
  })),
  { id: 'legacy-sdk-import', tier: 'identifier', mcpScoped: false, source: `['"]@modelcontextprotocol\\/sdk(?:['"\\/]|$)` },
  { id: 'initialize-method', tier: 'wire', mcpScoped: false, source: `['"\`]initialize['"\`]` },
  { id: 'notifications-initialized', tier: 'wire', mcpScoped: false, source: `['"\`]notifications\\/initialized['"\`]` },
  { id: 'resources-subscribe', tier: 'wire', mcpScoped: false, source: `['"\`]resources\\/subscribe['"\`]` },
  { id: 'resources-unsubscribe', tier: 'wire', mcpScoped: false, source: `['"\`]resources\\/unsubscribe['"\`]` },
  { id: 'mcp-session-id-header', tier: 'wire', mcpScoped: false, source: 'Mcp-Session-Id' },
  { id: 'last-event-id-header', tier: 'wire', mcpScoped: false, source: 'Last-Event-ID' },
  { id: 'get-transport-verb', tier: 'wire', mcpScoped: true, source: `\\b(?:method|httpMethod)\\s*[:=]\\s*['"]GET['"]` },
  { id: 'delete-transport-verb', tier: 'wire', mcpScoped: true, source: `\\b(?:method|httpMethod)\\s*[:=]\\s*['"]DELETE['"]` },
]);

/** True when a path belongs to the Modern MCP production surface. */
export function isMcpScopedPath(path) {
  if (typeof path !== 'string' || path.length === 0) return false;
  const normalized = path.replaceAll('\\', '/');
  return normalized.includes('/mcp/')
    || normalized.includes('/security/mcp-oauth-client')
    || normalized.includes('/conformance/mcp-conformance');
}

const documentedRejectionMarker =
  /reject|refus|deny|remov|legacy|absence|absent|not\s+supported|unsupported|not\s+ignored|no\s+.{0,24}backfill|never|quarantin|migrat|revoked|deleted|deprecat|must\s+not|should\s+not|not\s+allowed|forbidden|prohibited|不受支持|不支持|不提供|不得|不允许|禁用|禁止|拒绝|移除|旧版|不再|已删除|被拒绝/iu;

/** True when a source line documents a Legacy MCP wire token as rejected. */
export function isDocumentedRejectionLine(line) {
  return documentedRejectionMarker.test(line);
}

/**
 * Replaces line/block comments with spaces (preserving newlines) so only
 * code literals remain visible to the wire-token scan. Conservative state
 * machine over line comments, block comments, and single/double/template
 * string literals; regex literals are not tracked (their escapes keep `//`
 * and `/*` from forming comment markers).
 */
export function stripCodeComments(source) {
  let output = '';
  let state = 'code';
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];
    if (state === 'code') {
      if (character === '/' && next === '/') {
        state = 'line';
        output += '  ';
        index += 2;
        continue;
      }
      if (character === '/' && next === '*') {
        state = 'block';
        output += '  ';
        index += 2;
        continue;
      }
      if (character === '"' || character === "'" || character === '`') {
        state = character;
        output += character;
        index += 1;
        continue;
      }
      output += character;
      index += 1;
      continue;
    }
    if (state === 'line') {
      output += character === '\n' ? '\n' : ' ';
      index += 1;
      if (character === '\n') state = 'code';
      continue;
    }
    if (state === 'block') {
      if (character === '*' && next === '/') {
        state = 'code';
        output += '  ';
        index += 2;
        continue;
      }
      output += character === '\n' ? '\n' : ' ';
      index += 1;
      continue;
    }
    // String literal (single, double, or template): copy verbatim.
    output += character;
    if (character === '\\' && index + 1 < source.length) {
      output += source[index + 1];
      index += 2;
      continue;
    }
    index += 1;
    if (character === state) state = 'code';
  }
  return output;
}

function lineNumberOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

/**
 * Scans one text for Legacy MCP symbols. Returns findings sorted by index:
 * `{ symbol, index, line }`. `path` scopes MCP-only symbols (GET/DELETE
 * transport verbs) to MCP-scoped paths; omit it to scan those symbols
 * unconditionally (unit-test convenience). `stripComments` removes doc
 * mentions before scanning; `allowDocumentedRejection` permits wire-token
 * lines that document the token as rejected/removed — either via explicit
 * rejection wording or by listing two or more distinct Legacy wire tokens
 * on one line (a rejection catalog such as the normative requirement text).
 * Identifier-tier symbols are never allowed.
 */
export function scanTextForLegacyMcpSymbols(
  source,
  { path, stripComments = true, allowDocumentedRejection = true } = {},
) {
  if (typeof source !== 'string') {
    throw new TypeError('Legacy MCP absence scan requires a string source.');
  }
  const text = stripComments ? stripCodeComments(source) : source;
  const raw = [];
  const lines = text.split('\n');
  const scoped = path === undefined || isMcpScopedPath(path);
  for (const symbol of legacyMcpAbsenceSymbols) {
    if (symbol.mcpScoped && !scoped) continue;
    const pattern = new RegExp(symbol.source, 'gu');
    for (const match of text.matchAll(pattern)) {
      const line = lineNumberOf(text, match.index);
      if (
        symbol.tier === 'wire'
        && allowDocumentedRejection
        && isDocumentedRejectionLine(lines[line - 1] ?? '')
      ) {
        continue;
      }
      raw.push({ symbol: symbol.id, tier: symbol.tier, index: match.index, line });
    }
  }
  // A line that lists two or more distinct wire tokens is a rejection
  // catalog (normative requirement text / docs), not a Legacy usage.
  const wireTokensByLine = new Map();
  for (const finding of raw) {
    if (finding.tier !== 'wire') continue;
    const tokens = wireTokensByLine.get(finding.line) ?? new Set();
    tokens.add(finding.symbol);
    wireTokensByLine.set(finding.line, tokens);
  }
  const findings = raw
    .filter((finding) => {
      if (finding.tier !== 'wire' || !allowDocumentedRejection) return true;
      return (wireTokensByLine.get(finding.line)?.size ?? 0) < 2;
    })
    .map(({ symbol, index, line }) => ({ symbol, index, line }));
  return findings.sort((left, right) => left.index - right.index);
}

/**
 * Scans source, declaration, and tarball file sets and returns a verdict.
 * Each file is `{ path, content }`; declarations and the tarball are scanned
 * with the same comment-stripping + documented-rejection rules.
 */
export function scanLegacyMcpAbsence({ sourceFiles, declarationFiles, tarballFiles }) {
  const sections = [
    ['sourceFiles', sourceFiles],
    ['declarationFiles', declarationFiles],
    ['tarballFiles', tarballFiles],
  ];
  const scanned = { sourceFiles: 0, declarationFiles: 0, tarballFiles: 0 };
  const findings = [];
  for (const [section, files] of sections) {
    if (files === undefined || files === null || !Array.isArray(files)) {
      throw new TypeError(`${section} must be an array of { path, content }.`);
    }
    scanned[section] = files.length;
    for (const file of files) {
      if (file === null || typeof file !== 'object' || typeof file.path !== 'string'
        || typeof file.content !== 'string') {
        throw new TypeError(`${section} entries must be { path: string, content: string }.`);
      }
      for (const finding of scanTextForLegacyMcpSymbols(file.content, { path: file.path })) {
        findings.push({ path: file.path, symbol: finding.symbol, line: finding.line });
      }
    }
  }
  return {
    ok: findings.length === 0,
    findings,
    scanned,
  };
}


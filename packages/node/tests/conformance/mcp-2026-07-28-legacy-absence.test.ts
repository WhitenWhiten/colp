/**
 * COLP-MCP-15: locks the Legacy MCP absence scanner
 * (scripts/lib/legacy-mcp-absence.mjs).
 *
 * The scanner must find no Legacy MCP wire symbol in production source,
 * declarations, or the packed tarball, while:
 * - never flagging COLP Sync Session symbols (SyncSession*) or the lowercase
 *   legacy-header rejection literals in request-context.ts;
 * - tolerating documented rejection mentions (comments and normative
 *   requirement text that say `initialize`, `Mcp-Session-Id`,
 *   `Last-Event-ID`, old subscriptions, GET/DELETE are rejected/removed).
 */
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  isDocumentedRejectionLine,
  legacyMcpAbsenceSymbols,
  scanLegacyMcpAbsence,
  scanTextForLegacyMcpSymbols,
  stripCodeComments,
} from '../../scripts/lib/legacy-mcp-absence.mjs';

const packageRoot = resolve(import.meta.dirname, '..', '..');

async function collectFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(full)));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

async function readContents(paths: string[]): Promise<Array<{ path: string; content: string }>> {
  const contents: Array<{ path: string; content: string }> = [];
  for (const path of paths) {
    contents.push({ path, content: await readFile(path, 'utf8') });
  }
  return contents;
}

describe('Legacy MCP absence scanner (COLP-MCP-15)', () => {
  it('registers a curated MCP-specific symbol list with tier metadata', () => {
    const ids = legacyMcpAbsenceSymbols.map(({ id }) => id);
    for (const id of [
      'McpSessionBinding',
      'McpReadResourceServerSession',
      'McpSessionId',
      'subscribeResource',
      'unsubscribeResource',
      'initialize-method',
      'notifications-initialized',
      'resources-subscribe',
      'resources-unsubscribe',
      'mcp-session-id-header',
      'last-event-id-header',
      'get-transport-verb',
      'delete-transport-verb',
      'legacy-sdk-import',
    ]) {
      expect(ids, id).toContain(id);
    }
    expect(legacyMcpAbsenceSymbols.every(({ id, source, tier, mcpScoped }) =>
      typeof id === 'string' && typeof source === 'string'
      && (tier === 'identifier' || tier === 'wire')
      && typeof mcpScoped === 'boolean')).toBe(true);
    expect(legacyMcpAbsenceSymbols.find(({ id }) => id === 'get-transport-verb')?.mcpScoped)
      .toBe(true);
  });

  it('finds every registered symbol in synthetic Legacy code', () => {
    const samples = [
      ['McpSessionBinding', 'const binding: McpSessionBinding = x;'],
      ['McpReadResourceServerSession', 'let session: McpReadResourceServerSession;'],
      ['McpSessionId', 'const sid = request.headers.McpSessionId;'],
      ['subscribeResource', 'await server.subscribeResource(uri);'],
      ['unsubscribeResource', 'server.unsubscribeResource(uri);'],
      ['initialize-method', "params.method = 'initialize';"],
      ['notifications-initialized', "send('notifications/initialized');"],
      ['resources-subscribe', "method: 'resources/subscribe'"],
      ['resources-unsubscribe', "method: 'resources/unsubscribe'"],
      ['mcp-session-id-header', "const h = 'Mcp-Session-Id';"],
      ['last-event-id-header', "const h = 'Last-Event-ID';"],
      ['get-transport-verb', "method: 'GET'"],
      ['delete-transport-verb', 'httpMethod = "DELETE"'],
      ['legacy-sdk-import', "import { X } from '@modelcontextprotocol/" + "sdk';"],
    ] as const;
    for (const [symbolId, code] of samples) {
      const findings = scanTextForLegacyMcpSymbols(code, { stripComments: true });
      expect(findings.map(({ symbol }) => symbol), symbolId).toContain(symbolId);
    }
  });

  it('never flags COLP Sync Session symbols or lowercase rejection literals', () => {
    const syncSurface = [
      'type SyncSessionBinding = { sessionId: string };',
      'interface SyncSessionStore { save(record: SyncSessionRecord): void; }',
      'const scope: SyncSessionScope = "device";',
      'const LEGACY_MCP_HEADERS = Object.freeze([\'mcp-session-id\', \'last-event-id\']);',
      "if (LEGACY_MCP_HEADERS.includes(key as 'mcp-session-id' | 'last-event-id'))",
      'export function createSyncSession() { return {}; }',
    ].join('\n');
    expect(scanTextForLegacyMcpSymbols(syncSurface, { stripComments: true })).toEqual([]);
    // The word boundary keeps McpSessionBinding distinct from SyncSessionBinding.
    expect(scanTextForLegacyMcpSymbols('type SyncSessionBinding = {};')).toEqual([]);
    expect(scanTextForLegacyMcpSymbols('type McpSessionBinding = {};'))
      .toContainEqual(expect.objectContaining({ symbol: 'McpSessionBinding' }));
  });

  it('strips comments before scanning and tolerates documented rejection mentions', () => {
    // Comment-only mentions of the legacy wire tokens must not be flagged.
    const commentOnly = [
      '// `Mcp-Session-Id` / `Last-Event-ID` are rejected, not ignored.',
      '/* there is no Last-Event-ID backfill */',
      '// the legacy `initialize` interop list',
      '// resources/subscribe and resources/unsubscribe were removed',
    ].join('\n');
    expect(scanTextForLegacyMcpSymbols(commentOnly, { stripComments: true })).toEqual([]);

    // Without comment stripping, documented-rejection lines are still allowed.
    expect(scanTextForLegacyMcpSymbols('// `Mcp-Session-Id` is rejected.', {
      stripComments: false,
    })).toEqual([]);
    expect(isDocumentedRejectionLine('`Mcp-Session-Id` / `Last-Event-ID` are rejected, not ignored.'))
      .toBe(true);
    expect(isDocumentedRejectionLine('const h = "Mcp-Session-Id";')).toBe(false);
    expect(isDocumentedRejectionLine('method: "initialize"')).toBe(false);

    // Real code literals survive comment stripping and are flagged.
    expect(scanTextForLegacyMcpSymbols('// initialize\nconst m = "initialize";'))
      .toContainEqual(expect.objectContaining({ symbol: 'initialize-method' }));
  });

  it('preserves newlines through comment stripping for stable line reporting', () => {
    const source = 'const a = 1;\n// legacy initialize\nconst b = "Mcp-Session-Id";\n';
    const stripped = stripCodeComments(source);
    expect(stripped.split('\n')).toHaveLength(4);
    const findings = scanTextForLegacyMcpSymbols(source, { stripComments: true });
    expect(findings).toContainEqual(expect.objectContaining({ symbol: 'mcp-session-id-header', line: 3 }));
  });

  it('reports per-scope verdicts across source, declarations, and tarball', () => {
    const sourceFiles = [
      { path: 'src/mcp/index.ts', content: 'export const modern = "2026-07-28";' },
    ];
    const declarationFiles = [
      { path: 'dist/mcp/index.d.ts', content: 'export declare const MCP_PROTOCOL_VERSION: "2026-07-28";' },
    ];
    const tarballFiles = [
      { path: 'package/dist/mcp/index.js', content: 'var MCP_PROTOCOL_VERSION = "2026-07-28";' },
    ];
    expect(scanLegacyMcpAbsence({ sourceFiles, declarationFiles, tarballFiles })).toMatchObject({
      ok: true,
      scanned: { sourceFiles: 1, declarationFiles: 1, tarballFiles: 1 },
      findings: [],
    });

    const leaked = [
      ...sourceFiles,
      { path: 'dist/mcp/index.d.ts', content: 'export declare const McpSessionBinding: unknown;' },
    ];
    const report = scanLegacyMcpAbsence({
      sourceFiles,
      declarationFiles: leaked,
      tarballFiles,
    });
    expect(report.ok).toBe(false);
    expect(report.findings).toContainEqual(expect.objectContaining({
      path: 'dist/mcp/index.d.ts',
      symbol: 'McpSessionBinding',
    }));
  });

  it('scopes GET/DELETE transport verbs to MCP paths only', () => {
    // Publication endpoint contracts legitimately declare GET/DELETE; they
    // are not MCP transport and must never be flagged.
    const publication = "readonly method: 'GET';\nreadonly method: 'DELETE';";
    expect(scanTextForLegacyMcpSymbols(publication, {
      stripComments: true,
      path: 'dist/semantic/endpoint-contracts.d.ts',
    })).toEqual([]);
    expect(scanLegacyMcpAbsence({
      sourceFiles: [],
      declarationFiles: [{
        path: 'dist/endpoint-contracts-x.d.ts',
        content: "readonly method: 'GET';\nreadonly method: 'DELETE';",
      }],
      tarballFiles: [],
    }).ok).toBe(true);
    // On the MCP surface, a GET/DELETE transport verb is a hard finding.
    expect(scanTextForLegacyMcpSymbols("method: 'GET'", {
      stripComments: true,
      path: 'src/mcp/2026-07-28/transport.ts',
    })).toContainEqual(expect.objectContaining({ symbol: 'get-transport-verb' }));
    expect(scanTextForLegacyMcpSymbols("method: 'DELETE'", {
      stripComments: true,
      path: 'dist/mcp/index.js',
    })).toContainEqual(expect.objectContaining({ symbol: 'delete-transport-verb' }));
  });

  it('treats a line listing two or more distinct wire tokens as a rejection catalog', () => {
    const catalog = 'requirement: "must reject initialize, Mcp-Session-Id, Last-Event-ID, GET/DELETE, old subscriptions, logging/setLevel, ping instead of ignoring them."';
    expect(scanTextForLegacyMcpSymbols(catalog, { stripComments: true })).toEqual([]);
    // A single wire token on an ordinary line is still a finding.
    expect(scanTextForLegacyMcpSymbols('const header = "Mcp-Session-Id";'))
      .toContainEqual(expect.objectContaining({ symbol: 'mcp-session-id-header' }));
  });

  it('does not flag Modern POST transport verbs or lower-case method names', () => {
    const modern = [
      "httpMethod: 'POST'",
      "method: 'server/discover'",
      "method: 'resources/read'",
      "method: 'subscriptions/listen'",
      "method: 'tools/call'",
      "method: 'changes.commit'",
      "if (type.endsWith('.delete'))",
      "if (!('get' in descriptor))",
    ].join('\n');
    expect(scanTextForLegacyMcpSymbols(modern, { stripComments: true })).toEqual([]);
  });

  it('finds no Legacy MCP symbol in the real production source tree', async () => {
    const sourceRoot = resolve(packageRoot, 'src');
    const paths = (await collectFiles(sourceRoot)).filter(
      (path) => !/[\\/]generated[\\/]/u.test(path) && !path.endsWith('.map'),
    );
    expect(paths.length).toBeGreaterThan(100);
    const report = scanLegacyMcpAbsence({
      sourceFiles: await readContents(paths),
      declarationFiles: [],
      tarballFiles: [],
    });
    expect(report.findings, JSON.stringify(report.findings.slice(0, 5), null, 2)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.scanned.sourceFiles).toBe(paths.length);
  });

  it('finds no Legacy MCP symbol in dist declarations when a prior build exists', async () => {
    const distRoot = resolve(packageRoot, 'dist');
    const exists = await readdir(distRoot).then(() => true).catch(() => false);
    if (!exists) {
      expect(exists).toBe(false);
      return;
    }
    const paths = (await collectFiles(distRoot)).filter((path) =>
      /\.d\.(?:ts|cts)$/u.test(path));
    expect(paths.length).toBeGreaterThan(0);
    const report = scanLegacyMcpAbsence({
      sourceFiles: [],
      declarationFiles: await readContents(paths),
      tarballFiles: [],
    });
    expect(report.ok, JSON.stringify(report.findings.slice(0, 5), null, 2)).toBe(true);
  });
});


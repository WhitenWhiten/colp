/**
 * COLP Modern-only legacy-rejection policy applied at the test fixture host
 * boundary (migration decision §1.3 / §7). The upstream SDK already rejects
 * the legacy wire-era flows it can classify; this module adds the two
 * legacy headers (`Mcp-Session-Id`, `Last-Event-ID`) that the 2026-07-28
 * transport ignores rather than rejects, so the fixture host enforces COLP's
 * Modern-only contract end to end. This is policy enforcement at the HTTP
 * bridge — it is NOT a hand-written JSON-RPC/SSE engine.
 */

export const LEGACY_SESSION_HEADERS = ['mcp-session-id', 'last-event-id'] as const;

export interface ModernEnvelopeInput {
  readonly protocolVersion?: string;
  readonly clientInfo?: { readonly name: string; readonly version: string };
  readonly clientCapabilities?: Readonly<Record<string, unknown>>;
}

/**
 * Builds the per-request `_meta` envelope required by MCP 2026-07-28
 * (protocolVersion + clientCapabilities are required; clientInfo is SHOULD).
 */
export function buildModernEnvelope(input: ModernEnvelopeInput = {}): Record<string, unknown> {
  return {
    'io.modelcontextprotocol/protocolVersion': input.protocolVersion ?? '2026-07-28',
    'io.modelcontextprotocol/clientInfo': input.clientInfo ?? {
      name: 'colp-fixture-probe',
      version: '0.0.0',
    },
    'io.modelcontextprotocol/clientCapabilities': input.clientCapabilities ?? {},
  };
}

/** Returns the first legacy session-era header present on the request, if any. */
export function findLegacySessionHeader(request: Request): string | undefined {
  for (const name of LEGACY_SESSION_HEADERS) {
    if (request.headers.has(name)) return name;
  }
  return undefined;
}

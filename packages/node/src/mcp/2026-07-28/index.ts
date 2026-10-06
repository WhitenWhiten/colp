/**
 * Explicitly versioned MCP Read package surface — `/mcp/2026-07-28` entry
 *.
 *
 * This entry exposes the exact same Modern `2026-07-28` Read + shared surface
 * as the default `/mcp` entry (`src/mcp/index.ts`) so developers who want to
 * pin their compile contract to a specific protocol revision can import the
 * version-identified subpath without any behavior drift. The two entries are
 * kept identical by re-exporting the same module; `npm run typecheck` and the
 * package-surface contract test assert the key sets are equal.
 *
 * Like the default entry, this entry never exports the legacy Session
 * binding, the legacy read server session, the handshake method, old
 * subscription methods, Legacy transport types or the pre-Modern
 * adapter/factory signatures.
 */
export * from '../index.js';

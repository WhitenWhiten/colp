/**
 * Shared cache metadata for anonymous public MCP reads.
 *
 * Private and authenticated results stay `private` + `ttlMs: 0`. The COLP
 * 2026-07-28 result factory default (`private` + 0) is unchanged; host
 * projections must stamp public cache explicitly.
 */
export const PHASE4B_MCP_PUBLIC_READ_CACHE_TTL_MS = 60_000;

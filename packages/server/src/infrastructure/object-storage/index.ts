/**
 * P4A-I06 object-storage public facade.
 *
 * Re-exports the narrow `BlobStorePort` surface and the Cloudflare R2 adapter
 * factory, plus the P4A-I09 module-port adapter. No AWS SDK type is
 * re-exported here: the business side and evidence probes consume only the
 * port types (the compile-level guard in the focused unit suite pins this).
 */
export * from './blob-store-port.js';
export * from './r2-adapter.js';

/**
 * Product API types for the self-hosted edition.
 *
 * Re-exports src/generated/colp-server-v1.ts via the `@known/product-v1`
 * alias. That file is generated from packages/server/openapi/colp-server-v1.yaml
 * (the trimmed server document, read in place — not a copy in this package).
 */
export type {
  paths,
  webhooks,
  components,
  operations,
  $defs,
} from '@known/product-v1'

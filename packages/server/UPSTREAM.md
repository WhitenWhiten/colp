Copied from Know-N commit c34645710eb3d0067ef734cf7a674364df765687 on 2026-10-07T08:48:49-07:00; later ports are diffs from this hash.

Extra files, copied because `npm run typecheck` failed without them (`TS2307` on imports from `src`; `seed` and `scripts/evidence` were not copied):

- `generated/openapi/product-v1.ts` — imported by `src/transport/product-codes.ts` and `src/modules/identity/application/credit-ledger-read.ts`
- `generated/openapi/product-v1.routes.ts` — imported by `src/transport/product-route-manifest.ts`
- `generated/openapi/product-v1.client.ts` — imported by unit tests (`product-v1.client.js`) and read by OpenAPI contract tests
- `generated/openapi/product-v1.bundle.yaml` — read by OpenAPI catalog and sync-center contract tests
- `generated/openapi/product-v1.routes.json` — read by product route manifest and search OpenAPI contract tests

A2 copied these because `npm run test:unit` could not load Vitest projects without them (Know-N `c34645710`):

- `vitest.workspace-projects.ts` — imported by `vitest.unit.config.ts` and the other project configs
- `scripts/vitest-project-files.mjs` — imported by `vitest.workspace-projects.ts`

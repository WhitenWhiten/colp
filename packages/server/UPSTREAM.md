Copied from Know-N commit c34645710eb3d0067ef734cf7a674364df765687 on 2026-10-07T08:48:49-07:00; later ports are diffs from this hash.

Extra files, copied because `npm run typecheck` failed without them (`TS2307` on imports from `src`; `seed` and `scripts/evidence` were not copied):

- `generated/openapi/product-v1.ts` — imported by `src/transport/product-codes.ts` and `src/modules/identity/application/credit-ledger-read.ts`
- `generated/openapi/product-v1.routes.ts` — imported by `src/transport/product-route-manifest.ts`

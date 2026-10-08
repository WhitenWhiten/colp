Copied from Know-N commit c34645710eb3d0067ef734cf7a674364df765687 on 2026-10-07T08:48:49-07:00; later ports are diffs from this hash.

Extra files, copied because `npm run typecheck` failed without them (`TS2307` on imports from `src`; `seed` and `scripts/evidence` were not copied):

- `generated/openapi/product-v1.ts` — imported by `src/transport/product-codes.ts` and `src/modules/identity/application/credit-ledger-read.ts`
- `generated/openapi/product-v1.routes.ts` — imported by `src/transport/product-route-manifest.ts`
- `generated/openapi/product-v1.client.ts` — imported by unit tests (`product-v1.client.js`) and read by OpenAPI contract tests
- `generated/openapi/product-v1.bundle.yaml` — read by OpenAPI catalog and sync-center contract tests
- `generated/openapi/product-v1.routes.json` — read by product route manifest and search OpenAPI contract tests

A2 moved the email delivery ports out of `modules/notifications` into `modules/email` so that module could be deleted while the kept mailer still typechecks.

A2 copied these because `npm run test:unit` could not load Vitest projects without them (Know-N `c34645710`):

- `vitest.workspace-projects.ts` — imported by `vitest.unit.config.ts` and the other project configs
- `scripts/vitest-project-files.mjs` — imported by `vitest.workspace-projects.ts`

A6 image (`packages/server/Dockerfile`): the web UI is built with `VITE_EDITION=self-hosted` and stored at `/srv/web`. Caddy serves it. `deploy/compose.yaml` mounts the named volume `colp-web` on `/srv/web` (read-only in each Caddy service). The Node process does not serve those files. An empty mount hides the image directory, so the same tree is also at `/opt/colp-web` and the entrypoint copies it into `/srv/web` only when that mount has no `index.html`. No second server, Redis, object storage, or mail server. Migrations are esbuild-bundled to `dist-migrations/` (D23) so the runtime image does not need TypeScript. The process is `node dist/src/bootstrap/self-hosted.js`.

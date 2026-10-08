# Phase 2B Annotation Workflow Acceptance Evidence

Date: 2026-07-25  
Capability: P2B-04 through P2B-09 (`annotations`)  
Result: **Accepted**

The independent P2B-09 acceptance agent completed the full static, unit,
coverage, build, mocked-browser, real-stack, PostgreSQL, migration, fault, and
responsive visual matrix. The `annotations` feature flag is enabled and the
live surface fails closed instead of falling back to demo data.

## Candidate behavior

- Reader private notes and highlights use the generated Product 1.3 Annotation
  DTOs and the canonical Product client for subject-scoped list/get/create/
  patch/delete. Resource Detail exposes the same canonical subject context.
- Annotation pagination uses its independent cursor to completion before a
  page receives results. A continuation never reuses an editor, Profile, or
  Publication cursor.
- Save and delete intents retain one `Known-Command-Id`, frozen body, target,
  and ETag across request-not-arrived and commit-outcome-unknown replay.
- A 412 refreshes the current Annotation/ETag and requires the user to choose
  whether to apply the retained draft. A 409 command reuse cannot be blindly
  retried; the user must explicitly start a new intent.
- Resource changes abort list, item, save, and delete requests. A generation
  fence rejects late completions even when a transport ignores cancellation.
- Dirty drafts install browser and in-app navigation guards. Success clears the
  retained intent and restores a predictable focus target.
- Plain, Markdown, and HTML values are rendered as text because this frontend
  has no established trusted sanitizer. Server values are never passed to
  `dangerouslySetInnerHTML`.
- With the flag disabled, the existing demo/localStorage Reader remains
  available. With the flag enabled, API failures are explicit and never fall
  back to mock or localStorage state.

## Completed verification

From `Known-Frontend/web`:

```text
npm exec vitest run -- src/api/annotationClient.test.ts src/api/annotation-boundary.test.ts src/pages/Reader.annotations.test.tsx src/pages/ResourceDetail.annotations.test.tsx src/api/productClient.test.ts src/api/productClient.boundary.test.ts
npm run test:unit
npm run test:e2e -- e2e/annotation-workflows.spec.ts
npm run build
npm run test:e2e:real-stack -- e2e-real-stack/annotation-acceptance.spec.ts
```

Results:

- focused Annotation unit boundary: 4 files, 17 tests passed;
- complete unit suite: 14 files, 130 tests passed;
- coverage suite: 130 tests passed, 89.78% statements overall;
- production TypeScript/Vite build passed;
- complete mocked Playwright suite: 27 tests passed;
- complete isolated real-stack Playwright suite: 5 tests passed.

From `Known-Backend`:

```text
npm exec vitest run -- tests/unit/annotation-openapi-contract.test.ts tests/unit/annotation-product-http.test.ts tests/unit/publication-snapshot-annotations-query.test.ts tests/unit/publication-snapshot-http.test.ts tests/unit/annotation-create-migration-static.test.ts tests/unit/annotation-product-read-migration-static.test.ts tests/unit/publication-annotation-index-migration-static.test.ts
node scripts/with-postgres.mjs -- npm exec vitest run -- --fileParallelism=false tests/integration/annotation-migration-postgres.integration.test.ts tests/integration/annotation-create-postgres.integration.test.ts tests/integration/annotation-update-postgres.integration.test.ts tests/integration/annotation-delete-postgres.integration.test.ts tests/integration/annotation-product-http-postgres.integration.test.ts tests/integration/postgres-publication-annotation-projection.integration.test.ts
npm run openapi:ci
npm run typecheck
npm run lint
```

Results:

- focused Annotation/Product/Publication unit suite: 6 files, 33 tests passed;
- OpenAPI generation, drift, breaking-change and build checks passed;
- import boundaries, COLP public contract, typecheck and lint passed;
- `npm run ci:static`: 104 files, 982 tests passed, audit reported zero
  vulnerabilities;
- `npm run ci:docker`: 24 migrations applied and latest migration idempotent;
  31 integration files / 226 tests passed; coverage ran 105 files / 996 tests
  at 94.7% statements and 100% functions; transaction fault and startup
  readiness probes passed.

Repository root:

```text
git diff --check
```

Result: passed with no whitespace errors.

## Real-stack evidence

The isolated production-migration PostgreSQL/Fastify/browser harness proved:

- browser create, update, delete and direct-refresh persistence, corroborated
  by HTTP statuses and authoritative database rows rather than local state;
- two independently authenticated browser contexts, proving one creator's
  private note is absent from the other principal's Product list;
- an independent anonymous browser context assembling
  `Snapshot?include=annotations`, containing a public Annotation and excluding
  the private note;
- controlled request-not-arrived and commit-outcome-unknown failures that
  capture identical command IDs on replay;
- controlled stale precondition and command-reuse outcomes that require the
  explicit UI recovery paths;
- keyboard, focus, screen-reader status, and 375 px viewport assertions with no
  clipped or overlapping Annotation controls.

It also exercised COLP-valid private highlights as `format: json` with
`value.quote`, including creation, refresh persistence, deletion, and the
authoritative tombstone.

## Responsive and accessibility review

The mocked Playwright acceptance test captures full-page Reader and Resource
Detail screenshots at 1280 x 800 and 375 x 720. All four variants were
pixel-reviewed. The layouts have no horizontal overflow, incoherent overlap,
clipped text, or unreachable Annotation controls. Keyboard navigation, dirty
navigation confirmation, post-delete textarea focus, polite save status, and
safe text-only rendering passed.

## Acceptance repairs

- Corrected fetch-mock call inspection and unambiguous accessible locators.
- Restored note focus only after React committed a successful delete.
- Made real-stack Profile handles, publication slugs, second-user Secure
  cookies, and public Annotation fixtures satisfy production constraints.
- Corrected highlight creation to the COLP `json/{quote}` shape and added real
  create/refresh/delete/tombstone coverage.
- Made Profile cursor tampering deterministic by changing effective HMAC bits.
- Allowed the conformance probe one revalidation when a Snapshot continuation
  ETag legitimately rolls over between minute buckets.
- Isolated anonymous Publication assertions in a separate browser context so
  cache-policy evidence does not depend on logout cookie timing.
- Pinned compatible patched `brace-expansion`, `js-yaml`, and `minimatch`
  overrides; the final audit and full coverage suite both passed.

## Acceptance decision

P2B-09 is accepted. `annotations: true` and this evidence are guarded by the
frontend boundary test so the capability cannot be enabled without the
recorded accepted decision.

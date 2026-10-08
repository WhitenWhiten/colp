# Phase 2B Relation Workflow Acceptance Evidence

Date: 2026-07-25  
Capability: P2B-10 through P2B-14 (`relations`)  
Result: **Accepted**

Independent acceptance verified the Resource Detail integration against the
generated Product Relation contract. The narrow `relations` flag and the
composite `resourceDetail` flag are enabled after completing the required
static, PostgreSQL, Fastify, unit, browser, responsive, and accessibility
verification.

## Candidate behavior

- Incoming and outgoing lists are loaded independently through Relation-only
  cursors and rendered as compact, text-safe rows.
- Endpoint choices come from the complete current Collection Editor snapshot.
  Duplicate titles remain separate options because option values and links use
  canonical Node IDs. Deleted or cross-Collection IDs cannot be typed.
- Create, patch, delete, and explicit endpoint replacement use the generated
  Relation DTOs through the single Product client. Endpoint replacement is a
  delete intent followed by a distinct create intent; Relation operations do
  not call Node move or mutate tree positions.
- Unknown mutation outcomes retain their command intent for replay. Stale
  preconditions refresh authoritative lists before another save, and command
  reuse requires an explicit new user intent.
- Relation labels are inserted only as React text. Dirty, pending, and
  uncertain edits install unload and in-app navigation guards; cancelling an
  edit restores focus to its trigger.
- The layout uses the existing Resource Detail surface, typography, controls,
  dividers, and reduced-motion policy, with a single-column form below 760 px.

## Independent acceptance results

- `npm test -- --run src/api/relationClient.test.ts src/pages/ResourceDetail.relations.test.tsx src/api/relation-boundary.test.ts`: 3 files, 11 tests passed.
- `npm test`: 17 files, 141 tests passed.
- `npm run build`: TypeScript project build and Vite production build passed.
- `npx playwright test`: 31 tests passed against the mocked Product API.
- `npm run test:e2e:real-stack`: 7 tests passed after applying 28 migrations against real PostgreSQL, Fastify, and the generated client. Coverage included CRUD and refresh persistence, duplicate-title ID binding, endpoint deletion and replacement, unchanged tree position, and anonymous Snapshot public inclusion/private exclusion.
- `npm run ci:static` in `Known-Backend`: 115 files and 1033 tests passed, followed by typecheck, lint, import boundaries, COLP validation, audit, OpenAPI validation, and production build.
- `npm run ci:docker` in `Known-Backend`: migration smoke applied 28 migrations; integration/coverage ran 116 files and 1047 tests; transaction-fault and startup-readiness gates passed.

The acceptance agent additionally corrected stale editor fixtures, mocked and
real-stack route fixtures, the real-stack position-token query, and mutation
race handling. Create, update, delete, and two-phase endpoint replacement now
abort and fence late responses when the selected resource changes. Replacement
recovery retains separate delete/create intent IDs, its exact command, and its
current phase for unknown-outcome replay; 409 recovery is explicit and cancel
remains disabled while saving or resolving unknown/conflicting outcomes.

## Browser and accessibility review

- At 1280 x 800 and 375 x 720, the Relation workspace has no horizontal page overflow, clipped descendants, incoherent overlap, or unsafe label rendering. Duplicate titles expose distinct Node IDs, and a label containing `<script>` renders as text without creating a script element.
- Relation action buttons and form controls provide stable 44 px targets. The mobile form collapses to one column and preserves readable incoming/outgoing rows.
- Focus-visible styling is present on native controls. The create form follows DOM order: endpoint, type, label, visibility, then create. Editing and cancelling returns focus to the originating Edit button. Delete and replacement use native confirmation, which returns focus to their invoking control when dismissed.
- Form controls have explicit accessible labels; mutation feedback uses `role="status"` with `aria-live="polite"`. The workspace inherits the application focus policy and includes a scoped `prefers-reduced-motion: reduce` fallback.

No unresolved acceptance defect remains. The accepted flags are
`relations: true` and `resourceDetail: true`.

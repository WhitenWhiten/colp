# Known — static UI

Monochrome editorial front-end for Known (online bookmarks, shared collections, browser sync, and knowledge paths).

## Product copy boundary

Known is an online bookmark library. Homepage, footer, SEO, OG, and share copy should lead with saved links, browser bookmarks, synced folders, collections, collaboration, and knowledge paths.

Do not use "research desk", "your desk on the web", or "open your desk" as product positioning. The dashboard route may describe its optional start-page board, and legacy `desk-*` implementation names may remain until a compatibility-safe rename is planned.

## Documentation

Current design-system and runtime docs live in [`docs/`](./docs/):

- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — CSS layers, copy boundary, style quality gates
- [`docs/PRODUCT.md`](./docs/PRODUCT.md) — brand, positioning, design principles
- [`docs/PERF-BUDGET.md`](./docs/PERF-BUDGET.md) — bundle size budget and loading strategy

Historical static-demo notes are archived at
[`docs/plans/completed/known-frontend/static-demo-documentation.md`](../../docs/plans/completed/known-frontend/static-demo-documentation.md).
Design-system structure audits live under
[`docs/audits/known-frontend/`](../../docs/audits/known-frontend/); the 2026-08-20
pass is [`2026-08-20-design-system/`](../../docs/audits/known-frontend/2026-08-20-design-system/).

## Run

```bash
cd web
npm install
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`).

## API origin (Phase 1 Product client)

The browser Product client (`src/api/`) calls `/api/v1/*` with `credentials: 'include'`.

| Mode | Config | Behavior |
|------|--------|----------|
| Same-origin / proxy (default) | leave `VITE_API_ORIGIN` unset | Relative `/api/v1/...`. Vite dev server proxies `/api` → `VITE_API_PROXY` (default `http://127.0.0.1:3000`). |
| Explicit API origin | `VITE_API_ORIGIN=http://localhost:3000` | Absolute URLs. Backend CORS must allow the Vite origin with credentials (no `*`). |

Example `.env.local`:

```bash
# Optional — prefer proxy default unless you need a fixed absolute origin
# VITE_API_ORIGIN=http://127.0.0.1:3000
VITE_API_PROXY=http://127.0.0.1:3000
```

Session/CSRF never go to `localStorage`. Command-intent IDs use `sessionStorage` only for `Known-Command-Id` reuse on retry.

### Real Backend and PostgreSQL editor evidence

`npm run test:e2e` (frontend CI check `browser-e2e`) is the **mocked** Product
API suite. It runs four Playwright lanes: `chromium` (1280×800, every spec) plus
`mobile-chromium` (390, coarse pointer), `tablet-chromium` (768) and
`tablet-landscape-chromium` (1024), which pick up only `*.responsive.spec.ts`.
Put viewport-dependent chrome, breakpoint, touch-target and overflow assertions
in a `*.responsive.spec.ts` file and branch on `page.viewportSize()` so one spec
covers both sides of every cut. `visual.responsive.spec.ts` holds the
`toHaveScreenshot` baselines for the anonymous core surfaces (Landing, Explore,
Login) per lane; refresh them only on purpose with
`npx playwright test visual --update-snapshots` and review the image diff.

Full-stack proof for the self-hosted edition is `deploy/smoke.sh` against the
compose stack (health, readiness, Manifest, and the COLP conformance runner).
The Know-N real-stack Playwright suite needs Know-N's backend harness
(`real-stack-e2e.mjs`) and stays in Know-N; see `UPSTREAM.md`.

### Live vs mock: source of truth

The per-capability mock/live switch is `src/api/featureFlags.ts`
(`FEATURE_FLAGS`). A flag is `true` only after the backend capability is
verified and the page's data hook is wired to `productClient`; `true` means
the page calls the real API and shows an error state on failure (never a
silent mock fallback). Almost every product surface is live today — the only
flags still `false` are `mfa` (backend surface pending) and `graph`
(vestigial; the Graph page reads live relations regardless).

Mock data (`src/api/mock-data.ts`, `src/legacy-demo/`) remains only on the
`/demo/*` comparison tree, the Dashboard module catalog, and the extension
capture popup.

## Pages

Status: **Live** = Product API · **Local** = live page with local-only state
(localStorage) · **Static** = content/handoff page, no API · **Demo** = mock
data by design.

| Route | Page | Status |
|-------|------|--------|
| `/` | Landing (marketing + live Explore preview) | **Live** |
| `/today` | Daily bookmark review and focus queue | **Live** |
| `/explore` | Explore collections | **Live** |
| `/search` | Site search (collections / curators / bookmarks / paths) | **Live** |
| `/feed` | Following feed | **Live** |
| `/share` | Share promo (product) | Static |
| `/share/:slug` | Collection share + OG/embed | **Live** |
| `/c/:slug` | Public collection (Board/List; `?role=` access matrix) | **Live** |
| `/path/:slug` | Guided reading path | **Live** + Local (done-state) |
| `/read/:resourceId` | Reading, highlights, and private notes | **Live** |
| `/u/:handle` · `/profile/:handle` | Curator profile (collections / activity / following) | **Live** |
| `/r/:id` | Resource detail + relations | **Live** |
| `/library` | Library desk: owned collections, shared collections, and pending invites (`?view=reading` for saved reading) | **Live** |
| `/library/:id` | Same desk with that collection selected; `?folder=` filters to a folder; edit/add in More | **Live** |
| `/library/new` | Create collection (`POST /api/v1/collections`) | **Live** |
| `/library/:id/edit` | Product editor (details + tree); open from More | **Live** |
| `/library/:id/history` | Collection version history | **Live** |
| `/library/:id/collaborators` | Members (invite, role, remove) plus shared collections and pending invites | **Live** |
| `/library/health` | Broken, redirected, duplicate, and stale link maintenance | **Live** |
| `/dashboard` | Browser start page + module market + New collection | Local (module catalog mock; Explore pins live) |
| `/login` · `/register` | OIDC start (`GET /api/v1/auth/oidc/start`) | **Live** |
| `/consent` · `/reset-password` · `/verify-email` · `/auth/recovery` | Auth flows | **Live** |
| `/onboarding` | Setup flow (follows popular collections via Explore) | **Live** |
| `/graph/:slug` | Knowledge graph | **Live** |
| `/creator` | Creator studio + analytics | **Live** |
| `/export` | JSON export of owned collections | **Live** |
| `/settings` | Compatibility redirect to `/library?settings=` (hash maps to the section) | — |
| `/settings/export` | Compatibility redirect to `/export` | — |
| `/sync` | Sync center (folders + conflicts) | **Live** |
| `/classify` | Classify inbox queue (backend `KNOWN_FEATURE_CLASSIFY` gates availability) | **Live** |
| `/import` | Import handoff (the extension reads bookmark files, not the site) | Static |
| `/extension` | Extension install (store button is a demo toast until listing is live) | Static |
| `/extension/popup` | Capture popup demo | Demo |
| `/notifications` | Notification center (`?filter=collection` preselects Collection updates) | **Live** |
| `/updates` | Redirects to `/notifications?filter=collection` | — |
| `/approvals` · `/approvals/:planId` | MCP write approvals (signed-in list and resumable direct-plan review) | **Live** |
| `/creator` · `/ai/organize` | Creator insights · heuristic organize plan | **Live** |
| `/demos` · `/demo/*` | Legacy mock comparison tree (not in production chrome) | Demo |
| `/about` · `/contact` · `/privacy` · `/mcp` · `/developers` | Trust / product pages | Static |

The `/demo` tree is a comparison clone, not production IA; chrome never links
to it.

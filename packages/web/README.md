# COLP Server web UI

The browser UI that ships inside COLP Server: sign-in, the owner's library,
public collection pages, agents and write approvals, sync, and link health.
It is a single-page app served by `packages/server` from `dist/`. It was
copied from Know-N's frontend (see [`UPSTREAM.md`](./UPSTREAM.md)) and keeps
Know-N's palette; the self-hosted layout and type live in
`src/styles/edition.css` and the edition block at the end of
`src/styles/tokens.css`.

## Run

```bash
cd packages/web
npm install
npm run dev
```

Open the URL Vite prints. The dev server proxies `/api` to `VITE_API_PROXY`
(default `http://127.0.0.1:3000`), so start a COLP Server there first
(`deploy/` has the compose stack).

| Mode | Config | Behavior |
|------|--------|----------|
| Same origin / proxy (default) | leave `VITE_API_ORIGIN` unset | Relative `/api/v1/...`; Vite proxies `/api` to `VITE_API_PROXY`. |
| Explicit API origin | `VITE_API_ORIGIN=http://127.0.0.1:3000` | Absolute URLs. The server's CORS must allow the Vite origin with credentials. |

Session and CSRF state never go to `localStorage`. Command-intent IDs use
`sessionStorage` only so a retry can reuse its `Known-Command-Id`.

## Routes

| Route | Page |
|-------|------|
| `/` | Redirects to `/library` when signed in, `/login` otherwise |
| `/login` · `/register` · `/auth/recovery` · `/consent` | Sign-in, owner or invite sign-up, session recovery, OAuth consent for agents |
| `/library` · `/library/:id` | Library desk: owned and shared collections, pending invites; `?folder=` opens a folder, `?settings=` opens Settings |
| `/library/new` | Create a collection |
| `/library/:id/edit` | Collection editor (details and tree) |
| `/library/:id/history` | Collection versions and restore |
| `/library/:id/collaborators` | Members and invites |
| `/library/health` | Broken, redirected, duplicate, and stale links |
| `/c/:slug` | Published collection (Board, Gallery, List, Compact) |
| `/r/:id` | Bookmark detail with annotations and relations |
| `/graph/:slug` | Relation graph |
| `/search` | Search collections, bookmarks, and annotations |
| `/agents` | Connected agents, keys, and approval policy |
| `/approvals` · `/approvals/:planId` | MCP write approvals |
| `/sync` | Sync center: browsers, conflicts, and trash |
| `/import` | Import a bookmarks file |
| `/extension` | Connect the browser extension to this server |
| `/about` | Server and protocol versions |
| `/dashboard` · `/mcp` · `/settings` | Redirects kept for old links |

Anything else renders the 404 page.

`src/api/featureFlags.ts` keeps one flag per capability. All are on in
production; `window.__KNOWN_FLAGS__` overrides them in tests and local
debugging only.

## Checks

| Command | What it runs |
|---------|--------------|
| `npm run typecheck` | `tsc -b` |
| `npm run lint` | ESLint, zero warnings |
| `npm run lint:css` | Stylelint, style drift, inline styles, dead and ghost classes |
| `npm test` | Vitest unit and contract suites (happy-dom) |
| `npm run test:scripts` | Tests for the style gate scripts |
| `npm run build` | Typecheck, then `vite build` into `dist/` |
| `npm run check:bundle-budget` | Entry JS and CSS gzip budgets (after a build) |
| `xvfb-run -a npm run test:e2e` | Playwright against mocked Product API routes |

The Playwright suite runs four lanes: `chromium` (1280×800, every spec) plus
`mobile-chromium` (390, coarse pointer), `tablet-chromium` (768) and
`tablet-landscape-chromium` (1024), which pick up only `*.responsive.spec.ts`.
`visual.responsive.spec.ts` holds the screenshot baselines; refresh them only
on purpose with `--update-snapshots` and review the image diff.

`playwright.self-hosted.config.ts` runs `acceptance/` against a real compose
stack (`COLP_ACCEPTANCE_ORIGIN`). Full-stack smoke is `deploy/smoke.sh`.

`npm run generate:api-types` regenerates `src/generated/colp-server-v1.ts`
from `packages/server/openapi/colp-server-v1.yaml`.

## Documentation

[`docs/`](./docs/) holds the architecture (CSS layers, tokens, style gates),
the product and interaction rules, the bundle budget, and the icon system.

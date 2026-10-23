# COLP Server web UI

The browser UI that ships inside COLP Server: sign-in, the owner's library,
shared folder links, public collection pages, agents and write approvals, sync,
and link health.
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

`npm run test:e2e` runs every desktop and responsive Playwright test under
xvfb; CI requires all four shards. `npm run test:acceptance` builds the real
server and web application, creates a disposable PostgreSQL database and owner,
and verifies sign-in, editing, private notes, repeated HTML imports, anonymous
sharing and revocation, Sync center, versions and shipped documentation. The
fixture stops its server and removes the database on success, failure or
interruption. `npm run test:scripts` checks actual Playwright discovery against
both test directories and requires both browser jobs in the CI gate.

## Routes

| Route | Page |
|-------|------|
| `/` | Redirects to `/library` when signed in, `/login` otherwise |
| `/login` · `/register` · `/auth/recovery` · `/consent` | Sign-in, owner or invite sign-up, session recovery, OAuth consent for agents |
| `/library` · `/library/:id` | The account’s library tree and Shared with me; `?folder=` opens a folder. New folder uses the current folder or an explicit destination picker |
| `/library/:id/edit` | Opens library settings for the library, or collection settings for a shared collection |
| `/library/:id/history` | Whole-library versions and restore |
| `/library/:id/collaborators` | Members and invites for shared collections |
| `/library/health` | Broken, redirected, duplicate, and stale links |
| `/c/:slug` | Live shared folder or published collection (Board, Gallery, List, Compact). Folder links are unlisted, read-only and revocable |
| `/r/:id` | Bookmark detail with annotations and relations |
| `/graph/:slug` | Relation graph |
| `/search` | Search collections, bookmarks, and annotations |
| `/agents` | Connected agents, keys, and approval policy |
| `/approvals` · `/approvals/:planId` | MCP write approvals |
| `/sync` | Sync center: browsers, conflicts, and trash |
| `/import` | Import a bookmarks file into a folder the user picks in their library |
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

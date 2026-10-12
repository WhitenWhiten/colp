# Web UI architecture

How the COLP Server web UI is put together: CSS layers and file ownership,
tokens, responsive tracks, source layout, and the quality gates. The design
system came from Know-N's frontend (see [`../UPSTREAM.md`](../UPSTREAM.md));
the self-hosted layout and type live in the `edition` layer. Product framing
and interaction rules are in [`PRODUCT.md`](./PRODUCT.md).

## CSS architecture

### Cascade layers (declared once, at the top of `tokens.css`)

Every stylesheet is wrapped in exactly one `@layer` block. The stable layer
order is declared at the top of `tokens.css` — the first stylesheet loaded by
`src/main.tsx`:

```css
@layer tokens, base, components, pages, patterns, utilities, edition, print;
```

Later layers win for normal declarations regardless of specificity. The order
`tokens < base < components < pages < patterns < utilities < edition < print`
encodes who may override whom:

- **components below pages** — a page file may specialise component chrome
  for its own route (`.library-bookmark .domain-mark`). Under the previous
  `pages < components` order those page rules were silently shadowed; the
  page author had no way to win short of `!important`.
- **patterns above pages** — motion, hover/focus feedback and the reveal
  choreography in `polish.css` / `interactions.css` are cross-cutting and
  must look the same on every route, so a page cannot dull them. Anything a
  page legitimately needs to tune (e.g. `.btn:disabled` opacity) belongs in
  `base`, not `patterns`.
- **edition above utilities** — the self-hosted design. Every rule in
  `edition.css` is scoped to `:root[data-edition='self-hosted']` (written in
  `index.html` and set again by `main.tsx`), so it matches a strict subset of
  the base rule it restyles and the base rule stays the shared source that
  upstream changes port into. The edition keeps Know-N's colours and
  shadows; its type-scale tokens are in the same scoped block of
  `tokens.css`, and `edition.css` holds only layout and type rules a token
  cannot express.

`scripts/check-style-drift.mjs` reports every remaining cross-layer overlap
(a declaration that can never win because a covering rule sits in a later
layer). Re-run it and review the diff before changing this order again.

`utilities` is occupied by `utilities.css` (the live spacing helpers
actually applied in production TSX, each mapped to a `--space-*` /
`--hair-*` token); `print` must stay last so print rules beat screen rules.
Unlayered author CSS would beat every layer — keep all rules inside a layer
block.

### File structure, owners and allowed responsibilities

```
src/styles/
├── tokens.css              # tokens layer — design tokens (colors, spacing, typography, shadows, breakpoints); the self-hosted token block is at the end
├── global.css              # base layer — reset, layout shell, buttons, forms, helpers
├── nav.css                 # base layer — topnav chrome (sticky bar, burger drawer, account/tools menus)
├── skeleton.css            # base layer — route-loading Suspense skeletons
├── page-chrome.css         # base layer — page-shell route container, page-head, filter chips, empty states + illustrations
├── overlays.css            # base layer — modal + toast chrome
├── shared-chrome.css       # base layer — cross-site primitives (avatar, view-switch rail, lib-snippet annotation)
├── cards.css               # components layer — popover motion, context-menu rows, collection-card chrome
├── capture.css             # components layer — shared capture result recipe (design-system source copied verbatim by the Known-Extension build)
├── cards-ui.css            # components layer — card UI system (result cards and boards, card body typography, library rows, compact density)
├── data-table.css          # components layer — ops-table primitive (components/DataTable.tsx): library health, sync, write approvals
├── reading.css             # components layer — long-form reading measure used by resource detail
├── search.css              # components layer — ⌘K search palette; the Search page workspace
├── stepper.css             # components layer — numbered-step primitive (components/Stepper.tsx): Extension and Import
├── collection.css          # pages layer — public collection + list/compact streams
├── pages-shared.css        # pages layer — multi-page navigation chrome (breadcrumb, folder trail)
├── page-layouts.css        # pages layer — entry-loaded structure for components that mount on any route (frozen: no new single-declaration margin classes)
├── workbench-chrome.css    # pages layer — collection editor, CreateCollection, and annotation-field chrome mounted outside a single route
├── studio.css              # pages layer — settings dialog and cross-route section heads
├── auth.css                # pages layer — auth chrome the settings dialog also mounts (.auth-card, notices, action rows)
├── library.css             # pages layer — library desk and public-collection rows; shared by pages/Library.tsx and Collection.tsx
├── auth-pages.css          # pages layer — sign-in, register, recovery, consent page chrome; shared by those four pages
├── collab.css              # pages layer — collaborators and the editor's publication block; shared by pages/Collaborators.tsx and the settings sheet
├── not-found.css           # pages layer — 404 / absence stage; shared by NotFound, Collection, Graph, ResourceDetail
├── graph.css               # pages layer — collection graph; route-owned by pages/Graph.tsx
├── sync.css                # pages layer — sync center; route-owned by pages/Sync.tsx
├── write-approvals.css     # pages layer — MCP write approvals; route-owned by pages/WriteApprovals.tsx
├── agents.css              # pages layer — connected agents; route-owned by pages/Agents.tsx
├── extension.css           # pages layer — extension setup; route-owned by pages/Extension.tsx
├── library-health.css      # pages layer — link health table; route-owned by pages/LibraryHealth.tsx
├── collection-history.css  # pages layer — version history; route-owned by pages/CollectionHistory.tsx
├── resource-detail.css     # pages layer — bookmark detail: head, reading column, source aside, relations; route-owned by pages/ResourceDetail.tsx
├── interactions.css        # patterns layer — hover/active/focus micro-interactions, animations
├── polish.css              # patterns layer — motion, density, page-enter transitions
├── utilities.css           # utilities layer — live spacing helpers (production-referenced only)
├── edition.css             # edition layer — self-hosted layout and type, every rule under :root[data-edition='self-hosted']
└── print.css               # print layer — loaded from index.html with media="print"
```

Rules:

1. `tokens.css` is imported explicitly and first from `src/main.tsx`; it must
   never be imported indirectly through another stylesheet.
2. New stylesheet files must be wrapped in exactly one `@layer` block and the
   file → layer owner must be recorded here and in
   `src/styles/css-layers.contract.test.ts`. Shared stylesheets are imported
   from `src/main.tsx`; a stylesheet used by a single lazy route is imported
   from that page module instead (`ROUTE_STYLESHEETS` in the contract test
   lists the owners: Graph, Sync, WriteApprovals, Agents, Extension,
   LibraryHealth, CollectionHistory, and ResourceDetail;
   `SHARED_ROUTE_STYLESHEETS` lists the files several pages share).
   Route stylesheets ship in the route chunk and stay out of the
   render-blocking entry CSS; because the layer order is declared up front
   they still land in their owner layer, sorting after the entry files of that
   layer. `print.css` is linked from `index.html` with `media="print"` so it
   stays out of the JS render-blocking bundle. It repeats the layer-order
   statement so it can parse before `tokens.css` without flipping `print` to
   the lowest layer.
3. Page files (`pages` layer) own page layout and local structure only; they
   must not redefine shared chrome (`.btn`, `.panel`, `.chip`, `.badge`,
   `.pill`, `.search-field`, `.collection-card`). `.auth-card` chrome is
   owned by `auth.css` (pages layer).
4. Component files (`components` layer) own shared UI chrome; patterns
   (`patterns` layer) own cross-component motion.
5. Resolve conflicts by moving rules to the owning file/layer — never by adding
   specificity to out-cascade another owner.

### Design tokens (tokens.css)

All design decisions flow through tokens. Never hardcode values.

**Colour palette:**
- The app is **light-only** (`color-scheme: light`). Do not implement a
  global dark mode.
- `--paper`, `--paper-2` — background layers
- `--surface`, `--surface-raised`, `--surface-sunken` — card/surface hierarchy
- `--ink`, `--ink-2`, `--ink-3`, `--muted`, `--faint` — text hierarchy;
  `--ghost` is decorative only (watermarks, empty-state art)
- `--line`, `--line-strong`, `--line-heavy` — border hierarchy;
  `--line-control` is the 3:1 boundary of a form control
- `--accent`, `--accent-ink`, `--accent-soft` — brand accent
- `--success`, `--danger`, `--warning` (+ `-soft`) — semantic states
- `--domain-mark-a/b/c` — the letter-badge triad for `.domain-mark--a/b/c`
  (cards-ui.css); not a chart palette

**Typography:**
- `--font-sans` — UI text, tools, and forms (Instrument Sans)
- `--font-serif` — Newsreader upstream; the self-hosted edition resolves it
  to the sans stack, so every head is sans at a tool scale
- `--font-mono` — commands, endpoints, and versions (JetBrains Mono,
  bundled so a command looks the same on every OS)
- `--text-3xs` / `--text-2xs` — decorative only (avatar initials, badge dots)
- `--text-xs` through `--text-3xl` — readable type scale; 12px is the
  readable floor

A missing or withdrawn subject (collection, bookmark, graph) uses the 404
stage (`AbsenceStage`) without the 404 digits. In-collection empty sections
keep `.public-collection-empty`.

**Bookmark row vs card:** the library desk and the public collection's
list/compact views share `ResourceList` (`library-bookmark` slots: mark →
title → mid (folder/path + date) → host). The public Board shows result
cards (brand mark + type); the folder card in `FolderEntries` uses the
collection card body.

**Spacing:**
- `--space-0` through `--space-12` — coarse scale (not a strict 4px grid;
  `--space-5` is 1.35rem). Use for page/section rhythm.
- `--hair-15` through `--hair-200` — fine inset/gap (name = rem × 100).
  `--hair-15` is 0.15rem; `--hair-*` rungs are not `--space-*` rungs.
- `utilities.css` is the live helper set only (not a full token grid):
  `.m-0`, `.mt-0` / `.mt-2`, `.mb-4`, `.mb-hair-85`,
  `.gap-1` / `.gap-2` / `.gap-4`, plus `.handle-text` (handle ellipsis
  inside flex rows). A new helper needs a production `className` reference
  (`css-layers.contract.test.ts`).

**Shadows:**
- Elevation ladder — `--shadow-xs` / `--shadow-sm` / `--shadow-md` /
  `--shadow-raised` (interactive hover) / `--shadow-float` (overlays)
- Halos — `--shadow-ring` (default focus), `--shadow-ring-accent`,
  `--shadow-ring-soft`, `--shadow-lift` (avatar/secondary-button hover),
  `--shadow-primary-hover` (primary button hover)
- `elevation.contract.test.ts` keeps numeric `z-index` local (≤ 20), bans
  literal ring/lift shadows outside `tokens.css`, and ratchets the remaining
  literal box-shadows.

**Layout tracks:**
- `--shell-wide` — chrome only (topnav, footer, `.shell-wide`). Cap 96rem.
- `--shell` — reading content (Sync, auth, settings, …). Cap 90rem.
- `--shell-grid` — dense workbench grids (Library desk, `PageShell
  variant="grid"`). Same 96rem cap as chrome; the point is role, not a
  different number.
- `--measure` (38rem) and `--measure-wide` (46rem) — prose and form widths.

### Breakpoints

Documented, not CSS variables — custom properties cannot be used in
`@media`. `breakpoints.contract.test.ts` holds the allowlist.

Content scale (`--bp-*` in the `tokens.css` comment):

- 640px (`--bp-sm`) — phone / small tablet
- 900px (`--bp-md`) — content desktop start (main + rail grids, the public
  collection sidebar)
- 1100px (`--bp-lg`) — large content + **full chrome**

Chrome scale (second track). Do not introduce a third pixel (for example
1060) for topnav / burger / Library.

- 720px (`--bp-chrome-sm`) — `.nav-links` appear; Library two-column sidebar
- 1100px — full search field (`⌘K`); `.nav-burger` hidden (same as `--bp-lg`)

So 768 and 1024 still show burger + compact search; 1280 is complete chrome.
Library is two-column from 720 (768 already has a sidebar), not from 900.

**Container queries:** the two main columns that sit beside a sidebar are
inline-size containers, because their width is not a function of the
viewport: `library-main` (library.css) and `collection-main`
(collection.css — the public collection toolbar spells out its view names
and drops the sort label's tail by the column's width). Viewport tracks
above stay the law for page layout. Do not declare a `container` without a
matching `@container` query; add the container and its first query in the
same change.

**Public collection (`/c/:slug`):** one 76rem board track. From 900px a
collection with folders splits it into the sticky Contents sidebar (14rem,
16rem from 1100) and the main column — toolbar, folder head, then the
layer's Folders and Bookmarks sections; below 900 the same tree opens as a
sheet from the toolbar's Contents button. The toolbar pins under the header
from 640; on phones the folder trail is the pinned row instead. Off-screen
board cards skip layout (`content-visibility: auto`); their placeholder
height must match the real card, or a Back scroll restore lands short.

---

## JavaScript layout

```
src/
├── api/          # Product API clients and transports; types from src/generated
├── auth/         # session bootstrap and AuthContext
├── components/   # shared UI (TopNav, Layout, PageHead, ResourceList, settings, …)
├── generated/    # colp-server-v1.ts, generated from the server's OpenAPI document
├── lib/          # hooks and helpers (data loading, scroll, telemetry, edition)
├── pages/        # route-level pages; larger pages own a folder (library-desk/, collection-editor/, …)
├── styles/       # the stylesheets above and their contract tests
└── test/         # render helpers and test-only fixtures
```

`/library` (`pages/Library.tsx` → `library-desk/LibraryDesk.tsx`) is the
owner's desk; `/c/:slug` (`pages/Collection.tsx`) is the published
collection. Routes are listed in `src/App.tsx`; every page except the `/`
redirect is `lazy()`.

- Function components with hooks; context providers for auth, toast, and
  confirm dialogs.
- Session and CSRF state stay in memory. `localStorage` holds UI
  preferences and unsent drafts; `sessionStorage` holds command-intent IDs,
  scroll positions, and the chunk-reload guard.

---

## Responsive strategy

1. Base styles target phones; media queries add structure for wider tracks.
2. Phones get a bottom tab bar, a burger drawer, sticky toolbars under the
   header, and full-width primary actions; sidebars become sheets.
3. `chrome.responsive.spec.ts` and the `*.responsive.spec.ts` lanes
   (390, 768, 1024, 1280) check the nav cuts, touch targets, and overflow.

---

## Buttons

Solid fills use one language:

- **Primary** (`.btn-primary`): ink fill. Create, Save, Sign in, New collection.
- **Danger** (`.btn-danger`): `--danger` fill for irreversible confirms.
  Sign out is a text action, not a primary fill.
- **Selected chips** (`.filter-btn[aria-pressed='true']`): ink fill, matching
  the primary.
- **Segments** (`.view-switch`): pale rail with a raised capsule.
  Publication visibility uses the same rail.

---

## Development guidelines

### Adding a page
1. Create the component in `src/pages/` and add its route in `App.tsx`.
2. Put page-specific CSS in a route-owned file named after the page,
   imported from that page module only, and pin it in
   `css-layers.contract.test.ts`; multi-page chrome goes in
   `pages-shared.css`.
3. Test on phone, tablet, and desktop widths.

### Adding a component
1. Create it in `src/components/` and style it with existing tokens.
2. Hover/active states go in `interactions.css`.
3. Check keyboard and screen-reader use.

### CSS organisation
1. **Tokens first** — all values come from tokens.css.
2. **Mobile-first** — base styles for phones, media queries for larger.
3. **Component-scoped** — keep related styles together.
4. **Clear naming** — BEM-lite, as actually practised (do not write `__`):
   blocks are hyphenated (`.empty-state`, `.topnav`), elements join with a
   single hyphen (`.empty-state-icon`, `.modal-header`), variants take `--`
   (`.empty-state--compact`, `.modal-panel--lg`), interaction states take
   `is-` (`.is-active`, `.is-closing`), and cross-component chrome stays in
   utility classes (`.btn`, `.btn-sm`, `.meta`).
5. **Layered** — every stylesheet is wrapped in exactly one cascade layer and
   owned by one file (see the layer order and owner table above); never add
   unlayered rules or import tokens indirectly.

### Inline style boundary (L03)

`style={{ ... }}` in TSX is limited to a documented dynamic whitelist,
verified by `scripts/check-inline-styles.mjs` against
`scripts/inline-style-fixtures.json` (run `node --test
scripts/inline-style-contract.test.mjs`):

- **Allowed (dynamic):** coordinates (`top`/`left` from state), percentage
  progress (`width`/`height` from data), CSS custom properties
  (`--progress`, `--reveal-delay`, `--vl-*`, `--library-sidebar-w`, …), view transition names, controlled
  `animationDelay`, data-driven accents and theme swatches.
- **Forbidden (static):** margin/padding/gap/font-size/display/flex/color
  literals and any other static layout value — they belong in the owning
  CSS file (base/patterns/pages/components layer per the owner table).
- **New files:** must not introduce static inline styles; new dynamic
  patterns must be added to the fixture list together with a reason.

**Residual debt:** none. Do not reintroduce static `style={{ ... }}`
layout.

### Type safety gate

`tsconfig.json` runs with `noUncheckedIndexedAccess` for sources and tests:
every `array[i]` / `record[key]` read is `T | undefined` and must be guarded,
defaulted, or proven by a total accessor. Production code must not add `!`
to silence the flag — prefer `?? fallback` or an early return. Tests may
assert `fixture[0]!` where a missing element should fail the assertion
anyway. `npm run typecheck` is the first step of `build`.

### Style quality gate (G02)

`npm run lint` (ESLint) and `npm run lint:css` are the frontend static quality gates. ESLint fails the build on leftover `.only` (`vitest/no-focused-tests`), `react-hooks/rules-of-hooks`, and a jsx-a11y set (`no-aria-hidden-on-focusable`, `tabindex-no-positive`, `iframe-has-title`, `no-access-key`, plus the keyboard-parity trio `click-events-have-key-events` / `no-static-element-interactions` / `interactive-supports-focus`) — not the full `jsx-a11y/recommended` preset, which is too noisy here. The test-file ban on `querySelector('.class')` / `querySelectorAll('.class')` migration is complete: the lint script pins `--max-warnings 0`, so any new warning (including `react-hooks/exhaustive-deps`) fails the build. `lint:css` remains the style ratchet. It runs, in order:

1. `stylelint` — no px `font-size`/`line-height`, no pill-radius
   literals, no same-file duplicate selectors;
2. `scripts/check-style-drift.mjs` — the drift ratchet (below);
3. `scripts/check-inline-styles.mjs` — the L03 inline-style boundary gate
   (fixture-scoped: any `style={{ ... }}` not on the whitelist/debt
   fixture list fails);
4. `scripts/check-dead-classes.mjs` — every class a stylesheet defines must
   be referenced from TSX, and every class TSX uses must be defined (no
   ghost classes).

**The drift ratchet makes the G01 report dimensions blocking for new
debt.** A new non-token `border-radius`, a new literal motion
duration/easing, a new static TSX inline style, or a cross-file duplicate
selector without a declared owner fails the build with `file:line`,
selector and a replacement suggestion (the matching `--radius-*` /
`--duration-*` / `--ease-*` token, or the owning stylesheet). Existing
debt is ratcheted per file+selector+value: counts may only shrink or stay
flat. `--write-baseline` refuses to write a baseline that is larger than
the current one (growing counts or new entries are rejected with an
error). Hardcoded colors stay informational in the residual report — new
`rgb()`/`hsl()` literals are still blocked by the `maxAdhoc.rgbValues`
counter, and `white`/`black` keywords are visible in the report.
`maxAdhoc.hexValues` ratchets hex color literals (`#rgb` / `#rrggbb` /
`#rrggbbaa`) in declaration values; `@media print` blocks and token-definition
lines are excluded. `maxAdhoc.spacing` ratchets off-scale `padding`/`margin`/`gap` lengths:
a literal that matches no `--space-*` / `--hair-*` token counts against the baseline
(on-scale literals are tolerated, but new code should reference the
token).

**Passing ≠ zero debt.** A green `lint:css` only means no *new* drift
since the baseline; grandfathered debt is still listed in the residual
report output and in `scripts/style-drift-baseline.json`
(`residualReport`). Always review the residual report when touching
styles. Wave-0 → current baseline: duplicate selectors 269 → 49,
literal ms 23 → 0, non-token radius drift 57 → 0, hardcoded rgb 146 → 86,
static inline styles 159 → 0 (L03 residual debt cleared).

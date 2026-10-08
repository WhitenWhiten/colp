# Know-N Design System Architecture

## Product Copy Boundary

Know-N is an online bookmark library: saved links, synced browser folders,
collaborative collections, and public knowledge paths. The homepage, footer,
SEO/OG metadata, share pages, and onboarding copy must state that product shape
plainly before any secondary metaphor appears.

Use these terms for user-facing product framing:

- online bookmark library
- bookmarks, saved links, browser folders, sync
- collection, shared collection, collaborator
- knowledge path, reading path, curated path
- board or start page only for the optional `/dashboard` surface

Do not use these terms as product positioning:

- research desk
- your desk on the web
- open your desk
- desk as a synonym for Know-N, the library, or collections

Legacy `desk-*` selectors, localStorage keys, and component names are an
implementation detail of dashboard widgets. They may remain until a planned
compatibility-safe rename, but new visible copy should prefer library,
collection, folder, board, or start page.

## CSS Architecture

### Cascade layers (declared once, at the top of `tokens.css`)

Every stylesheet is wrapped in exactly one `@layer` block. The stable layer
order is declared at the top of `tokens.css` — the first stylesheet loaded by
`src/main.tsx`:

```css
@layer tokens, base, components, pages, patterns, utilities, edition, print;
```

Later layers win for normal declarations regardless of specificity. The order
`tokens < base < components < pages < patterns < utilities < edition < print` encodes
who may override whom:

- **components below pages** — a page file may specialise component chrome
  for its own route (`.explore-density-compact .collection-card-foot`,
  `.library-bookmark .domain-mark`, the fullscreen dashboard `.canvas-shell`
  padding). Under the previous `pages < components` order those page rules
  were silently shadowed (20 documented cases in the drift baseline); the
  page author had no way to win short of `!important`.
- **patterns above pages** — motion, hover/focus feedback and the reveal
  choreography in `polish.css` / `interactions.css` are cross-cutting and
  must look the same on every route, so a page cannot dull them. Anything a
  page legitimately needs to tune (e.g. `.btn:disabled` opacity) belongs in
  `base`, not `patterns`.
- **edition above utilities** — the self-hosted design (COLP Server). Every
  rule in `edition.css` is scoped to `:root[data-edition='self-hosted']`
  (set by `main.tsx` and written into `index.html` by
  `scripts/self-hosted-dist.mjs`), so it matches a strict subset of the base
  rule it restyles: no base rule becomes dead and the cloud UI renders as
  before. The edition keeps Know-N's colours and shadows; its type scale and
  texture tokens are in the same scoped block of `tokens.css`, and
  `edition.css` holds only layout and type rules a token cannot express.

`scripts/check-style-drift.mjs` reports every remaining cross-layer overlap
(a declaration that can never win because a covering rule sits in a later
layer). Re-run it and review the diff before changing this order again.

`utilities` is occupied by `utilities.css` (the live spacing helpers
actually applied in production TSX, each mapped to a `--space-*` /
`--hair-*` token); `print` must stay last so print rules
beat screen rules. Unlayered author CSS would beat every layer — keep all rules
inside a layer block.

### File structure, owners and allowed responsibilities

```
src/styles/
├── tokens.css              # tokens layer — design tokens (colors, spacing, typography, shadows, breakpoints)
├── global.css              # base layer — reset, layout shell, buttons, forms, helpers
├── nav.css                 # base layer — topnav chrome (sticky bar, burger drawer, account/tools menus)
├── skeleton.css            # base layer — route-loading Suspense skeletons
├── page-chrome.css         # base layer — page-shell route container, page-head, filter chips, empty states + illustrations
├── overlays.css            # base layer — modal + toast chrome
├── shared-chrome.css       # base layer — cross-site primitives (avatar, view-switch rail, lib-snippet annotation)
├── cards.css               # components layer — freeform board, canvas geometry, tile base + generic tile chrome, resource cards
├── source-skins.css        # components layer — per-source card skins + tile density container queries
├── capture.css             # components layer — shared capture result recipe (design-system source copied verbatim by the Known-Extension build; entry-loaded from src/main.tsx)
├── cards-ui.css            # components layer — card UI system (collection cards, card body typography, library rows)
├── landing.css             # pages layer — marketing landing (entry CSS: the index route is eager for LCP)
├── explore.css             # pages layer — explore directory
├── collection.css          # pages layer — public collection + list/compact streams
├── profile.css             # pages layer — public profile
├── dashboard.css           # pages layer — board start page + fullscreen
├── graph.css               # pages layer — collection graph
├── sync.css                # pages layer — sync center
├── write-approvals.css     # pages layer — MCP write approvals
├── classification-batch.css # pages layer — ClassificationBatch.tsx review and progress
├── classify.css            # pages layer — classify inbox
├── classification-settings.css # pages layer — owner tag suggestion settings; route-owned by pages/library-desk/CollectionSettingsSheet.tsx
├── pages-shared.css        # pages layer — multi-page navigation chrome (breadcrumb, folder trail)
├── library.css             # pages layer — library desk, link stack, edit collection
├── auth.css                # pages layer — auth / onboarding
├── interactions.css        # patterns layer — hover/active/focus micro-interactions, animations
├── polish.css              # patterns layer — motion, density, page-enter transitions
├── share.css               # pages layer — share / promo pages
├── demos.css               # pages layer — demo pages, funnel charts, import wizard
├── today.css               # pages layer — Today loop; route-owned by pages/Today.tsx
├── collection-history.css  # pages layer — version history; route-owned by pages/CollectionHistory.tsx
├── reader.css              # pages layer — reader article + toolbar; route-owned by pages/Reader.tsx
├── resource-detail.css     # pages layer — bookmark detail: editorial head, reading column, sticky source aside, relations; route-owned by pages/ResourceDetail.tsx
├── path-reader.css         # pages layer — guided path reader; route-owned by pages/PathReader.tsx
├── library-health.css      # pages layer — link health table; route-owned by pages/LibraryHealth.tsx
├── data-export.css         # pages layer — export jobs; route-owned by pages/DataExport.tsx
├── import.css              # pages layer — extension hand-off; route-owned by pages/Import.tsx
├── saved-resources.css     # pages layer — saved-resource rows on the Library reading pane; route-owned by pages/Library.tsx
├── not-found.css           # pages layer — 404 page: editorial head, site search, hairline exit list; route-owned by pages/NotFound.tsx
├── reports.css             # pages layer — News Digest nameplate cards, series masthead, issue archive; shared by pages/Reports.tsx, ReportSeries.tsx, ReportIssue.tsx and the Explore digests rail (SHARED_ROUTE_STYLESHEETS)
├── collab.css              # pages layer — collaboration, update review, notifications
├── studio.css              # pages layer — creator studio, settings, AI organize
├── desk-themes.css         # components layer — desk widget color themes (paper / mist / ink module palettes)
├── widget-*.css            # components layer — one file per desk widget (search, sticky, todo, weather, collection-list, pomodoro, clock, quicklinks, habits, reading, ssh, heatmap, aichat, wordbook): tile chrome + tokens + .desk-* content; imported by pages/Dashboard.tsx in the order pinned by DESK_WIDGET_STYLESHEETS
├── canvas-background.css   # components layer — canvas dot-grid background pattern
├── page-layouts.css        # pages layer — cross-route component layout (.follow-btn, .social-actions masthead cluster, .community-vote) (frozen: no new single-declaration margin classes)
├── utilities.css           # utilities layer — live spacing helpers (production-referenced only)
├── edition.css             # edition layer — self-hosted design, every rule under :root[data-edition='self-hosted']
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
   lists the owners: Profile, Graph, Sync, WriteApprovals, Classify,
   ExtensionPopup, Share, DemoHub, ResourceDetail, the former loops.css
   routes, and the desk files under Dashboard).
   Route stylesheets ship in the route chunk and stay out of the
   render-blocking entry CSS; because the layer order is declared up front
   they still land in their owner layer, sorting after the entry files of that
   layer. `print.css` is linked from `index.html` with `media="print"` so it
   stays out of the JS render-blocking bundle. It repeats the layer-order
   statement so it can parse before `tokens.css` without flipping `print` to
   the lowest layer.
3. Page files (`pages` layer) own page layout and local structure only; they
   must not redefine shared chrome (`.btn`, `.panel`, `.chip`, `.badge`, `.pill`,
   `.read-mark`, `.search-field`, `.collection-card`, `.tile`).
   `.auth-card` chrome is owned by `auth.css` (pages layer). `.tile` is a
   single merged base (geometry + chrome) in `cards.css` (R8-01); it must stay
   before `source-skins.css` so per-source `--source-accent` keeps winning.
4. Component files (`components` layer) own shared UI chrome; patterns
   (`patterns` layer) own cross-component motion.
5. Resolve conflicts by moving rules to the owning file/layer — never by adding
   specificity to out-cascade another owner.

### Design Tokens (tokens.css)
All design decisions flow through tokens. Never hardcode values.

**Color Palette:**
- The app is **light-only** (`color-scheme: light`). Do not implement global
  dark mode. Desk-themes (`.tile-theme-ink` and siblings) are local tile
  palettes on canvas cards, not an application theme.
- `--paper`, `--paper-2` — Background layers
- `--surface`, `--surface-raised`, `--surface-sunken` — Card/surface hierarchy
- `--ink`, `--ink-2`, `--ink-3`, `--muted`, `--faint` — Text hierarchy;
  `--ghost` is decorative only (watermarks, fleurons, empty-state art)
- `--line`, `--line-strong`, `--line-heavy` — Border hierarchy
- `--accent`, `--accent-ink`, `--accent-soft` — Brand accent
- `--success`, `--danger`, `--warning` — Semantic states
- `--source-*` — Live source brand hues; skins assign `--source-accent: var(--source-youtube)` (etc.)
- `--chart-1/2/3` — restrained three-hue triad consumed by `.domain-mark--a/b/c`
  letter badges (cards-ui.css); no live chart surface uses them

**Typography:**
- `--font-sans` — UI text, tools, and forms (Instrument Sans)
- `--font-serif` — Reading and marketing display (Newsreader): Reader body, Share/Explore/Path/resource/Demo Hub/install titles, public Collection titles, Landing italic
- `--text-3xs` / `--text-2xs` — decorative only (avatar initials, badge dots)
- `--text-xs` through `--text-3xl` — readable type scale

Workbench pages (Library, Today, Settings, Search, Classify, Sync) keep sans headings. Do not restyle the whole app to serif.

Public collection titles (`.collection-masthead.page-head--editorial .display`) use the same editorial serif track as Explore / Share / Reader / Path. A missing or withdrawn subject uses the 404 stage (`AbsenceStage`: serif italic title, corner frame, text exits) without the 404 digits. In-collection empty sections keep `.public-collection-empty`.

**Bookmark row vs discovery card:** Library compact and public Collection list/compact share `ResourceList` (`library-bookmark` slots: mark → title → mid (folder/path + date) → host). Explore / Profile `CollectionCard` is a raised discovery card — do not flatten it into a bookmark row. Public Board stays brand mark + type, not a letter-square grid.

**Spacing:**
- `--space-0` through `--space-12` — coarse scale (not a strict 4px grid;
  `--space-5` is 1.35rem). Use for page/section rhythm.
- `--hair-15` through `--hair-200` — fine inset/gap (name = rem × 100).
  `--hair-15` is 0.15rem; `--hair-*` rungs are not `--space-*` rungs.
- `utilities.css` is the live helper set only (not a full token grid):
  `.m-0`, `.mt-0` / `.mt-2` / `.mt-3`, `.mb-4`,
  `.gap-1` / `.gap-2` / `.gap-4`, `.mt-hair-55` / `.mt-hair-65` /
  `.mt-hair-85` / `.mt-hair-125`, `.mb-hair-45` /
  `.mb-hair-85`, `.gap-hair-45`, plus `.handle-text`
  (handle ellipsis inside flex rows). A new helper needs a
  production `className` reference (`css-layers.contract.test.ts`).

**Shadows:**
- Elevation ladder — `--shadow-xs` / `--shadow-sm` / `--shadow-md` /
  `--shadow-raised` (interactive hover) / `--shadow-float` (overlays)
- Halos — `--shadow-ring` (default focus), `--shadow-ring-accent`,
  `--shadow-ring-soft`, `--shadow-lift` (avatar/secondary-button hover),
  `--shadow-primary-hover` (primary button hover)
- Anchored popovers — `--shadow-popover`, `--shadow-popover-accent`;
  `--inset-highlight` is the top-edge lit surface for raised layers

**Layout:**
- `--shell-wide` — chrome only (topnav, footer, `.shell-wide` utility). Cap 96rem.
- `--shell` — reading / marketing content (Landing, Share, Sync, Profile, auth, etc.). Cap 90rem.
- `--shell-grid` — dense workbench / discovery grids (Explore, Library desk/layout, `PageShell variant="grid"`). Same 96rem cap as chrome; the point is role, not a different number. Landing `.collection-grid.landing-collection-grid` stays `--shell`. Do not add a default-density 4th Explore column.

**Breakpoints (documented, not CSS variables — custom properties cannot
be used in `@media`):**

Content scale (`--bp-*` in `tokens.css`):

- 640px (`--bp-sm`) — phone / small tablet
- 900px (`--bp-md`) — content desktop start
- 1100px (`--bp-lg`) — large content + **full chrome**
- 1400px (`--bp-xl`) — documented wide shell; Explore stays 3 columns

Chrome scale (second track). Do not introduce a third pixel (for example
1060) for topnav / burger / Library.

- 720px (`--bp-chrome-sm`) — `.nav-links` appear; Library two-column sidebar
- 1100px — full search field (`⌘K`); `.nav-burger` hidden (same as `--bp-lg`)

So 768 and 1024 still show burger + compact search; 1280 is complete chrome.
Library is two-column from 720 (768 already has a sidebar), not from 900.

**Explore `.collection-grid` (default density):** `<640` 1 column, `640–899`
2 columns, `≥900` (including 1024 and 1920) **3 columns**. Compact density
may use 4 columns at 1100; do not add a default-density 4-column step.

**Container queries (CQ-01):** the desk `.tile` is the named size container
(`container: tile / size`, cards.css); tile-internal density decisions
(compact action hiding at `max-width: 20rem`, summary/title type at
`min-width: 20rem`, source-skin layouts) query the tile's own box instead of
a viewport proxy. Two main columns that sit beside a sidebar are inline-size
containers, because their width is not a function of the viewport:
`library-main` (library.css) and `collection-main` (collection.css — the
public collection toolbar spells out its view names and drops the sort
label's tail by the column's width). Viewport tracks above stay the law for
page layout. Do not declare a `container` without a matching `@container`
query — the `.collection-card` inline-size pilot was removed for exactly
that reason; add the container and its first query in the same change.

**Landing / Share hero:** single column below 900px, two columns from 900.
Share mid-page three-column beats share the 900px hero cut.

**Public collection (`/c/:slug`):** one 76rem board track. From 900px a
collection with folders splits it into the sticky Contents sidebar (14rem,
16rem from 1100) and the main column — toolbar, folder head, then the
layer's Folders and Bookmarks sections; below 900 the same tree opens as a
sheet from the toolbar's Contents button. The toolbar pins under the header
from 640; on phones the folder trail is the pinned row instead.

**Dashboard:** `<900` single-column interactive stack of the same modules;
`≥900` interactive canvas. Toys (weather, pomodoro, sticky, SSH, …) stay in
the add-module catalog, not on the first-run board.

---

## JavaScript Architecture

### File Structure
```
src/
├── components/             # Reusable UI components
│   ├── widgets/           # Dashboard widget components
│   └── *.tsx              # Core components (TopNav, Footer, etc.)
├── pages/                  # Route-level page components
├── types/                  # Product-safe catalog types (Resource, Collection, SourceType)
├── data/                   # Mock data and type definitions
├── lib/                    # Utility functions and helpers
├── auth/                   # Authentication context
└── styles/                 # CSS files
```

Product `/library` (`pages/Library.tsx` → `library-desk/LibraryDesk.tsx`) is the live
collection desk. Demo `/demo/library` (`pages/LegacyLibrary.tsx`) is the
leftover seed-bookmark stack with in-row notes. They are not the same page.

### Component Patterns
1. **Functional components** with hooks
2. **Context providers** for auth and toast
3. **Lazy loading** for route-level components
4. **TypeScript** for all components

### State Management
- React Context for global state (auth)
- Desk module palettes (Paper / Mist / Ink) are `.tile-theme-*` on canvas cards, not an application theme
- localStorage for persistence (preferences, layout)
- Component state for local UI state

---

## Responsive Design Strategy

### Breakpoints
- **Mobile (< 640px):** Single column, simplified navigation, hidden complex UI
- **Tablet (640–899px):** Two-column Explore, stacked settings; Library sidebar already on from 720; Dashboard is a single-column interactive module stack
- **Desktop (900px+):** Full content layout (3-column Explore, two-column marketing heroes). Full topnav chrome waits until 1100px

### Mobile-First Approach
1. Base styles target mobile
2. Media queries add complexity for larger screens
3. Complex UI (canvas boards) becomes a stacked module list below 900px; desktop keeps the freeform canvas

### Key Patterns
- Sticky toolbars on mobile (`position: sticky; top: var(--header-h)`)
- Collapsible sidebars (`display: none` on mobile)
- Full-width CTAs on mobile
- Simplified navigation (hamburger menu)

---

## Color Token Usage Guide

### When to Use Each Token
- **Surfaces:** `--paper` (page bg), `--surface` (cards), `--surface-raised` (elevated)
- **Text:** `--ink` (primary), `--ink-2` (secondary), `--ink-3` (tertiary), `--muted` (chrome), `--faint` (whisper)
- **Borders:** `--line` (subtle), `--line-strong` (default), `--line-heavy` (emphasis). `--edge-fixed` is a hairline that must not follow a tile's local ink flip (book covers, theme swatches) — never substitute `--ink` or `--line`.
- **Accent:** `--accent` (brand), `--accent-soft` (backgrounds)
- **Source skins:** `--source-*` via `--source-accent: var(--source-*)`. Darker text / wash chips hang as local `--source-ink` / `--source-soft` on the owning `.tile-*`. Brand-illustration petals and marks (Figma, SO bars, album fills) stay as local tables on the mark rule — do not dump them into `tokens.css`.
- **Sticky note:** `--sticky-paper` (tile wash) and `--sticky-mark` (desk glyph)
- **Domain marks:** `--chart-1/2/3` (the `.domain-mark--a/b/c` letter-badge
  triad in cards-ui.css; desk themes re-scope them — despite the prefix,
  no chart consumes them, so do not reach for them as a chart palette)

### Adding New Colors
1. Add to `:root` in tokens.css
2. Use semantic naming (e.g., `--info`, `--warning`)
3. Never hardcode color values in component CSS

### Buttons
Solid fills use one language:

- **Primary** (`.btn-primary`): ink fill. Create, Save, Sign in, New collection, Landing and Share heroes.
- **Danger** (`.btn-danger`): `--danger` fill for irreversible confirms. Logout is a warning-colored text action, not a primary fill.
- **Selected chips** (`.filter-btn[aria-pressed='true']`): ink fill, matching the in-app primary.
- **Segments** (`.view-switch`): pale rail with a raised capsule. Publication visibility uses the same rail.

---

## Development Guidelines

### Adding New Pages
1. Create component in `src/pages/`
2. Add route in `App.tsx`
3. Add page-specific CSS in a route-owned file named after the page
   (`reader.css`, `today.css`, `data-export.css`, `resource-detail.css`, …)
   imported from that page module only, and pin it in
   `css-layers.contract.test.ts`; multi-page chrome
   goes in `pages-shared.css`, entry-loaded product files stay as they are
   (`collab.css`, `studio.css`, `library.css`, `auth.css`, `landing.css`,
   `explore.css`, `collection.css`)
4. Test on mobile, tablet, desktop

### Adding New Components
1. Create in `src/components/`
2. Use existing tokens for styling
3. Add hover/active states in interactions.css
4. Test accessibility (keyboard nav, screen readers)

### CSS Organization
1. **Tokens first** — All values come from tokens.css
2. **Mobile-first** — Base styles for mobile, media queries for larger
3. **Component-scoped** — Keep related styles together
4. **Clear naming** — BEM-lite, as actually practiced (do not write `__`):
   blocks are hyphenated (`.empty-state`, `.topnav`), elements join with a
   single hyphen (`.empty-state-icon`, `.modal-header`), variants take `--`
   (`.empty-state--compact`, `.modal-panel--lg`), interaction states take
   `is-` (`.is-active`, `.is-closing`), and cross-component chrome stays in
   utility classes (`.btn`, `.btn-sm`, `.meta`).
5. **Layered** — every stylesheet is wrapped in exactly one cascade layer and
   owned by one file (see layer order and owner table above); never add
   unlayered rules or import tokens indirectly.

### Inline Style Boundary (L03)

`style={{ ... }}` in TSX is limited to a documented dynamic whitelist,
verified by `scripts/check-inline-styles.mjs` against
`scripts/inline-style-fixtures.json` (run `node --test
scripts/inline-style-contract.test.mjs`):

- **Allowed (dynamic):** coordinates (`top`/`left` from state), percentage
  progress (`width`/`height` from data), CSS custom properties
  (`--swatch`, `--progress`, `--reveal-delay`, `--vl-*`, `--canvas-bg-*`,
  `--x`/`--y`/`--w`/`--h`, …), view transition names, controlled
  `animationDelay`, data-driven accents and theme swatches.
- **Forbidden (static):** margin/padding/gap/font-size/display/flex/color
  literals and any other static layout value — they belong in the owning
  CSS file (base/patterns/pages/components layer per the owner table).
- **New files:** must not introduce static inline styles; new dynamic
  patterns must be added to the fixture list together with a reason.

**Residual debt:** none. The historical 21 static occurrences in
`LibraryEdit`, `ExtensionPopup`, `AiOrganize`, and `AiChat` were moved to
`page-layouts.css`. Login had already been cleaned. Do not reintroduce
static `style={{ ... }}` layout.

### Type Safety Gate

`tsconfig.json` runs with `noUncheckedIndexedAccess` for sources and tests:
every `array[i]` / `record[key]` read is `T | undefined` and must be guarded,
defaulted, or proven by a total accessor. Production code must not add `!`
to silence the flag — prefer `?? fallback`, an early return, or a named
default export (see `DEFAULT_CANVAS_FIT`). Tests may assert `fixture[0]!`
where a missing element should fail the assertion anyway. `npm run typecheck`
is the first step of `build`.

### Style Quality Gate (G02)

`npm run lint` (ESLint) and `npm run lint:css` are the frontend static quality gates. ESLint fails the build on leftover `.only` (`vitest/no-focused-tests`), `react-hooks/rules-of-hooks`, and a jsx-a11y set (`no-aria-hidden-on-focusable`, `tabindex-no-positive`, `iframe-has-title`, `no-access-key`, plus the keyboard-parity trio `click-events-have-key-events` / `no-static-element-interactions` / `interactive-supports-focus`) — not the full `jsx-a11y/recommended` preset, which is too noisy here. The test-file ban on `querySelector('.class')` / `querySelectorAll('.class')` migration is complete: the lint script pins `--max-warnings 0`, so any new warning (including `react-hooks/exhaustive-deps`) fails the build. `lint:css` remains the style ratchet. It runs, in order:

1. `stylelint` — no px `font-size`/`line-height`, no pill-radius
   literals, no same-file duplicate selectors;
2. `scripts/check-style-drift.mjs` — the drift ratchet (below);
3. `scripts/check-inline-styles.mjs` — the L03 inline-style boundary gate
   (fixture-scoped: any `style={{ ... }}` not on the whitelist/debt
   fixture list fails).

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

---

## Current State Summary

### Completed Optimizations
- ✅ Token system (colors, spacing, typography, shadows)
- ✅ Responsive breakpoints (mobile/tablet/desktop)
- ✅ Mobile navigation (hamburger menu, simplified topnav)
- ✅ Page-specific responsive styles
- ✅ Interactive states (hover, active, focus)
- ✅ Animation system (transitions, keyframes)
- ✅ Canvas tile themes (paper / ink / mist)

### Known Issues (Fixed)
- ✅ Horizontal overflow on all pages
- ✅ TopNav too many elements on mobile
- ✅ Library filter bar not sticky on mobile
- ✅ Dashboard empty on mobile (now shows friendly message)

### Next Steps for Production

Nearly all product surfaces call the Product API — the per-capability
source of truth is `src/api/featureFlags.ts` (only `mfa` and the vestigial
`graph` flag remain `false`). See the live/mock
inventory in
`docs/audits/known-frontend/2026-08-20-mock-vs-live/summary.md` (repo
root). Remaining work:

1. Wire the remaining demo shells (AI chat, extension capture popup) and
   the Dashboard canvas fragments (localStorage layout, reading queue,
   pinned paths, most desk widgets) as their APIs land. (Classify, AI
   organize, version history, link health, and export jobs are live;
   onboarding is wired: step 2 follows popular collections via Explore +
   collection follow; extension setup happens inside the extension
   itself.)
2. Replace the fake fragments on otherwise-live pages (collection
   follower count, Explore Popular ordering, Profile Activity tab,
   Collaborators recent activity).
3. Add analytics and monitoring.
4. Performance optimization (code splitting, lazy loading).

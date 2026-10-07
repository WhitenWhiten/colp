import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { RootErrorBoundary } from './components/RootErrorBoundary'
import { installClientTelemetry, reportClientError } from './lib/clientTelemetry'
import { isChunkLoadError, reloadOnce } from './lib/lazyWithRetry'

/*
 * CSS Architecture — explicit cascade layers (order declared in tokens.css):
 *
 *   tokens < base < components < pages < patterns < utilities < print
 *
 * Components sit below pages so a route file can specialise component chrome;
 * patterns (motion / hover feedback) sit above pages so they read the same on
 * every route. The order is declared once, at the top of tokens.css (the
 * first layered stylesheet); see ARCHITECTURE.md for the rationale.
 * Latin @font-face CSS from @fontsource-variable loads first, unlayered, so
 * unicode-range files ship with the app instead of blocking on Google Fonts.
 * Each stylesheet below is wrapped in exactly one `@layer` block; file → layer
 * owners are recorded in ARCHITECTURE.md. Import order within main.tsx must
 * stay stable — it defines source order inside each layer.
 *
 *   tokens.css            → tokens layer: design tokens (colors, spacing, …)
 *   global.css            → base layer: reset, shell, buttons, forms, helpers
 *   nav.css               → base: topnav bar, burger drawer, account/tools menus
 *   skeleton.css          → base: route-loading Suspense skeletons
 *   page-chrome.css       → base: page-shell, page-head, filter chips, empty states
 *   overlays.css          → base: modal + toast chrome
 *   shared-chrome.css     → base: cross-site primitives (avatar, view-switch, lib-snippet)
 *   cards.css             → components: board, canvas tiles, tile base + generic tile chrome, resource cards
 *   source-skins.css      → components: per-source card skins + tile density container queries
 *   capture.css           → components: shared capture result recipe (design-system source
 *                           copied verbatim by the extension build; entry-loaded so the
 *                           web app and the extension share one layered source)
 *   landing.css           → pages: marketing landing (stays in the entry: the index route is
 *                           imported eagerly for LCP, so a route chunk would not remove it)
 *   explore.css           → pages: explore directory
 *   collection.css        → pages: public collection + list/compact streams
 *   pages-shared.css      → pages: breadcrumb + folder trail
 *   workbench-chrome.css  → pages: cross-route workbench chrome consumed by
 *                           globally mounted/shared components — tree rows,
 *                           edit-page/edit-workbench grids, toggle switches,
 *                           the shared NodeAnnotationFields blocks
 *                           (Settings dialog, collection editor, demo edit)
 *   auth.css              → pages: .auth-card primitive + the Settings dialog's
 *                           account-security sections (.auth-notice/.auth-alert*,
 *                           .auth-action-row/.auth-cta-stack, .security-*)
 *   polish.css            → patterns: motion, density, page-enter transitions
 *   search.css            → components: ⌘K search palette; pages: search product page
 *   studio.css            → pages: creator studio, settings, AI organize
 *   cards-ui.css          → components: card UI system (collection cards, body typography, library rows)
 *   page-layouts.css      → pages: page layout rules (reserved for L01–L03)
 *   interactions.css      → patterns: hover/active/focus micro-interactions
 *   utilities.css         → utilities: spacing helpers mapped to --space-* / --hair-*
 *
 * Route-owned stylesheets are imported by their lazy page module instead, so
 * they ship in that route's chunk and stay out of the render-blocking entry
 * CSS. Because layers are declared up front, a late stylesheet still lands in
 * its owner layer; it only sorts after the entry files of the same layer, and
 * the css-layers contract pins every owner:
 *
 *   profile.css           → pages/Profile.tsx
 *   graph.css             → pages/Graph.tsx
 *   sync.css              → pages/Sync.tsx
 *   write-approvals.css   → pages/WriteApprovals.tsx
 *   classify.css          → pages/Classify.tsx
 *   share.css             → pages/Share.tsx, Collection.tsx, ReportSeries.tsx,
 *                           ReportIssue.tsx
 *   demos.css             → pages/DemoHub.tsx
 *   reader.css            → pages/Reader.tsx
 *   resource-detail.css   → pages/ResourceDetail.tsx
 *   path-reader.css       → pages/PathReader.tsx
 *   today.css             → pages/Today.tsx
 *   library-health.css    → pages/LibraryHealth.tsx
 *   data-export.css       → pages/DataExport.tsx
 *   collection-history.css→ pages/CollectionHistory.tsx
 *   import.css            → pages/Import.tsx
 *   saved-resources.css   → pages/Library.tsx
 *                           (the former shared loops.css; cross-route primitives
 *                           such as .p0-progress stay in studio.css)
 *   dashboard.css, desk-themes.css, dashboard-desk.css,
 *   widget-*.css (one chapter per desk widget), canvas-background.css
 *                         → pages/Dashboard.tsx (demo desk only)
 *
 * Shared route stylesheets ship in a single lazy CSS chunk imported by
 * several page modules (css-layers.contract.test.ts pins the list):
 *
 *   extension.css         → Extension.tsx, ExtensionPopup.tsx
 *   reports.css           → Reports/ReportSeries/ReportIssue/Explore
 *   moderation.css        → ModerationReports/ModerationAppeals and the
 *                           admin ModerationCases/ModerationAppeals pages
 *   library.css           → Library.tsx, LegacyLibrary.tsx, Collection.tsx,
 *                           DigestManage.tsx, Classify.tsx
 *                           (library desk + demo stack + public-collection
 *                           resource rows + digest attach picker — the
 *                           .library-* and .lib-* domain)
 *   auth-pages.css        → the seven auth routes (Login … Onboarding)
 *   collab.css            → Collaborators.tsx, Notifications.tsx,
 *                           CollectionSettingsSheet.tsx, DigestManage.tsx
 *                           (the .collab-*, .notif-* and .publication-*
 *                           families)
 *
 * Print CSS is loaded from index.html with media="print" (not imported here)
 * so it stays out of the JS render-blocking bundle while remaining in the
 * declared `print` cascade layer.
 */
import '@fontsource-variable/instrument-sans/index.css'
import '@fontsource-variable/instrument-sans/wght-italic.css'
import '@fontsource-variable/newsreader/opsz.css'
import '@fontsource-variable/newsreader/opsz-italic.css'
import './styles/tokens.css'
import './styles/global.css'
import './styles/nav.css'
import './styles/skeleton.css'
import './styles/page-chrome.css'
import './styles/overlays.css'
import './styles/shared-chrome.css'
import './styles/cards.css'
import './styles/source-skins.css'
import './styles/capture.css'
import './styles/landing.css'
import './styles/explore.css'
import './styles/collection.css'
import './styles/pages-shared.css'
import './styles/workbench-chrome.css'
import './styles/auth.css'
import './styles/polish.css'
import './styles/search.css'
import './styles/studio.css'
import './styles/cards-ui.css'
import './styles/data-table.css'
import './styles/stepper.css'
import './styles/reading.css'
import './styles/page-layouts.css'
import './styles/interactions.css'
import './styles/utilities.css'

// R15-13: errors and Web Vitals to /api/v1/client-events (production only).
installClientTelemetry()

/* R15-19: a failed preload (a route's JS or CSS dependency) would otherwise
   throw inside the import; reload once instead so the new request can
   succeed. lazyWithRetry guards route imports the same way. */
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault()
  reloadOnce('preload')
})

function reportRenderError(error: unknown) {
  reportClientError(isChunkLoadError(error) ? 'chunk_load_error' : 'render_error', error)
}

createRoot(document.getElementById('root')!, {
  onCaughtError: reportRenderError,
  onUncaughtError: reportRenderError,
}).render(
  <StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </StrictMode>,
)

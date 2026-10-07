## Design Context

### Users
Researchers, designers, engineers, teams, and lifelong learners who save web links, sync browser bookmarks, organize collections, collaborate on shared folders, and follow public knowledge paths.

### Product positioning boundary
Know-N is an online bookmark library. Public-facing copy must make that clear before introducing any secondary workspace or dashboard metaphors.

Allowed positioning language:
- online bookmark library
- saved links, browser bookmarks, synced folders
- collections, shared collections, collaborators
- knowledge paths, reading paths, curated public paths
- start page or board only for the optional `/dashboard` surface

Avoid as primary positioning language:
- research desk
- your desk on the web
- open your desk
- desk as a synonym for the product, homepage, library, or collection

`desk-*` CSS class names, local storage keys, and legacy widget internals may remain until a compatibility-safe rename is scheduled, but visible copy should say library, collection, board, folder, or start page according to the actual feature.

### Brand Personality
Editorial, precise, calm — confident without shouting. Feels like a well-set research journal meeting a modern tool.

### Aesthetic Direction
Monochrome editorial (cool gray-white paper, ink typography). The product is light-only: cool slate tint, restrained accent, and paper surfaces. Do not add a global dark theme. Board tiles may use local desk-theme palettes (`.tile-theme-ink` and siblings); those are canvas-card skins, not application dark mode. No neon SaaS glow, no purple-gradient AI clichés, no heavy glassmorphism. Premium through typography, spacing rhythm, hairline borders, and deliberate density.

### Design Principles
1. **Scan first** — metadata, counts, and filters stay visible; primary content is one glance away.
2. **Editorial hierarchy** — weight and scale do the work; decoration is optional.
3. **Quiet surfaces, sharp actions** — most UI is paper; primary actions are ink blocks.
4. **Tool, not theater** — motion confirms state, never distracts from reading.
5. **One system everywhere** — same chips, badges, view-switches, and meta patterns across pages.

### Serif / sans display split
**Public / consumption surfaces use serif display** (Newsreader — `.page-head--editorial` on PageHead, or `.reading-*` heads): Today, Explore, Feed, Notifications, Collection, Resource, Reader, PathReader, Profile, Digests, Share, Trust.

**Owner / operations surfaces keep sans display** (Instrument Sans — the `.page-head` default): Library, Editor, CreateCollection, Import, Sync, Classify, Approvals, Health, Settings, Auth — and Search, which operates on your library.

**Widgets: content may be serif; chrome is sans.** On the board, only content-type copy may use Newsreader — the wordbook headword and the sticky-note body. Widget chrome, titles, inputs, and buttons stay Instrument Sans, matching the owner surface the board lives on. A todo title must not change family when it becomes an input. Today’s complete-toggle is a button, so it stays sans.

### Switch semantics
**View modes are tabs, filters are rails.** A control that swaps the whole view or content mode (Profile vs Journal, issue vs series) uses `TabList` (`role="tablist"` / `role="tab"` / `aria-selected` / `role="tabpanel"`). A control that narrows or re-sorts the same list (visibility, format, queue, topic) uses `FilterRail` (`role="radiogroup"` / `role="radio"` / `aria-checked`). Never mix the two on the same page for the same job — the Profile page's "Display" switch is the canonical view-mode tablist.

### Settings save model
**Preferences save on change; forms save on commit.** A single-value control (toggle, select, checkbox) applies immediately — no Save button, and the control's own status line confirms it (the bookmark-preferences section is canonical). A multi-field form — anything with validation, credentials, or a destructive edge — keeps an explicit Save button and the W-15 leave guard (profile, privacy filters, favicon provider). Never put a Save button on a lone toggle, and never let a multi-field form commit on change. The model is deliberately mixed; the split rule, not the count of buttons, is what stays uniform. (D-35)

### Toast vs inline status
**Toast is the one global slot; inline status stays on the control.** `useToast` / `success` / `error` in `AppToast.tsx` is cross-cutting, brief, and optionally undoable — never stack, never park forever (durations already in AppToast). Use it for completed actions whose result is not already visible in the same control (saved, signed out, deleted with Undo) and for failures that happened off-screen or after the control that started them is gone.

**Inline `role="status"` / `role="alert"` / `.field-error` are local** to the form, list, or widget: field validation, request-in-flight ("Loading more…"), "Copied public link" next to the copy button, persistent page/section state (`RouteState`, `EmptyState`, banners), and anything the user must still see after a toast would have auto-dismissed.

**Do not toast a field error. Do not duplicate the same success as both a toast and a visible inline status.** Hidden live regions next to a control (`LoadMoreButton`) are inline, not toasts. Toast: Classify skip/accept, TopNav sign-out, Library delete with Undo, Login server failures (wrong password, rejected code, OAuth/auth callback) so the card does not resize and the copy auto-dismisses. Inline: Login `.field-error`, Feed "Copied public link", `LoadMoreButton` status span, auth success regions, `SavedResourceButton`.

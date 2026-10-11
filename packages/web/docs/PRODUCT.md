## Design context

### Users
One person, or a small team, running their own COLP Server: they keep bookmark collections on it, sync browser folders through the extension, publish some collections at `/c/:slug`, share others with collaborators, and let agents read or propose changes through MCP. Visitors to a published collection are the second audience; they never sign in.

### Positioning
A self-hosted COLP bookmark server. Visible copy names it **COLP Server** (`productName()` in `src/lib/edition.ts`) and says library, collection, folder, and bookmark. "powered by Know-N" in the footer and on About is the only upstream brand line; the browser extension keeps its own name.

### Brand personality
Precise, calm, quiet: a tool the owner opens to get something done, not a product that sells itself.

### Aesthetic direction
Know-N's palette, lines, and shadows, unchanged (cool gray-white paper, ink type, a restrained slate accent). The product is light-only; do not add a global dark theme. The self-hosted edition changes layout and type only: sans headings at a tool scale (`--font-serif` resolves to the sans stack), sentence-case labels instead of tracked capitals, a plain 404. Know-N's paper grain and the soft hero wash behind the sign-in card stay. Premium through typography, spacing rhythm, hairline borders, and deliberate density; no neon glow, gradients, or glassmorphism.

### Design principles
1. **Scan first** — metadata, counts, and filters stay visible; primary content is one glance away.
2. **Clear hierarchy** — weight and scale do the work; decoration is optional.
3. **Quiet surfaces, sharp actions** — most UI is paper; primary actions are ink blocks.
4. **Tool, not theater** — motion confirms state, never distracts from reading.
5. **One system everywhere** — same chips, badges, view switches, and meta patterns across pages.

### Switch semantics
**Filters are rails.** A control that narrows, re-sorts, or re-lays out the same content (link health scope, the collection and desk view modes, the graph's relation type, visibility, a collaborator's role) uses `FilterRail` (`role="radiogroup"` / `role="radio"` / `aria-checked`). A control that swapped to different content would be a tablist; no page needs one today.

### Settings save model
**Preferences save on change; forms save on commit.** A single-value control (toggle, select, checkbox) applies immediately, with no Save button; the control's own status line confirms it (the Bookmarks section is canonical). A multi-field form (profile, password, anything with validation or a destructive edge) keeps an explicit Save button and the leave guard. Never put a Save button on a lone toggle, and never let a multi-field form commit on change.

### Toast vs inline status
**Toast is the one global slot; inline status stays on the control.** `useToast` in `AppToast.tsx` is cross-cutting, brief, and optionally undoable: never stack, never park forever. Use it for completed actions whose result is not already visible in the same control (saved, signed out, deleted with Undo, an approval decided) and for failures that happened after the control that started them is gone.

**Inline `role="status"` / `role="alert"` / `.field-error` are local** to the form, list, or section: field validation, request-in-flight ("Loading more…"), persistent page or section state (`RouteState`, `EmptyState`, banners), and anything the user must still see after a toast would have dismissed.

**Do not toast a field error, and do not show the same success as both a toast and an inline status.** Sign-in failures are inline: one `role="alert"` under the form, the username kept and the password refocused (`e2e/login-server-error.spec.ts`).

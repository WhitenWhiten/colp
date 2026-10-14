# Extension UI design

The popup and the options pages follow one design system. It shares tokens, icons and button
recipes with the Know-N web app and stays quieter than the web: one surface, small ranked actions,
and status only when it means something.

Shared primitives live in `chrome.css` under "Design kit". Page shells live in `popup.css` and
`options.css`. Compose what exists. If a screen needs something the kit doesn't have, add it to
the kit (with a note here) rather than writing a one-off rule next to the feature.

## Principles

1. **One grammar per kind of thing.** A setting is a row (text left, control right). A list is
   rows inside one white card. A choice between whole modes is a pair of choice cards. A
   collapsible part uses `.disclosure`. Don't invent a fifth variant.
2. **Surfaces.** The page background is `--paper`. Content sits in white cards (`--surface-raised`,
   `--line-strong` border, `--radius-lg`, `--shadow-xs`). Never put a card inside a card. No blue
   or accent fills on surfaces. Use neutral greys; blue appears only as small marks.
3. **Controls size to their content.** Selects use `.select-quiet` (8–18rem). Buttons stay at their
   label width. The only full-width button is the sign-in form's submit.
4. **One primary action per view.** Primary is ink (`.btn-primary`), secondary is outlined,
   everything else is ghost. Destructive confirmations use `.btn-danger` only inside the dialog
   that confirms them.
5. **Status is quiet.** At most one `.badge` per row, neutral unless something is wrong. Success
   needs no badge. Don't repeat a state that the sidebar or page head already shows.
6. **User language.** No percentages, sample sizes, sequence numbers, IDs, time zones, server URLs
   or raw error codes outside Help & diagnostics. Never interpolate an error code into a sentence.
   Map known codes to copy and give unknown ones a generic sentence plus "Copy details". Use
   sentence case, and no italics or all-caps labels.
7. **Transient UI is styled too.** Build dialogs with `createDialog()` (`src/dialog.ts`). Every
   empty, loading and error state uses the kit (`.empty`, `.inline-alert`), never bare text.

## Type and spacing

| Role | Size | Weight | Colour |
|---|---|---|---|
| Page title (h1) | `--text-2xl` | semibold, `--tracking-display` | `--ink` |
| Page lede | `--text-sm` | regular | `--muted` |
| Group title (h2) | `--text-md` | semibold | `--ink` |
| Row title / list title | `--text-sm` | medium | `--ink` |
| Row hint / meta | `--text-xs` | regular | `--muted` |
| Popup page title | `--text-md` | semibold | `--ink` |

Spacing uses `--space-*` and `--hair-*` tokens only. Groups are `--space-6` apart, and rows have
`--hair-85` / `--space-4` padding.

## Kit reference (`chrome.css`)

| Class | Use |
|---|---|
| `.field-quiet` | Filled text input or textarea (popup fields, settings forms). Textareas grow with content. |
| `.tag-input` + `.chip` + `.chip-remove` | Tag entry: chips inline with a text input, inside `.field-quiet`. |
| `.chip--suggest` | Dashed suggestion chip (AI folder or tag). Click accepts it. |
| `.badge[data-tone]` | Row status. Tones: `danger`, `warning`, `success`; neutral by default. |
| `.inline-alert[data-tone]` | Notice with a coloured 2px rule and icon on a neutral fill, plus an optional ghost action. Goes at the top of its page or group. |
| `.toggle[role=switch]` | Boolean setting (the web's `.toggle`). Use `aria-checked`. Replaces checkboxes in settings. |
| `.select-quiet` | Auto-width select on a settings row. |
| `.view-switch` / `--compact` | Segmented control (tabs inside a page, Top/Bottom). |
| `.disclosure` | The only expander: a chevron that turns down. |
| `.set-group` > `.set-group-head` + `.set-card` > `.set-row` | Settings: group title on paper, rows in one card. `.set-row-text` holds `.set-row-title` and `.set-row-hint`; `.set-row-control` sits at the right. |
| `.set-row--stack` | Control below the text (choice cards, text areas). |
| `.set-sub` | Dependent option indented under its parent row. |
| `.set-row-value`, `.set-dot` | Read-only value with an optional state dot (Allowed / Off). |
| `.choice-pair` > `.choice` | Mutually exclusive modes with an optional `.choice-art` illustration. Selection is an ink ring. |
| `.list-card` > `.list-row` | Lists (history, bookmarks, credits, tabs): favicon tile, `.list-row-main` (title + meta), `.list-row-tail`. |
| `.favicon-tile`, `.mini-tags` / `.mini-tag` | Site icon slot and inline `#tag` text in list meta. |
| `.empty` | Empty state inside a card: icon circle, title, hint, optional button. |
| `.avatar`, `.avatar--lg`, `.avatar-wrap[data-attention]` | Account monogram or photo; the attention dot marks sync that needs action. |
| `.sync-bar` (`--thin`), `data-state` | Sync progress: ink fill on a hairline track, set by `paintSyncBar` (`src/sync-progress-ui.ts`). `indeterminate` slides while there is no count yet, `done` turns green, `stalled` turns it amber and `paused` grey; only a running sync moves (the bar slides and the card's arrows turn). Used by the Sync progress card, the sidebar identity and the popup strip. |

## Popup

One shell for every mode (`popup.css`):

```
header   wordmark · (avatar menu) · settings
sync     count + thin bar while a sync runs (opens Sync status)
progress 2px auto-close line (automatic result only; pauses on hover/focus)
body     status line (result / already saved) → page block → field rows → inline note
footer   quiet ghost actions left · one primary right
```

- **Page block:** a 2.75rem favicon tile, then the title as an auto-growing two-line textarea (no
  pre-selection, no ink ring), then the domain. Clicking the domain edits the URL.
- **Field rows:** a 3.25rem right-aligned muted label column. Rows are Folder (`.folder-pill`, which
  opens the inline `.folder-panel` and grows the popup instead of overlaying), Tags (`.tag-input`
  with suggestion chips below) and Note (`textarea.field-quiet`). The AI folder suggestion is a
  `.chip--suggest` beside the folder pill. A folder the AI chose shows a muted "AI pick" mark.
  A folder one of the account's rules chose shows a muted "By rule" mark (fork icon, the rule named
  in its tooltip). The suggestion chip then reads "Suggest tags" and never offers a folder. Picking
  another folder removes the mark: the user's pick wins.
- **Rule line:** after a save, one line says what the rules did. A placement shows "Rule “…”" as
  the status meta in the manual popup, or a calm note in the automatic result. A rule that matched
  but could not act (folder missing here, out of date, rules disagree) uses the warning alert.
- **Star-button notice:** a page starred in the browser and filed by a rule gets one notice: the
  toolbar tooltip and the popup's note line the next time it opens. An open Know-N page also shows
  the web-style toast. The text is: Moved “…” to Academic by rule “…”.
- **New automation results (AW-60).**
  - **What it projects.** The server's own unread state: runs it reports unread with an output,
    such as a digest or a review. Nothing is counted from content, and nothing is ever marked read
    here; reading the run on the web clears it at the next status read.
  - **Toolbar badge.** The count in the accent colour, with the tooltip "1 new digest.". A save
    problem ("!") always wins the badge, and the count comes back when it clears. While the server
    can't be read, the badge keeps the last answer in the muted colour, and the tooltip says when it
    was read.
  - **Popup line.** The popup's quietest note line, last in its order, so anything about the page in
    front wins. It reads "1 new digest from “Weekly reading digest” · Read" (Read opens the run on
    the web), or "2 new digests · Open Digests". A stale answer adds "as of 3 hours ago".
  - **Options run list.** A run with an unread result shows a "New" badge (accent tokens) in place
    of its status.
- **Footer by state:**

  | State | Left | Right |
  |---|---|---|
  | Manual | Bookmarks, Save tabs | Save |
  | Automatic result | Undo, History | Done |
  | Already saved | Remove | Done |

- **Header:** no sync pill. An attention dot on the avatar appears only when sync needs action.
  Signed-out users see no avatar. Tags and notes work without an account.
- Width is 380px and maximum height 600px. Only the body scrolls; the header and footer stay pinned.

## Options

Sidebar (`15rem`, on paper, divided from the main column by a hairline):

```
wordmark
identity: avatar · name · sync line ("Synced · 2 min ago" / "Not signed in · Sign in")
Library   Bookmarks · History · Subscriptions · Sync · Automations
Settings  Saving · AI suggestions · General · Account
bottom    Help & diagnostics · version
```

The main column is centered, with `46rem` maximum width for settings pages and `72rem` for
lists (Bookmarks, History, Subscriptions). The page head holds the h1 and lede, with actions on the right. Toolbars (search plus
"Label: value" pills) sit in a row under the head. Below `56rem` the sidebar becomes a sticky top
bar whose items wrap onto a second line, so every destination stays visible.

| Route | Content |
|---|---|
| `#bookmarks` | Bookmark manager (tree and list in one card); tags and notes shown and searchable. The selection bar sits under the rows and sticks to the window's bottom edge; a selection belongs to the folder, search or tags on screen |
| `#history` | Saved-page history grouped by day; one badge per row, problems only |
| `#subscriptions` | Subscriptions; defaults as the last group |
| `#sync/...` | Collection, folders, status, import (connect card when signed out) |
| `#automations` | The server's rule bundle on this browser: status, freshness and offline expiry, each rule's folder here; rules are edited on the web. Below, kept apart: recent placements (this browser's receipts), then **On your server**, the server's runs in the web's words with their age (see below) |
| `#saving` | Toolbar mode, result panel, default folder, placement, shortcuts |
| `#ai` | Provider choice, Know-N authorization, own AI service, correction memory |
| `#general` | Language, permissions, export / backup / restore |
| `#account`, `#account/credits` | Identity, credits summary, sign out; credit activity table |
| `#help` | Diagnostics (the only place for internals) |

**Automations › On your server.** What the server did after a bookmark synced, never mixed with
what this browser did:

- **Placements and runs stay apart.** A placement keeps its own receipt badge, and a confirmed one
  has none, even if a run on that bookmark failed. A run never shows as done because the bookmark
  was filed.
- **Run rows.** Each run row uses the web's words and badges: Waiting, Running, Needs a decision,
  Done, Partly done, Blocked, Cancelled, Failed, or On hold for an explicit hold. Tone appears only
  for problems. The row opens the run on the web in a new tab.
- **Server state on rules.** A rule row adds its server state when it isn't simply on ("On, with
  problems", Blocked, Paused). It also adds the server's own counts (jobs waiting for an agent, held
  by a limit, needing approval) and the server's cost wording. Rules with no browser part (no
  intake), such as a digest, are listed too: "Works on your server; nothing to file here." A paused
  bundle carries no rules, so while paused the group lists only those and its lede says the filing
  rules come back when automations resume.
- **Narrow pages.** Below 540px the rule, placement and run rows follow the other library lists:
  the badge drops under the text, the title may take two lines and the meta line wraps.
- **Freshness.** One muted line under the runs: "Updated 2 minutes ago." A failed read keeps the
  last runs and says so with a warning icon: "Couldn’t reach your server. Showing what it said
  3 hours ago."
- **Missing web sign-in.** The runs are read with the browser's web sign-in, so without one the
  section asks for it ("Sign in on the web to see runs", Open Automations). A server without
  automations hides the section.

Old hashes redirect: `#saving/overview` and `#saving/history` go to `#history`;
`#preferences?section=capture|bookmarks` goes to `#saving`;
`…=classification|local-classification` goes to `#ai`; `…=language|permissions` goes to
`#general`; `…=subscriptions` goes to `#subscriptions`; `#diagnostics…` goes to `#help…`;
`#account/session` goes to `#account`.

## Verification

Before a UI change lands, screenshot every state it touches with the options/popup harness:

- signed in, signed out and first run
- empty, loading and error states, and dialogs
- 1280px and 820px options; 380px popup
- `en` and `zh_CN`

Look at the screenshots. Passing tests don't show that a screen looks right.

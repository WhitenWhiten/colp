# Icon system

`src/components/icon-paths.ts` holds every functional icon as one SVG path on a shared grid; `Icon` (`src/components/Icon.tsx`) only renders them. The set came from Know-N, where the same file also drives the browser extension; here only the web UI uses it, and glyphs no surface references are removed.

## Rules

- 24 × 24 grid, 1.5-unit stroke, round caps and joins; main outlines keep about 3 units of inset.
- `currentColor` only, so an icon follows the text colour around it.
- 20px by default, 16px in dense toolbars, 24–32px for navigation and emphasis. Empty states reuse the same glyphs at their own size.
- Outlines by default. `isFilledIcon` lists the few solid silhouettes (play, heart, star, the GitHub mark, the ⋯ dots); state such as saved or read is shown with colour and fill, not a second outline.
- Icons are decorative: `aria-hidden="true"` and `focusable="false"`. The button's text or `aria-label` names the control.
- Not functional icons, so not in this set: the COLP brand mark (`public/colp-mark.svg`), site favicons and domain marks, avatars, the relation graph, and progress rings. Keyboard shortcuts, path separators, and maths stay text.

## Adding or checking an icon

Add the path to `SHARED_ICON_PATHS`; `IconName` is derived from its keys, so TypeScript rejects a name that does not exist. `node scripts/preview-icons.mjs [outDir]` (Node 22.18+) writes a static HTML sheet of every glyph at 16, 20, 24, and 32px on light and ink toolbars. `src/components/Icon.test.tsx` checks that every glyph renders as a decorative stroke SVG and that filled glyphs carry `data-fill`.

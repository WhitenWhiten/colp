# Browser rules follow-up (2026-10-14)

AW-67..AW-72 put rules made in the browser below the account's rules. Their delivery report listed
leftovers. A later UX review of the whole "where does a saved page go" setup found what may mislead
users. Each item below is its own commit. A commit cannot name itself, so each one fills in the
previous item's hash.

## Leftovers from the AW-72 report

| Item | Commit | Change |
| --- | --- | --- |
| L1 | `3aee64ae` | Signing in as another account (or on another server) without signing out first removes the earlier account's automation data. Browser rules stay. |
| L2 | — | The *Sign out* hint, the sign-out dialog and the *Disconnect server* hint say that rules made in this browser stay, and that the account's rules stop. |
| L3 | planned | Moving a browser rule to the account, run against a real colp-server. |
| L4 | planned | Browser rules also file bookmarks made with the browser's star button. |

## What may mislead users

| Item | Commit | Problem | Change |
| --- | --- | --- | --- |
| U1 | planned | *Pause all automations* left browser rules running; they even took over while the account was paused. | planned |
| U2 | planned | Two "New rule" buttons on one page made different kinds of rule. | planned |
| U3 | planned | The order that decides a saved page's folder was not shown anywhere. | planned |
| U4 | planned | "AI suggestions" hid that, in Automatic mode, the AI files the page. | planned |
| U5 | planned | A rule waiting to move to the account could say *Moving* forever. | planned |
| U6 | planned | A browser rule that kept a page where it was saved left no trace after the save panel closed. | planned |

## Left unchanged

- **Acceptance status in the design pack.** All 74 scenarios in `design/acceptance-tests.json` are
  `planned_not_executed`, including ones executed weeks ago. The pack is the plan; what ran, and how, is
  recorded in `status.md` and the evidence files. AC-69..AC-74 follow the same rule.
- **The status card's length.** It is long but accurate. It is not changed here.

## L1 — signing in as another account

`src/sw/auth.ts`: after a successful sign-in, if the earlier credential named another account or another
server, `clearAccountAutomation` (AW-72) runs for that earlier account. The same account signing in again
keeps its bundle, status and receipts.

`tests/automation-disconnect.test.ts` (+3) drives the real `known.auth.login` handler:

- another account: the earlier bundle, status, intents and pause go; browser rules are unchanged;
- the same account on another server counts as another account;
- the same account again keeps its data.

With the change reverted, the first two fail.

| Command (`packages/extension`, Node 24.14.0) | Result |
| --- | --- |
| `npx tsc --noEmit -p .` | pass |
| `npx eslint src/sw/auth.ts tests/automation-disconnect.test.ts` | pass |
| `npx vitest run` over the disconnect test and the five suites that import `sw/auth` | 6 files, 31 tests passed |

## L2 — what signing out and disconnecting keep

The Account pane said only "Bookmarks on this browser are kept" (Disconnect server) and "Bookmarks, tags
and notes stay in this browser. Personal sync stops when you sign out" (Sign out row and its dialog).
Neither mentioned rules. Both now name what stays and what stops:

- Sign out: "Bookmarks, tags, notes and rules made in this browser stay. Personal sync and your account's
  rules stop when you sign out."
- Disconnect server: "Bookmarks and rules made in this browser are kept."

The keys are unchanged (`options_bookmarksStayBrowserSync`, `options_disconnectKeepsBookmarks`); `zh_CN` is
updated with them.

| Command (`packages/extension`) | Result |
| --- | --- |
| `node scripts/i18n-catalog.mjs --write`, `--apply zh_CN`, `npm run check:i18n` | catalog and translations current |
| `npm run build:development`, then `SHOT_ONLY=account,dialog-logout npm run shots` in `en` and `zh_CN` (xvfb) | reviewed at 1280, 820 and 320 |

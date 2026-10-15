# Browser rules follow-up (2026-10-14)

AW-67..AW-72 put rules made in the browser below the account's rules. Their delivery report listed
leftovers. A later UX review of the whole "where does a saved page go" setup found what may mislead
users. Each item below is its own commit. A commit cannot name itself, so each one fills in the
previous item's hash.

## Leftovers from the AW-72 report

| Item | Commit | Change |
| --- | --- | --- |
| L1 | `3aee64ae` | Signing in as another account (or on another server) without signing out first removes the earlier account's automation data. Browser rules stay. |
| L2 | `1ee62307` | The *Sign out* hint, the sign-out dialog and the *Disconnect server* hint say that rules made in this browser stay, and that the account's rules stop. |
| L3 | `d1725e7a` | Moving a browser rule to the account, run against a real colp-server. The run found that the server's rules never compared equal to browser rules; fixed here. |
| L4 | — | *Rules in this browser* and their editor say they file pages saved with the Know-N button or menu, not the browser's star. The star path is unchanged; see below. |

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

## L3 — moving a rule, against a real colp-server

`e2e/mv3-browser-rules-server.spec.ts` runs AC-73 with nothing mocked or seeded. It is skipped unless
`COLP_AW_ORIGIN`, `COLP_AW_USER` and `COLP_AW_PASSWORD` name a disposable server and its owner.

1. The production extension signs in, gets bookmark access, and syncs the bookmarks bar into a new
   collection made on the web.
2. It makes a folder *Papers* and a browser rule "Site is arxiv.org → Papers".
3. *Add to your account* appears once the folder is on the server. It opens
   `/automations/new?…&from=browser` in the browser's own web session, with the note, the name and the folder
   filled in. The row reads *Moving*.
4. On the web the owner previews the rule and turns it on.
5. The next check in the browser installs the account's copy. The browser rule is gone, the account's rule is
   listed, and the notice "“…” now runs from your account, on every device." shows.
6. The popup preview for an arXiv page now names the account's rule and *Papers*.

### What the first run found

Step 5 failed. The account's copy arrived, but the browser rule stayed. The bundle from the server had the
same condition as the browser rule, with its keys in another order:

```text
server   {"op":"eq","kind":"field","field":"bookmark.url.host","value":"arxiv.org"}
browser  {"kind":"field","field":"bookmark.url.host","op":"eq","value":"arxiv.org"}
```

`sameMatch` (`src/automation/browser-overlap.ts`) compared JSON text without sorting keys. Any rule from a
real server therefore never matched a browser rule:

- a moved rule never retired (AW-71);
- *Same as account* was never shown (AW-69); such a pair was reported as nothing at all.

The unit tests built both sides with the same key order, so they passed. `canonical` now sorts keys at
every level. `tests/automation-browser-overlap.test.ts` (+1) uses the server's key order; it fails without
the change.

### The stack

`docker build -f packages/server/Dockerfile -t colp-server:13c6b650 .` from `13c6b650` (server and web as
of AW-72), then `deploy/compose.yaml` with the `http` profile on `127.0.0.1:18080`
(`COLP_INSECURE_HTTP=true`). The owner was made with `colp-server create-user`. The stack was removed with
`docker compose down -v` afterwards.

### Runs

| Command (`packages/extension`, Node 24.14.0) | Result |
| --- | --- |
| `npx tsc --noEmit -p .`, `npx eslint` on the changed files | pass |
| `npx vitest run tests/automation-browser-overlap.test.ts tests/automation-browser-move.test.ts tests/automation-worker-browser-rules.test.ts` | 3 files, 26 tests passed |
| `npm run build`, then `node scripts/with-xvfb.mjs npx playwright test e2e/mv3-browser-rules-server.spec.ts` with the three variables | 1 passed (17.1 s); then 3 of 3 passed, spaced 75 s apart (18.4 s, 19.5 s, 18.1 s) |

Runs back to back, about 17 s apart, sometimes failed at the web's `GET /api/v1/session` with HTTP 429. The
server allows 60 auth requests a minute per client (`AUTH_RATE_LIMIT_MAX`, `AUTH_RATE_LIMIT_WINDOW_MS`). The
web then rendered a blank page, or the editor signed out with empty Collection and Folder. Spaced 75 s
apart, the runs pass. The web's blank page on a 429 is outside this work and is noted here only.

## L4 — what browser rules file

The AW-72 report listed "the star button only runs the account's rules" as a leftover. Two fixes were
possible: run browser rules on the star path too, or say plainly that they don't. This item does the second.

The star path (`src/automation/observed-create.ts`) moves a bookmark only when the create is *new local
intent*. It decides that from Sync's own record of the create. With that record it can tell a star from:

- the extension's own saves, including a folder the user picked in the popup;
- an inbound Sync projection;
- an import, an undo or a restore.

Browser rules work signed out, where that record does not exist. Without it, a browser rule could move a
bookmark the user deliberately put in the Bookmarks bar, which breaks "a folder you pick yourself always
wins". ADR-A24 kept the star path account-only for the same reason. Changing that needs its own design
(own-save evidence that works without Sync). It is not attempted here.

The copy now says where browser rules apply:

- signed out: "They file pages you save with the Know-N button or menu, not the browser's star, even
  offline and with no account. A folder you pick yourself always wins."
- signed in: "Only this browser uses them, after your account's rules, for pages you save with the Know-N
  button or menu, not the browser's star. A folder you pick yourself always wins."
- the editor's note: "Only this browser uses this rule, after your account's rules, for pages you save with
  the Know-N button or menu. A folder you pick when saving always wins."

| Command (`packages/extension`) | Result |
| --- | --- |
| `node scripts/i18n-catalog.mjs --write`, `--apply zh_CN`, `npm run check:i18n` | catalog and translations current |
| `npx vitest run tests/automation-browser-pane.test.ts tests/automation-status-ui.test.ts` | 2 files, 29 tests passed |
| `npm run build:development`, then the Automations shots in `en` and `zh_CN` (xvfb) | reviewed signed in and out, and the editor, at 1280, 820 and 320 |

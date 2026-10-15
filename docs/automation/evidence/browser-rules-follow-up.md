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
| L4 | `cfa1ee68` | *Rules in this browser* and their editor say they file pages saved with the Know-N button or menu, not the browser's star. The star path is unchanged; see below. |

## What may mislead users

| Item | Commit | Problem | Change |
| --- | --- | --- | --- |
| U1 | `cce0089d` | *Pause all automations* left browser rules running; they even took over while the account was paused. The card said "All automations are paused… Bookmarks keep the folder you save them to". | The account's pause pauses browser rules too, and the page says so. |
| U2 | `566f6430` | Two "New rule" buttons on one page made different kinds of rule. | One *New rule*; signed in, it asks *This browser* or *All my devices* first. |
| U3 | `d6a59aa3` | The order that decides a saved page's folder was not shown anywhere. | Automations opens with the five steps and what each does here now. |
| U4 | `7dcf8e56` | "AI suggestions" hid that, in Automatic mode, the AI files the page. | The AI page and the Automatic choice say what files the page, and when. |
| U5 | — | A rule waiting to move to the account could say *Moving* forever. | After a day it says it is not on yet, with *Open on the web* and *Keep in this browser*. |
| U6 | planned | A browser rule that kept a page where it was saved left no trace after the save panel closed. | planned |
| U7 | `c2f8bc9b` | In Chrome the status card read "Updated .2 minutes ago" and the server line "Updated .now": the time landed after the full stop. | The time goes where the translation puts it, in Chrome too. |

## Left unchanged

- **Acceptance status in the design pack.** All 74 scenarios in `design/acceptance-tests.json` are
  `planned_not_executed`, including ones executed weeks ago. The pack is the plan; what ran, and how, is
  recorded in `status.md` and the evidence files. AC-69..AC-74 follow the same rule.
- **The status card's length.** It is long but accurate. It is not changed here, apart from U1 and U7.

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

## U1 — one pause for all automations

**Before.** Paused on the web, the account's rules stopped. `preSaveDecision` then returned nothing, so
browser rules filed the page instead. Meanwhile the card said "All automations are paused… Bookmarks keep
the folder you save them to."

**Now.** `rulesDecision` (`src/sw/automation.ts`) is the one place that orders the layers:

1. the account's rules;
2. this browser's rules, only where none of the account's speaks;
3. none at all while the signed-in account's bundle is paused.

The capture path (`src/sw/capture.ts`) and the popup preview both use it. Signed out there is no account
pause; each browser rule keeps its own switch.

The Options page says the same thing:

- *Rules in this browser* while paused: "Paused with your account's automations. They file pages again when
  you resume on the web." Each enabled rule shows *Paused*. *Off* and *Folder missing* still say more, and
  take its place.
- The pause row: "You pause and resume on the web; rules in this browser pause with them. …"
- The status card counted only the account's rules as "3 rules file bookmarks…" on a page that also lists
  browser rules. It now says "3 account rules…" and "None of your account's rules…".

Design: 01 §7.5, ADR-A24 and AC-70 are amended to match.

| Command | Result |
| --- | --- |
| `npx tsc --noEmit -p .`, `npx eslint` on the changed files (`packages/extension`) | pass |
| `npx vitest run tests/automation-browser-pane.test.ts tests/automation-status-ui.test.ts tests/automation-worker-browser-rules.test.ts tests/capture-pre-save.test.ts` | 4 files, 59 tests passed |
| `node scripts/i18n-catalog.mjs --write`, `--apply zh_CN`, `npm run check:i18n` | current |
| `python3 validation/build-docs.py`, `python3 validation/validate.py` (`docs/automation/design`) | 63 checks passed |
| `npm run build:development`, then `SHOT_ONLY=automations-paused npm run shots` in `en` and `zh_CN` (xvfb) | reviewed at 1280, 820 and 320 |

The worker tests:

- *stand still while the account's automations are paused, and file again once they resume*: replaces the
  test that asserted the old fallback.
- *decide when the account has no rules here, and give way to the account's rule once it has one*.

## U7 — "Updated .now"

The L3 run's screenshots showed the status card as "Updated .now This browser checks…". The card builds
"Updated $1." with a time element in the middle. It passed a marker as `$1` and split the result on it.
The marker was U+0000, and Chrome's `i18n.getMessage` drops it. Probed in Chromium with the production
build:

| Value passed as `$1` | `getMessage('automation_updatedAt', [value])` |
| --- | --- |
| `\u0000` | `"Updated ."` |
| `\uE000` (private use) | `"Updated ."` |
| `\uFFFC` (object replacement) | `"Updated ￼."` |

With no marker left to split on, the time was appended after the full stop. Five strings used the trick: the
card's "Updated $1." and four server-status lines (updated, signed out, unreadable, unreachable). The
screenshot stubs never call `chrome.i18n`, so the shots looked right.

`src/i18n.ts` now has `SLOT` (U+FFFC) and `withSlot(copy, node)`; all five use them.
`tests/i18n.test.ts` (+1) stubs `getMessage` the way Chromium behaved: in English and in `zh_CN`, the
element sits where `$1` was. With the marker set back to U+0000 the test fails.

| Command (`packages/extension`) | Result |
| --- | --- |
| A one-off Playwright probe of `chrome.i18n.getMessage` in the production build (xvfb) | the table above |
| `npx tsc --noEmit -p .`, `npx eslint` on the changed files | pass |
| `npx vitest run tests/i18n.test.ts tests/automation-status-ui.test.ts tests/automation-browser-pane.test.ts tests/automation-worker-status.test.ts` | 4 files, 45 tests passed |

## U2 — one New rule

**Before.** The page head's *New rule* made a browser rule. The account section had *New rule on the web*,
which opened an empty web editor. To make the right kind of rule, the Owner had to know the difference
first.

**Now.** *New rule* is the page's only one.

- Signed out, it opens the browser rule editor as before.
- Signed in, the editor first asks *Use it on*, as two choice cards. *This browser* (the default) "works
  right away, even offline. Your other devices don't get it." *All my devices* is "your account's rule. You
  preview it and turn it on on the web. Its folder must be synced."
- *All my devices* turns *Save rule* into *Continue on the web*. The new command
  `known.automation.browser.forAccount` checks the draft in the worker. It then returns the web editor
  address filled in with it: the same address AW-71 builds, and L3 ran against a real server. Nothing is
  stored in the browser. A folder Sync has not confirmed gets "This folder isn't synced…" on the folder
  field; signed out gets "Sign in to make a rule for all your devices."
- The account's empty section now has a *New rule* button. It opens the same editor, set to *All my
  devices*. Its hint now reads "An account rule files pages on every device signed in to your account."
- Editing a browser rule does not ask: it stays this browser's, and moving it is *Add to your account*.

| Command (`packages/extension`) | Result |
| --- | --- |
| `npx tsc --noEmit -p .`, `npx eslint` on the changed files | pass |
| `npx vitest run tests/automation-*.test.ts tests/capture-pre-save.test.ts tests/i18n.test.ts tests/service-worker-entry-behavior.test.ts` | 223 tests passed |
| `node scripts/i18n-catalog.mjs --write`, `--apply zh_CN`, `npm run check:i18n`; `npm run check:source-size` | pass |
| `npm run build:development`, then `SHOT_ONLY=automations-new-signedin,automations-new-account,automations-browser-new npm run shots` in `en` and `zh_CN` (xvfb) | reviewed at 1280, 820 and 320 |

New tests:

- the pane (+5): the choice and its default; no choice signed out or when editing; *All my devices* sends
  `forAccount`, opens the address and stores nothing; *not synced* lands on the folder; the account's empty
  section starts at *All my devices*;
- the worker (+1, and shape checks): signed out, a synced folder (the address's parameters), an unsynced
  folder, an invalid draft; the browser's rules are unchanged afterwards.

## U3 — how a page you save finds its folder

**Before.** The order (your folder, the account's rules, this browser's rules, AI, otherwise where you
saved it) was spread over hints on three pages. That the AI files only in Automatic mode followed only from
the Saving and AI settings.

**Now.** *Automations* opens with **How a page you save finds its folder**: five numbered steps in the
order the worker takes them. Each step says what it does here right now:

| Step | What it can say |
| --- | --- |
| 1 A folder you pick | Always wins |
| 2 Your account's rules | *n on*, *None yet*, *Paused*, *Out of date*, *Sign in to use them* |
| 3 Rules in this browser | *n on* (switched on, with a folder), *All off*, *None yet*, *Paused* (with the account) |
| 4 AI | *Your AI service picks one* / *Know-N picks one* (Automatic); *Off · Set up* (→ AI); *Suggests in the form* or *You choose in the form* · *Manual mode* (→ Saving) |
| 5 Otherwise | Stays where you saved it |

The worker adds `saving` to the Automations state (`savingFlow` in `src/sw/automation.ts`):

- `mode`: the capture mode;
- `ai`: *own* when the Owner's AI service is on; else *knowN* with a live, unexpired authorization for the
  collection saved into, the same check the capture path makes; else none;
- `suggestInForm`: Manual mode's "Suggest when the form opens".

The strip is `src/automation/flow-strip.ts`. It shows five cards in a row, and a single list below 760 px.

| Command (`packages/extension`) | Result |
| --- | --- |
| `npx tsc --noEmit -p .`, `npx eslint` on the changed files, `npm run check:source-size` | pass |
| `npx vitest run tests/automation-*.test.ts tests/capture-pre-save.test.ts tests/i18n.test.ts tests/service-worker-entry-behavior.test.ts` | 24 files, 227 tests passed |
| `node scripts/i18n-catalog.mjs --write`, `--apply zh_CN`, `npm run check:i18n` | current |
| `npm run build:development`, then the `automations-flow-manual`, `automations-flow-noai-out`, `automations-paused` and `automations-browser-out` shots in `en` and `zh_CN` (xvfb) | reviewed at 1280, 820 and 320; a first version had no gap below the strip and text sinking to the bottom of each card, both fixed |

New tests:

- the pane (+2): the five steps and their states; off, paused and Manual mode with their links;
- the worker (+2): mode, own AI and *suggest in the form* from storage; Know-N only with a live
  authorization for the bound collection (an expired one, or one for another collection, counts as none).

## U4 — what the AI does

**Before.**

- The AI page: "Optional. Know-N can suggest a folder and tags when you save."
- Saving's *Automatic* choice: "One click saves the page. A short panel lets you change the folder."

Neither said that in Automatic mode the AI moves the page, or that it comes after the rules.

**Now.**

- The AI page: "Optional. AI picks a folder for a page no rule matched, and can suggest or add tags. In
  Automatic mode it files the page there; in Manual mode it only suggests, in the form."
- *Automatic*: "One click saves the page. Your rules, then AI, pick the folder; a short panel lets you
  change it."

Tags are not tied to "no rule matched": with the Owner's own AI service, a page a rule placed can still get
tags (`folder: false, tags: true`). The page keeps its name, *AI suggestions*. Its opening line now says what
it does, and U3's strip calls the step *AI*.

| Command (`packages/extension`) | Result |
| --- | --- |
| `node scripts/i18n-catalog.mjs --write`, `--apply zh_CN`, `npm run check:i18n` | current |
| `npm run build:development`, then the Saving and AI shots (`in-`, `out-`, `own-ai`, `manual-`) in `en` and `zh_CN` (xvfb) | reviewed at 1280, 820 and 320 |

## U5 — a move that never finishes

**Before.** *Add to your account* marked the rule *Moving* until an enabled account rule doing exactly the
same arrived. That may never happen: the Owner may not turn it on, or may change the rule on the web first.
The row then said "Waiting for your account's copy" for good. Signed out it also kept saying *Moving*,
though no copy could arrive.

**Now.**

- After a day (`MOVING_STALE_MS`, `src/sw/automation-browser.ts`) the view sets `movingStale`. The row's
  badge becomes the warning *Not on yet*, with "Your account doesn't have it yet. Turn it on on the web, or
  keep it in this browser." Two buttons sit under it:
  - *Open on the web* reopens the filled-in editor, when the folder is still synced;
  - *Keep in this browser* sends the new `known.automation.browser.stay`. `stopMoving` clears the mark,
    and the rule keeps filing as before.
- Within the first day the row still says *Moving*.
- Signed out, nothing is shown as moving. The mark stays, so signing back in picks it up again.

| Command (`packages/extension`) | Result |
| --- | --- |
| `npx tsc --noEmit -p .`, `npx eslint` on the changed files, `npm run check:source-size` | pass |
| `npx vitest run tests/automation-*.test.ts tests/capture-pre-save.test.ts tests/i18n.test.ts tests/service-worker-entry-behavior.test.ts` | 24 files, 231 tests passed |
| `node scripts/i18n-catalog.mjs --write`, `--apply zh_CN`, `npm run check:i18n` | current |
| `npm run build:development`, then `SHOT_ONLY=automations-browser-stale npm run shots` in `en` and `zh_CN` (xvfb) | reviewed at 1280, 820 and 320 |

New tests:

- the store (+1): `stopMoving` clears the mark only, and is idempotent;
- the worker (+1): not stale at exactly a day, stale after it; signed out shows nothing; `stay`; its shape;
- the pane (+2): the stale row, its link and its button (which never opens the editor); *Moving* within
  the day.

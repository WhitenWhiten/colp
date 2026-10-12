# User Stories and Traceability

**Status:** proposed behavior for COLP Server automations. **Version:** 0.2.1-design. **Date:** 2026-10-12.

Purpose: no automation function enters COLP Server without a story that needs it. Each story names the actor, what they do, why, and how we know it works. Acceptance criteria are written so that each can become an end-to-end test or a manual checklist item without reinterpretation. Every story names its milestone (`M1`–`M4` or `Later`, defined in [the implementation handbook](06-implementation-handbook.md)), its acceptance tests (`AC-xx`, defined in [acceptance and operations](07-acceptance-operations.md)), its work packets (`AW-xx`) and one configuration example from [examples](examples/).

Story IDs are `AU-xx` so they never collide with the product's `US-xx` stories in `~/known/colp-server/01-user-stories.md`. Task IDs are `AW-xx` so they never collide with the product's lane tasks (`A1`, `E1`, …).

## Actors

| Actor | Who |
|---|---|
| **Owner** | The one person who runs the server and owns every collection on it. Configures rules in the web UI; reads results there and in the extension. |
| **Browser** | A browser profile with the Known extension, signed in to the Owner's server. Several, on several machines. Saves through the popup, the shortcut, the context menu, "Save tabs", and the browser's own star button. |
| **Agent** | An AI assistant the Owner connected over MCP (OAuth client or API key). Three roles in this pack: an **ordinary agent** (reads and organizes on request, unchanged), a **worker** (takes automation jobs: lists, claims, reads, submits), and a **hosted bot** (a worker on a hosted platform, for example a ChatGPT dot, that subscribes to MCP Events so the server can wake it). Each worker target has a wake mode: *events* (woken by the server, the default where possible) or *poll* (the agent checks on its own schedule, for example Claude Code on a routine or a script). |
| **Rule** | Not a person, but it acts: "when a bookmark like this arrives, put it here, then ask this agent to do that". |

Real-world constraints that shape every story below:

- The Owner saves dozens of bookmarks a week, not thousands a day. They will set up one or two rules, forget about them, and judge the feature by whether the right thing happened to the paper they saved last Tuesday, and by whether it ever did something they did not want.
- Many self-hosted servers sit behind NAT or on a loopback origin (decisions D9 and D26 in the product plan). An agent can only be *woken* if the server has a public HTTPS origin; on other servers the target's wake mode falls back to polling (AU-26). Everything in M1 works without agents at all.
- In the self-hosted edition the extension's automatic classification runs only through the Owner's own local provider (the server's classification routes are pruned, see R19). "No model call" therefore means: the extension does not ask that provider to choose a folder.

## Story index

| ID | Story | Milestone | Tests |
|---|---|---|---|
| AU-01 | Create my first rule from a folder in two minutes | M1 | AC-26, AC-41, AC-54, AC-57 |
| AU-02 | See what a rule would have done before I enable it | M1 | AC-26 |
| AU-03 | Rename or move a folder without breaking its rules | M1 | AC-13, AC-14 |
| AU-04 | A deleted folder is never silently replaced | M1 | AC-15 |
| AU-05 | Two rules that disagree are shown to me, not resolved by luck | M1 | AC-08 |
| AU-06 | An arXiv page lands in Academic with no model call | M1 | AC-01, AC-02 |
| AU-07 | The folder I chose myself always wins | M1 | AC-07, AC-49 |
| AU-08 | Bookmarks I star in the browser follow the same rules | M1 | AC-09, AC-49, AC-55 |
| AU-09 | Bookmarks added on the web, from my phone, or by an agent follow the same rules | M1 | AC-42, AC-58 |
| AU-10 | Save offline, continue later | M1 | AC-10, AC-11 |
| AU-11 | Sync between my browsers does not run the rule twice | M1 | AC-12 |
| AU-12 | The rule picks the folder; my local AI may still suggest tags | M1 | AC-04 |
| AU-13 | See why a bookmark is where it is, and undo one thing | M1 | AC-43, AC-59 |
| AU-14 | Pause everything with one switch | M1 | AC-44, AC-56 |
| AU-15 | My research agent writes a summary and tags after I save | M2 | AC-05, AC-45, AC-53 |
| AU-16 | The agent may refine inside Academic, never outside it | M2 | AC-03 |
| AU-17 | When the taxonomy is ambiguous, keep the parent | M2 | AC-06 |
| AU-18 | Edits I make while the agent is thinking are kept | M2 | AC-24, AC-25 |
| AU-19 | Agent proposals use the approvals I already have | M2 | AC-46, AC-63 |
| AU-20 | No silent fallback to another model or provider | M2 | AC-23 |
| AU-21 | Each agent sees only its own jobs; ordinary agents see nothing new | M2 | AC-17, AC-18, AC-19, AC-60 |
| AU-22 | When the agent is down, saving still works and I can see what is waiting | M2 | AC-16, AC-31 |
| AU-23 | See what automation cost this week, and cap it | M2 | AC-47 |
| AU-24 | Every ten new papers, one digest I can actually read | M3 | AC-20, AC-21, AC-48, AC-65, AC-66 |
| AU-25 | Run a rule once over bookmarks I already have | M3 | AC-50, AC-64 |
| AU-26 | Choose how an agent learns about work: woken by events or polling | M2 | AC-34, AC-35, AC-36, AC-51, AC-61, AC-62 |
| AU-27 | Pause, resume, replay and undo mean different things | M3 | AC-32, AC-33, AC-65 |
| AU-28 | Install someone's workflow using my own folders | M4 | AC-27, AC-67 |
| AU-29 | An upgrade that wants more must ask me | M4 | AC-28 |
| AU-30 | Several agents give independent takes on one batch | M4 | AC-22 |
| AU-31 | Catalog enrichment with my own entity map and vocabulary | M4 | AC-30, AC-68 |
| AU-32 | A weekly digest at a time I choose | Later | AC-29 |
| AU-33 | Rules are in my backup and my export, and leave with me | M1 | AC-52, AC-67 |

---

## A. Set up a rule (M1)

### AU-01 Create my first rule from a folder in two minutes — M1

**Execution constraint:** The executable M1 fixture is m1-rule-create.json; no execution policy or worker is required.
**As the Owner**, I want to open my Academic folder and say "pages from arxiv.org go here", without reading a rule language, so that the feature pays off the first time I save a paper.

Acceptance:
1. On the web collection page, a folder's menu offers "Automate…". It opens the Automations page with a new draft rule whose destination is that folder.
2. The editor asks three things, in this order: *when* (one or more conditions: site is / site ends with / title contains / has tag / URL path starts with), *where* (the destination folder, pre-filled), *then* (optional agent tasks, hidden until M2 is enabled on this server).
3. "Preview" (AU-02) runs before "Enable" is offered. Enabling a rule that has never been previewed is impossible from the UI.
4. The whole flow, from "Automate…" to an enabled rule, takes under two minutes and never shows JSON. The JSON view exists behind "Advanced" for copying, pasting, and agents.
5. The Automations page lists rules with a plain-language sentence each: "When the site is arxiv.org, save to Academic. Enabled since 12 Oct, matched 14 bookmarks."
6. The Automations page is reachable from the main navigation next to Agents, and from the extension's Options tab.

Tasks: AW-01, AW-04, AW-06, AW-10, AW-12, AW-49, AW-63, AW-66. Tests: AC-26, AC-41, AC-54, AC-57. Example: [m1-placement.json](examples/m1-placement.json).

### AU-02 See what a rule would have done before I enable it — M1
**As the Owner**, I want a preview over my own recent bookmarks, so that I know a rule is right before it touches anything.

Acceptance:
1. Preview evaluates the draft against the last 200 bookmarks saved into the scoped collection (newest first) and lists them in four groups: would match, would not match, blocked (destination unusable), conflict (another enabled rule wins or ties).
2. Preview changes nothing: no move, no model call, no agent notification. It stores only an expiring preview record bound to the exact rule, bindings and policy it evaluated.
3. Enabling requires an unexpired preview of exactly the configuration being enabled. Any edit after preview disables "Enable" until "Preview" runs again (AC-26).
4. Preview explains each decision in one line: "matched: host arxiv.org", "blocked: folder Academic was deleted", "conflict with rule 'Papers to Work' (same priority)".
5. A preview with no matches says so, and says why that may be fine: "none of your last 200 bookmarks are from arxiv.org".

Tasks: AW-10, AW-12. Tests: AC-26. Example: [preview-request.json](examples/preview-request.json).

### AU-03 Rename or move a folder without breaking its rules — M1
**As the Owner**, I want to rename Academic to Research, or move it under Reading, and keep my rules working, so that organizing my tree never silently turns automation off.

Acceptance:
1. Rules bind the folder's identity, never its name or path. After a rename, the rule sentence shows the new name within one refresh; counters and the unfinished batch (M3) are unchanged (AC-13).
2. After a move that keeps the folder inside the collection and inside any required ancestor, the rule keeps working and the Automations page shows an informational notice: "Academic moved to Reading › Academic".
3. After a move that leaves a required ancestor, or out of the synced range, the dependent stage blocks with a warning that names the folder, the rule and the fix. Unrelated rules are untouched (AC-14).
4. Moving an ancestor re-checks every rule under it; the notice lists all affected rules at once, not one toast per rule.
5. Acknowledging a notice hides it; it does not mark anything repaired. The notice returns if the condition persists at the next check.

Tasks: AW-08, AW-09, AW-11, AW-12. Tests: AC-13, AC-14. Example: [academic-bindings.json](examples/academic-bindings.json).

### AU-04 A deleted folder is never silently replaced — M1
**As the Owner**, I want a rule whose folder I deleted to stop and tell me, not to guess a new folder with the same name, so that bookmarks are never misfiled or exposed because of a lookalike folder.

Acceptance:
1. Deleting a bound folder blocks every stage that needs it. The Automations page shows "Academic was deleted" with two actions: "Restore folder" (from the sync trash when available) and "Choose another folder".
2. Creating a new folder named Academic does not rebind the rule (AC-15).
3. Saving a matching bookmark while the rule is blocked still saves the bookmark, at the location the user chose or the default location, and records "rule blocked: folder deleted" on that bookmark (AU-13).
4. Restoring the original folder revalidates the rule; it does not replay bookmarks saved while it was blocked. Those remain listed under the rule as "missed while blocked" with a "Run once on these" action (AU-25, M3).

Tasks: AW-08, AW-11, AW-12, AW-41. Tests: AC-15. Example: [academic-bindings.json](examples/academic-bindings.json).

### AU-05 Two rules that disagree are shown to me, not resolved by luck — M1
**As the Owner**, I want to see when two rules want different folders for one bookmark, so that behavior never depends on the order I created them in.

Acceptance:
1. Two enabled rules of equal priority that match the same bookmark with different destinations do not move it. The bookmark stays where it was saved and appears under "Needs a decision" on the Automations page with both rules named (AC-08).
2. Giving one rule a higher priority resolves future conflicts; the preview of either rule shows the conflict before enabling.
3. Tag additions from both rules still apply when they do not contradict each other.
4. A manual choice (AU-07) or a privacy restriction always beats priority.

Tasks: AW-06, AW-07, AW-12. Tests: AC-08. Example: [m1-placement.json](examples/m1-placement.json).

---

## B. Saving (M1)

### AU-06 An arXiv page lands in Academic with no model call — M1
**As the Owner**, I want a paper I save from arxiv.org to go straight into Academic, so that I stop dragging papers out of Other Bookmarks and stop paying my classifier to decide something I already know.

Acceptance:
1. With the rule from AU-01 enabled on this server and the extension signed in, saving an arXiv page through the popup, the keyboard shortcut, the context menu and "Save tabs" creates the native bookmark directly under the Academic folder. There is no create-then-move in the browser (AC-01).
2. The extension does not ask its local classification provider for a folder for that save. If tag suggestions are enabled (AU-12), it may still ask for tags only.
3. The popup result panel says: "Saved to Academic by rule 'arXiv papers'". With a worker configured (M2) it adds "summary pending".
4. If the Academic folder is deleted or unsynced at that moment, the save still succeeds at the default location and the panel says why the rule did not apply (AC-02). Nothing is sent to any classifier instead.
5. The server records one intake run for the bookmark, joined to the sync operation that created it, with the rule revision and the decision. The run is visible on the bookmark's page (AU-13).

Tasks: AW-03, AW-04, AW-05, AW-06, AW-13, AW-17, AW-18, AW-19, AW-35, AW-49, AW-56, AW-63. Tests: AC-01, AC-02. Example: [m1-placement.json](examples/m1-placement.json).

### AU-07 The folder I chose myself always wins — M1
**As the Owner**, I want to keep a folder I picked on purpose even when a rule would have chosen another, so that automation never fights me.

Acceptance:
1. In the popup, changing the folder before saving is an explicit choice. A matching rule does not move the bookmark; the result panel says "Saved to Work (your choice); rule 'arXiv papers' skipped" (AC-07).
2. The remembered last-used folder and the server's default location are not explicit choices; a rule may override them.
3. In the browser's own star dialog (AU-08), a folder that is one of the bookmark roots (Bookmarks bar, Other bookmarks, Mobile bookmarks) counts as "unsorted" and a rule may move the bookmark; any other folder counts as the Owner's choice (AC-49).
4. Moving a bookmark by hand after an agent task started invalidates that task's pending placement proposal (AU-18).

Tasks: AW-07, AW-19, AW-20, AW-56, AW-63. Tests: AC-07, AC-49. Example: [m1-placement.json](examples/m1-placement.json).

### AU-08 Bookmarks I star in the browser follow the same rules — M1

**Execution constraint:** A bookmark-root destination is an explicitly documented heuristic, not proof the Owner made no choice. Subsequent manual moves win; observer timers do not establish that the native dialog closed.
**As the Browser's user**, I want a bookmark created with Chrome's star button, drag to the bar, or the bookmark manager to follow the same rules as a popup save, so that behavior does not depend on which button I pressed.

Acceptance:
1. A bookmark created outside the extension inside the synced range is evaluated after a short settle window (default 3 seconds) so the star dialog's folder choice is seen first. If the bookmark sits in a bookmark root and a rule matches, the extension moves it once and records the decision (AC-09).
2. The move is visible in the browser (the bookmark appears, then jumps). The popup is not involved, so the extension shows one toast: "Moved to Academic by rule 'arXiv papers'".
3. The server receives the create and the move as one intake, not as a new save plus an unrelated move: the receipt names both native operations.
4. Imports, restores, bootstrap snapshots and inbound sync projections never count as a star-button creation.
5. A URL that already exists in the collection is still a new bookmark if the user created it; the rule applies to the new copy.

Tasks: AW-17, AW-20, AW-50, AW-56, AW-63. Tests: AC-09, AC-49, AC-55. Example: [local-receipt.json](examples/local-receipt.json).

### AU-09 Bookmarks added on the web, from my phone, or by an agent follow the same rules — M1

**Execution constraint:** Receipt timeout alone never establishes intake intent. Explicit folders, imports/restores and unknown intent are preserved unless a later verified receipt proves the action is still safe.
**As the Owner**, I want a bookmark I add in the web library on my phone, or one an agent creates, to land where my rules say, so that rules are a property of my collection and not of one browser.

Acceptance:
1. Creating a bookmark in the web library under a folder that is a bookmark root or the collection root applies matching intake rules on the server; the bookmark appears in Academic on the next refresh and the collection history shows one version with cause "automation: rule 'arXiv papers'".
2. A bookmark created by an agent through MCP is treated the same way, with the agent named as the saver.
3. A bookmark created directly inside a specific folder on the web (not a root) is an explicit choice; no rule moves it.
4. The resulting move is projected to every browser as an ordinary sync change; no browser starts a second intake (AU-11).
5. Import is excluded by default. The import preview says "Automation rules are not applied to imports; use 'Run once' afterwards".

Tasks: AW-13, AW-14, AW-16, AW-33, AW-63, AW-64, AW-66. Tests: AC-42, AC-58. Example: [event-facts.json](examples/event-facts.json).

### AU-10 Save offline, continue later — M1
**As the Browser's user**, I want to save and route bookmarks on a train, and have everything else happen when I am back online, so that nothing is lost or done twice.

Acceptance:
1. With a valid rule bundle on the device, saving offline places the bookmark by rule and records the decision locally. Restarting the browser or the extension's service worker keeps that record (AC-10).
2. On reconnect the extension sends the recorded decision; the server joins it to the sync operation of that bookmark and starts only tasks that are not already satisfied. There is never a second intake run (AC-10).
3. An expired bundle (older than its expiry, default 7 days) disables automatic placement and shows "Rules are out of date; connect to refresh". Saving keeps working at the chosen or default location (AC-11).
4. A partial, corrupt or unsupported bundle is rejected as a whole; the previous valid bundle stays in force and a notice is shown (AC-11).

Tasks: AW-03, AW-05, AW-17, AW-18, AW-21, AW-44, AW-49, AW-50, AW-56, AW-63. Tests: AC-10, AC-11. Example: [local-receipt.json](examples/local-receipt.json).

### AU-11 Sync between my browsers does not run the rule twice — M1
**As the Owner with two browsers**, I want a move made by a rule or an agent to appear on my other browser as just a move, so that I never get duplicate tags, duplicate runs or duplicate notifications.

Acceptance:
1. One server-side move projected to two browsers creates no new intake run on either (AC-12).
2. The projection carries the causing run; a browser recognizes it from the sync operation identity, not from a client-reported flag.
3. Automation-caused changes are not blanket-ignored: a rule placement legitimately causes the enrichment stage; only same-stage re-entry is denied, and a hop limit (default 8) stops loops.

Tasks: AW-14, AW-16, AW-20, AW-33, AW-50, AW-56, AW-63. Tests: AC-12. Example: [event-facts.json](examples/event-facts.json).

### AU-12 The rule picks the folder; my local AI may still suggest tags — M1
**As the Owner who configured a local classifier in the extension**, I want a rule hit to skip the folder question but keep my tag suggestions, so that I keep the part of the AI I still want and stop paying for the part I do not.

Acceptance:
1. With the extension's AI tag mode set to Suggest or Add and a rule placing the bookmark, the extension sends one classification request with `folder: false, tags: true` (AC-04).
2. With tag mode Off, no request is sent at all.
3. A tags result applied locally is recorded on the intake receipt as satisfying the tags task, so a server-side tags task (M2) is not run again for the same bookmark and the same tag contract.
4. The folder decision and the tag decision are shown as two separate lines in the result panel.

Tasks: AW-07, AW-19, AW-22, AW-62. Tests: AC-04. Example: [execution-policy.json](examples/execution-policy.json).

### AU-13 See why a bookmark is where it is, and undo one thing — M1

**Execution constraint:** The UI selects one effectReceiptId. M1 compensates only a proven placement; M2 requires an isolated plan effect and conservative collection-content fences. No automation force restore is exposed.
**As the Owner**, I want to open a bookmark and see what automation did to it, so that I can trust it, correct it, and stop it from repeating a mistake.

Acceptance:
1. The bookmark page in the web UI has an "Automation" section listing, newest first: what happened (moved to Academic; tags added: ml, nlp; summary written), by which rule and, for agent work, which agent, and when.
2. Each reversible entry has "Undo". Undo reverts only that effect and refuses with an explanation when the field changed afterwards: "You edited the note after the summary was written; nothing was changed" (AC-43).
3. A tag entry has "Don't suggest this tag again for this rule". The rejection is stored with the rule and respected by later tag tasks on this rule.
4. The extension popup, when the current page is a saved bookmark, shows the same list in compact form under the folder pill.
5. Nothing in this section requires the agent that did the work to be online.

Tasks: AW-12, AW-16, AW-25, AW-34, AW-51, AW-52, AW-63, AW-66. Tests: AC-43, AC-59. Example: [m1-placement.json](examples/m1-placement.json).

### AU-14 Pause everything with one switch — M1

**Execution constraint:** Pause is immediate for connected server admission; a disconnected extension learns it only on bundle refresh or expiry. Once learned, pause cannot be undone by a stale bundle.
**As the Owner**, I want one switch that stops all automation on all my devices, so that when something looks wrong at 11 pm I can stop it first and investigate tomorrow.

Acceptance:
1. The Automations page header and the extension's Options tab both have "Pause all automations". Turning it on stops new rule admissions on the server at once and holds work that is pending; running agent tasks finish but their results wait as proposals (AC-44).
2. Every connected extension stops applying local rules within one bundle refresh (default 5 minutes) and shows "Automations paused by you on 12 Oct".
3. Resuming does not process the bookmarks saved while paused. They are listed under "Saved while paused" with a "Run once on these" action (AU-25).
4. A paused server still answers agents' job reads with "paused" so a worker does not spin.

Tasks: AW-10, AW-12, AW-15, AW-18, AW-41, AW-49, AW-63, AW-66. Tests: AC-44, AC-56. Example: [ten-bookmark-digest.json](examples/ten-bookmark-digest.json).

---

## C. An agent finishes the job (M2)

### AU-15 My research agent writes a summary and tags after I save — M2
**As the Owner**, I want the paper that landed in Academic to have a short summary in its note and two or three subject tags within a few minutes, written by the agent I already connected, so that saving a paper is also the start of reading it.

Acceptance:
1. On the Agents page, an agent has a new switch "Can run automation jobs". Turning it on creates a named target for that agent ("Research") and tells me exactly what the agent will be able to read: bookmarks inside the folders bound to rules that use it.
2. The target shows how it learns about work (AU-26): "Woken by events" once the agent has subscribed over MCP Events and the server is reachable, otherwise "Polls on its own schedule". Events is the default whenever both hold.
3. In the rule editor, the *then* step offers tasks (summary into the note, tags, refine into a subfolder) and asks which target does them. A rule can be enabled with tasks even if the agent is offline; its state shows "waiting for Research".
4. When a job becomes ready, a target in events mode receives one signed wake-up within seconds; the agent then lists ready jobs, claims one, reads the bookmark through the ordinary `nodes.get` tool, and submits a typed result. A polling target does the same at its next check. Neither needs any write tool: the server applies the result (AU-19).
5. The summary appears in the bookmark's note with an attribution line ("Summary by Research, 12 Oct"), the tags are merged with mine, and the bookmark's Automation section lists both effects. The browsers receive them as ordinary sync changes.
6. The rule's page shows "last job finished 4 minutes ago" and each target's wake mode; for a polling target it adds the interval the Owner entered ("checks every 15 minutes") so freshness is stated honestly.
7. A result for a job that was already satisfied by another device or a previous attempt is accepted once and ignored afterwards; no duplicate note, no duplicate tags (AC-05).

Tasks: AW-02, AW-22, AW-23, AW-24, AW-26, AW-27, AW-29, AW-31, AW-32, AW-35, AW-64. Tests: AC-05, AC-45, AC-53. Example: [academic-intake.json](examples/academic-intake.json).

### AU-16 The agent may refine inside Academic, never outside it — M2
**As the Owner**, I want an agent that sorts papers into Academic › Post-training to be unable to move a paper into Work, so that my explicit organization constraints hold even when the model is confident.

Acceptance:
1. A refinement task is bound to a subtree root. A proposal whose destination is outside that subtree at commit time is rejected with a boundary diagnostic and recorded on the job (AC-03).
2. A destination that was inside the subtree when the agent read the tree but was moved out before commit is rejected the same way.
3. A valid descendant is applied as a move through the ordinary change-plan path with a collection version (AU-19).

Tasks: AW-07, AW-16, AW-24. Tests: AC-03. Example: [academic-intake.json](examples/academic-intake.json).

### AU-17 When the taxonomy is ambiguous, keep the parent — M2
**As the Owner with overlapping subfolders**, I want a paper that fits two subfolders equally to stay at Academic and get both subject tags, so that I never get a confident but arbitrary choice.

Acceptance:
1. The placement output contract allows `keepParent` and `review` as decisions; a worker that cannot justify a descendant returns `keepParent` with its reasons, and the bookmark stays (AC-06).
2. Tags from the same job still apply.
3. Scores from different models or providers are never compared with each other as probabilities; the server applies contracts, not confidence thresholds.
4. A `review` decision appears under "Needs a decision" with the candidate folders as one-click actions.

Tasks: AW-07, AW-22, AW-24, AW-39. Tests: AC-06. Example: [academic-intake.json](examples/academic-intake.json).

### AU-18 Edits I make while the agent is thinking are kept — M2
**As the Owner**, I want my own move or note edit to stand even when an agent result arrives later for the same bookmark, so that I always have the last word.

Acceptance:
1. A job records the bookmark revision it read. A result that would change a field edited after that revision is not applied; the job ends as "stale" and the proposal is kept for review where it still makes sense (AC-24).
2. A result from a lease that expired and was reassigned is rejected even if the first agent finishes later (AC-25).
3. A tag addition that does not depend on the edited field may still be applied; the job detail explains what was applied and what was dropped.

Tasks: AW-23, AW-24, AW-25, AW-35, AW-64. Tests: AC-24, AC-25. Example: [academic-intake.json](examples/academic-intake.json).

### AU-19 Agent proposals use the approvals I already have — M2
**As the Owner**, I want automation effects to go through the same plan, approval, version and Undo machinery my agents already use, so that there is one place to look and one set of rules to learn.

Acceptance:
1. Every effect (move, tags, note) is committed as a change plan with cause `automation:<ruleId>:<jobId>`; the collection history shows a version per committed plan, exactly like an agent-organize plan today.
2. If the target's agent has the Manual policy, the plan waits on the Approvals page with the rule and job named; approving applies it under current authority and current revisions. If the agent is Trusted, reversible effects commit immediately with Undo (decision D8 of the product plan) (AC-46).
3. Irreversible operations (delete, visibility) are never produced by automation tasks; the effect gateway refuses to build such a plan.
4. The Approvals page filter "Automation" shows only automation plans.

Tasks: AW-24, AW-25, AW-35, AW-52, AW-56, AW-64. Tests: AC-46, AC-63. Example: [academic-intake.json](examples/academic-intake.json).

### AU-20 No silent fallback to another model or provider — M2
**As the Owner**, I want work to wait when my chosen agent or local key is unavailable, so that my data never goes to a provider I did not approve and I never get a surprise bill.

Acceptance:
1. Each task names exactly one target or executor. When it is unavailable, the job waits; no alternate destination is tried (AC-23).
2. In the extension, losing the local key disables the local tags request; it does not switch to any cloud provider (existing behavior, kept).
3. The rule page shows where data goes for each task: "Research (your agent, runs where you run it)", "Local provider (this browser, endpoint you configured)". Execution location and data destination are shown separately.

Tasks: AW-22, AW-23, AW-48, AW-62. Tests: AC-23. Example: [execution-policy.json](examples/execution-policy.json).

### AU-21 Each agent sees only its own jobs; ordinary agents see nothing new — M2

**Execution constraint:** Worker-only bootstrap exposes pair, then queue list/get/inputs/claim/heartbeat/submit/fail after binding. Manager authority is not a prerequisite. Broad separately granted node tools are not restricted by a job-only allowlist.
**As the Owner**, I want agents I did not enable for automation to keep seeing exactly the bookmark tools they see today, and a worker to see only the jobs for its own target, so that my work and personal workflows never mix and no agent gets a surprise tool list.

Acceptance:
1. An agent without "Can run automation jobs" lists the same tools as before this feature; calling an automation tool by name is refused (AC-17).
2. A worker lists its job tools before any job exists and before any subscription exists (AC-18).
3. With two targets ("Research", "Personal") on two agents, a job routed to Research is never listed to Personal. If both targets share one OAuth client, the Agents page says so: "These two inboxes share one login; they are separate queues, not a security boundary" (AC-19).
4. A worker reads bookmark content only through ordinary read tools under its ordinary scopes; the job grant adds nothing beyond the job itself.

Tasks: AW-02, AW-26, AW-30, AW-31, AW-35, AW-53, AW-64. Tests: AC-17, AC-18, AC-19, AC-60. Example: [mcp-subscribe.json](examples/mcp-subscribe.json).

### AU-22 When the agent is down, saving still works and I can see what is waiting — M2
**As the Owner**, I want placement to keep working when my agent has not run for a week, and a clear list of what is waiting, so that a dead agent never degrades basic bookmarking and I know when to go fix it.

Acceptance:
1. With the enrichment target unavailable, intake placement continues locally and on the server; the rule shows "working, 7 jobs waiting for Research (last seen 6 days ago)" (AC-16).
2. The Automations page has "Needs attention" at the top: blocked rules, waiting jobs older than a day, deleted folders, expired subscriptions, each with a repair action. None of it requires the failing agent (AC-31).
3. Zero matches is not an error. A rule with no matches says "no matching bookmarks in the last 30 days", not "broken".
4. Health signals the operator can read on `/ready` and in logs carry only low-cardinality reason codes, never titles, URLs or folder names.

Tasks: AW-11, AW-34, AW-54, AW-55. Tests: AC-16, AC-31. Example: [academic-bindings.json](examples/academic-bindings.json).

### AU-23 See what automation cost this week, and cap it — M2
**As the Owner**, I want to see how many jobs and model calls my rules caused and to cap them per rule and per day, so that a runaway rule or a big import can never produce a big bill.

Acceptance:
1. Each rule shows runs, jobs and calls for the last 7 and 30 days. For agents, cost is shown as "billed by your agent" (unknown to COLP); for the extension's local provider, calls are counted.
2. A rule has a daily run cap (default 100). Reaching it does not drop bookmarks: they are placed by rule (no model involved) and their tasks queue as "held: daily cap"; the cap and the hold are visible (AC-47).
3. A server-wide daily cap on jobs exists in configuration; reaching it pauses enrichment, not placement.

Tasks: AW-22, AW-34, AW-54, AW-55. Tests: AC-47. Example: [execution-policy.json](examples/execution-policy.json).

### AU-26 Choose how an agent learns about work: woken by events or polling — M2

**Execution constraint:** Official dot support is a candidate integration, not proof of a COLP run. The backend decides readiness; mode selection cannot overcome unreachable transport or missing account/permission support.
**As the Owner**, I want each agent to be woken the moment a job is ready when that is possible, and to fall back to polling when my server cannot be reached, so that summaries arrive in minutes on a public server and automation still works on a home server.

Acceptance:
1. Each target has a wake mode: "Events (the server wakes the agent)" or "Poll (the agent checks on its own schedule)". The Agents page proposes the default from the server origin: events on a public HTTPS origin; poll on `http://127.0.0.1:8080` or a `tls-internal` LAN origin, with the reason stated: "Wake-up needs a server the agent's platform can reach over HTTPS". The Owner can override either way (AC-51).
2. Events mode with a hosted bot (a ChatGPT dot): the Owner creates the target and gets a one-use pairing code; the bot pairs over its MCP connection, then subscribes with MCP Events. The server verifies the callback with a signed challenge and afterwards delivers small signed wake-ups carrying job and run references only. Private destinations, redirects and credential forwarding are refused (AC-34, AC-35). An agent that already authenticates on this server needs no code.
3. A wake-up is not the work: the agent still claims the job and submits a result exactly as a polling agent does. A crash after a 2xx delivery may wake the agent twice; it never produces two effects (AC-36).
4. Poll mode: the target page shows the exact MCP tools and the HTTP work API the agent uses, and asks for the agent's polling interval so the rule page can state expected freshness.
5. Switching a target from poll to events requires the agent to subscribe; until then the target shows "events requested, not yet subscribed" and keeps polling semantics. Switching back cancels pending wake-ups and leaves jobs in place.
6. An expired or revoked subscription appears under Needs attention with "ask Research to reconnect"; placement and polling are unaffected.

Tasks: AW-02, AW-26, AW-27, AW-28, AW-29, AW-32, AW-35, AW-46, AW-53. Tests: AC-34, AC-35, AC-36, AC-51, AC-61, AC-62. Example: [mcp-occurrence.json](examples/mcp-occurrence.json).

---

## D. Batches and run-once (M3)

### AU-24 Every ten new papers, one digest I can actually read — M3

**Execution constraint:** AW-57 implements count aggregation; AW-58 implements output/unread persistence; Web AW-45 and extension AW-60 only render those DTOs.
**As the Owner**, I want one reading digest for each ten papers that enter Academic, so that I am interrupted once, not ten times, and I have a place to read the digest.

Acceptance:
1. A count rule with "every 10" admits distinct bookmarks into a batch; when the tenth arrives, one run is created with exactly those ten members. Two arrivals at once with nine waiting produce one run of ten and one waiting (AC-20).
2. A retried sync delivery, a move, or a restore does not count. Deleting a member after admission leaves a hole that is reported, never refilled (AC-21).
3. The digest text lives on the run's page under Automations › Digests, with the ten bookmarks linked and unavailable ones marked. The Automations page shows an unread count; the extension's badge shows "1 new digest" once. A hosted bot may additionally show the digest in its own chat (AC-48).
4. Renaming the folder mid-batch keeps the batch; changing the destination folder or the count starts a new batch and says so in the preview.

Tasks: AW-05, AW-15, AW-16, AW-29, AW-34, AW-44, AW-45, AW-57, AW-58, AW-60. Tests: AC-20, AC-21, AC-48, AC-65, AC-66. Example: [ten-bookmark-digest.json](examples/ten-bookmark-digest.json).

### AU-25 Run a rule once over bookmarks I already have — M3

**Execution constraint:** Start submits previewId and previewDigest for the immutable selection; expiry, changed options/revisions or more than 1000 members require a fresh/smaller preview.
**As the Owner**, I want to point a rule at a folder I already have (or at a fresh import) and run it once with a preview, so that years of unsorted bookmarks can be organized the same way new ones are.

Acceptance:
1. A rule's page offers "Run once on…" with a folder picker. The preview shows how many bookmarks match, a sample of twenty, and what would happen (placement only, or placement plus tasks), before anything runs (AC-50).
2. Confirming creates one run of kind `manual` with the exact members pinned, capped at 1,000 members per run; larger folders run in pages the Owner starts one at a time.
3. Explicit folder choices are respected the same way as for new saves: bookmarks that already sit in a non-root folder are moved only when the Owner ticks "also move bookmarks already in folders".
4. A run-once run appears in the bookmark's Automation section like any other and can be undone per effect. It never re-runs on its own.
5. This is the documented path for imports and for "Saved while paused" and "missed while blocked" lists.

Tasks: AW-12, AW-16, AW-41, AW-59. Tests: AC-50, AC-64. Example: [academic-intake.json](examples/academic-intake.json).

### AU-27 Pause, resume, replay and undo mean different things — M3
**As the Owner**, I want to pause a rule, resume it later, replay a chosen set of past events on purpose, and undo what a run did, each with a clear and separate meaning, so that I never cause mass processing by accident.

Acceptance:
1. Pause stops new admissions for the rule and holds pending jobs; the partial batch is kept. Resume starts from now with a new fence and does not backfill the paused interval (AC-32).
2. "Run once" (AU-25) is the only way to process past bookmarks in M3; event-time replay from retained facts is a Later capability and is shown as unavailable until then.
3. Undo on a run reverts only effects whose fields were not changed afterwards and lists the ones it left alone (AC-33).

Tasks: AW-15, AW-25, AW-34, AW-44, AW-47, AW-57. Tests: AC-32, AC-33, AC-65. Example: [ten-bookmark-digest.json](examples/ten-bookmark-digest.json).

---

## E. Share the logic (M4)

### AU-28 Install someone's workflow using my own folders — M4
**As the Owner**, I want to install a published paper workflow and bind its roles to my own Research folder and my own agent, so that I reuse the logic without adopting someone else's taxonomy.

Acceptance:
1. Importing a package stores it inert; nothing runs. Installing asks for each declared role (folder, agent, vocabulary) and produces a draft rule with a preview (AC-27).
2. No folder is created on install; a missing optional destination keeps the parent or goes to review as the package declares.
3. Two Owners with unrelated folder names install the same package and get equivalent behavior with their own identities.

Tasks: AW-36, AW-37, AW-61. Tests: AC-27, AC-67. Example: [paper-template.json](examples/paper-template.json).

### AU-29 An upgrade that wants more must ask me — M4
**As the Owner**, I want a template upgrade that adds a task, a destination or broadcasting to show me the difference and ask again, so that I never trust every future change of a publisher.

Acceptance:
1. Upgrading shows a semantic diff: new tasks, new data destinations, new permissions, changed aggregation. Expanded authority requires a new consent (AC-28).
2. In-flight runs stay pinned to the old version; rollback to the previous version is one action and does not replay anything.
3. Export of my installed rule strips my folders, agents, secrets and private examples by default.

Tasks: AW-36, AW-38, AW-61, AW-65. Tests: AC-28. Example: [paper-template.json](examples/paper-template.json).

### AU-30 Several agents give independent takes on one batch — M4
**As the Owner with more than one agent**, I want each agent that opted in to receive its own copy of a batch and write its own analysis, so that I can compare perspectives without the agents fighting over one folder.

Acceptance:
1. A broadcast rule fixes the recipient list when the run is created; each recipient gets its own job and its own append-only result. One recipient failing does not re-notify the others (AC-22).
2. Placement tasks are refused in broadcast mode at validation.
3. A target added later does not receive old private batches.

Tasks: AW-29, AW-42. Tests: AC-22. Example: [broadcast-digest.json](examples/broadcast-digest.json).

### AU-31 Catalog enrichment with my own entity map and vocabulary — M4

**Execution constraint:** The formal example is an institutional research dataset archive: accession ID → evidenced research-group mapping → authorized directory → controlled-vocabulary tags. It is synthetic, restricted and non-broadcast.
**As the Owner of a research catalog collection**, I want a dedicated worker to identify a saved item by its catalog number, fetch permitted text metadata, and file it under the entity folder I mapped with labels from my own vocabulary, so that repetitive metadata work disappears without the system guessing.

Acceptance:
1. The rule binds a private intake folder, a dedicated worker (its own credential), an entity map (entity key → my folder) and a vocabulary (label key → my tag). These are bindings, not product features: the same rule works for books, films or datasets (AC-30).
2. A confirmed single entity is filed and tagged from the map and vocabulary only. Unknown or multiple entities stay in the intake folder under "Needs a decision".
3. Identity is never inferred from images; only text metadata from the sources the worker is allowed to read.
4. The rule is `restricted`: no broadcast, dedicated credential required, and the Agents page shows the isolation status.

Tasks: AW-37, AW-39, AW-61. Tests: AC-30, AC-68. Example: [research-catalog.json](examples/research-catalog.json).

---

## F. Later

### AU-32 A weekly digest at a time I choose — Later
**As the Owner**, I want one non-empty digest every Friday at 18:00 in my timezone, so that collecting turns into a reading habit.

Acceptance:
1. A schedule rule has a five-field cron and an IANA timezone; a missed instant during downtime fires once on recovery (coalesce) or is skipped, as configured; DST gaps and repeats are deterministic (AC-29).
2. A server without the scheduler capability refuses to enable the rule instead of approximating it.

Tasks: AW-40. Tests: AC-29. Example: [weekly-digest.json](examples/weekly-digest.json).

---

## G. Lifecycle (cross-cutting, M1)

### AU-33 Rules are in my backup and my export, and leave with me — M1
**As the Owner**, I want my rules to be part of backup, restore, export and uninstall exactly like my bookmarks, so that automation never becomes the thing that ties me to one installation.

Acceptance:
1. `deploy/backup.sh` includes the automation tables; `deploy/restore.sh` restores them and starts the server with automation paused until the Owner resumes it (AC-52).
2. `colp-server export` and the web Export menu include `automations.json` (rules and folder bindings by path, no agent secrets, no pairing codes).
3. "Disconnect server" in the extension deletes the local rule bundle and local receipts; `docker compose down -v` leaves nothing behind.
4. The CHANGELOG "Upgrade notes" line names the automation migrations and that they are forward-only.

Tasks: AW-01, AW-09, AW-44, AW-63, AW-66. Tests: AC-52, AC-67. Example: [academic-bindings.json](examples/academic-bindings.json).

---

## Worked end-to-end narrative (M2 release proof)

The Owner opens Academic in the web library, chooses "Automate…", adds the condition "site is arxiv.org", previews it against the last 200 bookmarks (three would have matched), and enables it. On the Agents page they turn on "Can run automation jobs" for the ChatGPT dot they connected last week; a target named Research appears with wake mode "Events" proposed, because the server runs on a public HTTPS origin. They copy the pairing code to the dot; it pairs and subscribes, and the target shows "Woken by events, subscription valid until tomorrow". Back in the rule, they add "write a summary into the note" and "add up to three tags" for Research and enable the new revision after a fresh preview.

On the laptop they save an arXiv page with the keyboard shortcut. The bookmark is created directly under Academic; the result panel says "Saved to Academic by rule 'arXiv papers' · summary pending". The extension's local provider is asked for tags only. The desktop browser receives the bookmark under Academic as an ordinary sync change and starts nothing.

Within a minute the dot receives one signed wake-up, lists one ready job for Research, claims it, reads allowlisted inputs with `automation.jobs.inputs`, and submits a summary and three tags. The server applies them through a change plan with cause `automation:…`; the agent is Trusted, so the plan commits and a collection version is saved. Both browsers receive the note and tags. The bookmark's page lists two effects with Undo. The Owner removes one tag by hand; a day later a second attempt (the first lease had expired during a platform outage) is rejected as stale and nothing changes.

On the Owner's second server, which runs on `http://127.0.0.1:8080`, the same rule is installed and the Research target is set to Poll because the page said wake-up is unavailable there. Claude Code's routine runs every 15 minutes, finds the job, and completes it the same way.

The Owner renames Academic to Research Papers; the rule sentence updates and a notice appears. They delete a test folder a second rule pointed at; that rule blocks, the save still works, and the Automations page offers Restore or Choose another. An ordinary agent connected with an API key still lists only the sixteen bookmark tools.

This narrative is the M2 release's principal end-to-end proof. Unit fixtures in this pack do not establish it; capture it against a real browser, a real server database, a real hosted bot on a public origin and a polling agent before release.

## Worked-proof fixture selection

Use academic-summary-only.json when asserting one external job: deterministic root placement is already satisfied and the only worker task is summary.generate. Test tags/refinement with the separate academic-intake.json fixture, which declares three worker tasks and can therefore create three jobs. A retry can repeat an occurrence; a hosted task may group several occurrences. Assert unique accepted effects per job/input/contract, never a one-to-one relation between bookmark, HTTP delivery and ChatGPT run.

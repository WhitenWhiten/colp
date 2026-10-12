/**
 * Static-anchor whitelist for `tests/*.contract.test.ts` (audit A-13 / SR-16).
 *
 * A contract test is allowed to read production source as text **only** when the
 * anchored semantics cannot be observed through an injectable seam:
 *
 *  - *absence* claims — "this module never imports the private COLP subpath",
 *    "this module never logs" — leave no trace in any observable state, so no
 *    behavioural assertion can fail when the forbidden symbol appears;
 *  - *gate* claims — CI job wiring, npm script composition, coverage/size
 *    ratchets, release scanners — the YAML/JSON/mjs configuration *is* the
 *    artifact under test and running it is an e2e action;
 *  - *entry* claims — registration order inside the MV3 entry, or inside a
 *    module-private evidence helper with no exported seam.
 *
 * Everything else must be a behavioural test. `tests/static-anchor-policy.test.ts`
 * enforces that: a contract file that both reads source and makes a text
 * assertion must appear here, and an entry that stops being needed fails the
 * same test.
 */

export type StaticAnchorCategory =
  /** CI job / npm script wiring; the config file is the artifact under test. */
  | 'ci-gate'
  /** Build, packaging and release-scanner wiring. */
  | 'release-artifact'
  /** MV3 service-worker entry registration or module-private helper ordering. */
  | 'mv3-entry'
  /** Cross-module import / privacy / no-logging boundary (mostly absence claims). */
  | 'source-boundary'
  /** Durable storage and protocol schema freeze. */
  | 'schema-pin'
  /** Acceptance-matrix / release-pin documents and evidence-script shape. */
  | 'policy-pin';

export interface StaticAnchorAllowlistEntry {
  /** Path relative to the Known-Extension package root. */
  readonly file: string;
  readonly category: StaticAnchorCategory;
  /** Which semantics the file's text anchors still guard. */
  readonly anchors: string;
  /** Why those semantics cannot be replaced by a behavioural assertion. */
  readonly reason: string;
}

export const STATIC_ANCHOR_ALLOWLIST: readonly StaticAnchorAllowlistEntry[] = Object.freeze([
  {
    file: 'tests/mv3-entry-behavior.contract.test.ts',
    category: 'mv3-entry',
    anchors: 'the popup overflow-menu observer never writes the `hidden` attribute it observes without comparing '
      + 'the current value first',
    reason: 'The observer is module-private bootstrap code in src/popup-header.ts: it is constructed at import time with '
      + 'no exported seam, so no behavioural test in this package can reach it (the package runs vitest in the node '
      + 'environment, and the hazard only manifests as a starved main thread inside a real browser). The guard is '
      + 'text-anchored so a regression fails in milliseconds instead of hanging mv3-popup-save.spec.ts until its '
      + 'test timeout.',
  },
  {
    file: 'tests/bookmark-event-queue.contract.test.ts',
    category: 'source-boundary',
    anchors: 'no console/telemetry/fetch, no restore_node capture path and no sequence derived from Date.now() in '
      + 'the normalizer; the evidence-scope precedence of recoverBookmarkEvents(); the worker ANDs the optional '
      + 'bookmark permission into listenerInstalled; validator codegen from the public COLP schema plus the durable '
      + 'error-code literals; __KNOWN_EXTENSION_EVIDENCE__ false in production builds; and the MV3 e2e spec shape '
      + '(real chrome.bookmarks calls, worker termination, persistent profile)',
    reason: 'Every remaining anchor is either an absence claim (a forbidden import/log/capture path leaves no trace '
      + 'in queue state, so no behavioural assertion can fail when it appears), a module-private composition point, '
      + 'or gate wiring for the packaged MV3 e2e owner. The listener registration, privacy-before-persistence '
      + 'ordering, protocol/byte-budget rejection and quarantine behaviour moved to '
      + 'tests/bookmark-listener-lifecycle.test.ts, tests/bookmark-event-queue.test.ts, '
      + 'tests/bookmark-event-quarantine.test.ts and tests/service-worker-entry-behavior.test.ts.',
  },
  {
    file: 'tests/bookmark-import-plan.contract.test.ts',
    category: 'source-boundary',
    anchors: 'the import plan validates through the generated COLP validators, the plan is timer/network free, the '
      + 'manifest declares no externally_connectable bridge, and the import evidence command scans the production '
      + 'artifact',
    reason: 'This is the cross-module boundary of the import feature: absence of a web credential bridge '
      + '(externally_connectable, postMessage), absence of timers/network inside the pure planner, and the build/'
      + 'evidence wiring. Plan, queue and commit behaviour is covered by tests/bookmark-import-plan.test.ts, '
      + 'tests/import-commit-path.test.ts and tests/options-import-ui.test.ts; what remains is the boundary itself, '
      + 'which no runtime assertion can observe.',
  },
  {
    file: 'tests/bookmark-roots.contract.test.ts',
    category: 'source-boundary',
    anchors: 'Chrome tree access stays in the worker, the public roots protocol stays redacted (no nativeId/url), '
      + 'manifest permission split (required vs optional bookmarks), trusted-gesture-only permission mutation, and '
      + 'the release scanner sentinel list',
    reason: 'Privacy boundaries are negative claims about what does *not* cross a module edge (a leaked nativeId '
      + 'cannot be observed from the redacted public type), and the manifest permission split plus the release '
      + 'scanner are configuration artifacts. Root behaviour is covered by tests/bookmark-roots.test.ts and '
      + 'tests/scope-range.test.ts.',
  },
  {
    file: 'tests/canonical-subpath.contract.test.ts',
    category: 'source-boundary',
    anchors: 'production sources import `@know-n/colp/sync/canonical` instead of a duplicated local '
      + 'browser digest module, and the built MV3 bundle embeds no node:crypto',
    reason: 'Import-path ownership and the absence of a second digest implementation are boundary claims: the goal '
      + 'is that one canonical implementation exists, not that a particular call happens. The bundled-bundle check '
      + 'is a packaging assertion over dist/production. Digest behaviour itself is covered by the pull/effect tests.',
  },
  {
    file: 'tests/chrome-recipe.contract.test.ts',
    category: 'source-boundary',
    anchors: 'the shared button/focus-ring declarations chrome.css mirrors from the web global.css and '
      + 'interactions.css recipes, and the absence of accent-outline focus specializations in popup/options CSS',
    reason: 'Recipe parity is a cross-module text claim: the assertion is that two files on different sides of '
      + 'the extension/frontend boundary carry the same declarations, and "this rule is absent from popup.css" '
      + 'leaves no observable trace in rendered behaviour a unit test could reach without a browser. There is no '
      + 'injectable seam for comparing stylesheet text; the visual result is covered manually per the audit.',
  },
  {
    file: 'tests/durable-sync-engine.contract.test.ts',
    category: 'mv3-entry',
    anchors: 'no private COLP subpath, no raw /colp/v0.x URL and no console logging in the durable engine; the '
      + 'production service worker composes createDurableSyncEngine and recoverVerifiedOrFreeze; the options online '
      + 'bridge; currentSyncStatusAuthority loading config itself; the frozen-before-wake recover/flush branch; the '
      + 'auth refresh/logout routing and the unexported scheduleSyncEngineWakeIfRootConfigured helper; the packaged '
      + 'MV3 evidence gate; the evidence helpers that must not lift recoveryFrozen',
    reason: 'The engine lifecycle itself is behavioural (tests/durable-sync-engine.test.ts, '
      + '-payload-budget, tests/transport-budget.test.ts, tests/engine-public-stability.test.ts) and the entry '
      + 'registration/alarm/wake wiring moved to tests/service-worker-entry-behavior.test.ts and '
      + 'tests/sync-engine-wake-behavior.test.ts. What stays is the *absence* of forbidden imports/logging, the '
      + 'production composition point, module-private helpers of src/sw/evidence.ts (unfreezing only ever prevents '
      + 'a failure, so it is unobservable from a passing run) and the e2e evidence gate.',
  },
  {
    file: 'tests/import-preview.contract.test.ts',
    category: 'source-boundary',
    anchors: 'the import preview uses parse5 and the generated validators, never DOM/HTML injection or eval, never '
      + 'touches the network/queue/indexedDB, and ships through the standalone adapter build + evidence command',
    reason: 'The bounded-parser guarantees are absence claims about the module surface (no DOMParser/innerHTML/'
      + 'fetch/queue import), and the adapter build/evidence wiring is packaging. Parse, budget, duplicate, format '
      + 'and byte-before-parse behaviour is behavioural in tests/import-preview.test.ts and '
      + 'tests/import-preview-cache.test.ts.',
  },
  {
    file: 'tests/kns-08-acceptance-matrix.contract.test.ts',
    category: 'policy-pin',
    anchors: 'the KNS-08 acceptance matrix covers AC-01..09 for every KNS owner, each referenced spec carries its '
      + 'Owner/Fixture/Run/Evidence header and no skip/quarantine marker, evidence scripts keep the with-postgres / '
      + 'xvfb / verify-release-artifact shape, and the first-run/trash-restore specs pin the product winners',
    reason: 'The artifact under test is the acceptance map plus the e2e specs and their evidence commands; the specs '
      + 'themselves cannot be executed in the host unit lane (e2e is forbidden there), so text is the only available '
      + 'check that the matrix still points at product-winning assertions and never at disabled tests.',
  },
  {
    file: 'tests/kns-09-release.contract.test.ts',
    category: 'policy-pin',
    anchors: 'release gate jobs (typecheck/lint/source-size/COLP/backend/KNS-09 e2e), schema version 15 pin in code '
      + 'and runbook, refusal of v9 rollback, receipt/manifest gates consuming machine results',
    reason: 'A release gate is a configuration contract: the npm scripts, workflow jobs and runbook text are the '
      + 'artifacts under test, and the receipt/manifest scripts are consumed by CI rather than by an importable '
      + 'runtime entry. Schema behaviour is separately covered by tests/schema-v15.test.ts and '
      + 'tests/kns-09-release.test.ts.',
  },
  {
    file: 'tests/outbound-push-worker.contract.test.ts',
    category: 'mv3-entry',
    anchors: 'no sensitive logging, no parallel fetch, no unbounded retry loop in the push worker; the settlement '
      + 'envelope never re-binds a rotated Session; the packaged MV3 push evidence gate',
    reason: 'The first half of this file is a real IndexedDB behaviour suite (claim/settle/receipt semantics) and '
      + 'the push envelope, retry, classifier and refusal routing are behavioural in '
      + 'tests/outbound-push-worker.test.ts and tests/outbound-push-authority-refusal.test.ts. Retained: absence '
      + 'claims (logging, concurrent fetch, while(true), stale Session rebind) that no passing run can reveal, plus '
      + 'the e2e evidence gate.',
  },
  {
    file: 'tests/pull-applier.contract.test.ts',
    category: 'source-boundary',
    anchors: 'the pull facade stays a small acyclic facade over the page stager and apply runtime, COLP 0.2 / '
      + 'Manifest-discovered page markers, the full native mutation surface, no event suppression, and the packaged '
      + 'MV3 pull evidence command',
    reason: 'Facade size/acyclicity (line budget, no stager→runtime import) and "no suppression of browser events" '
      + 'are structural absence claims; the packaged evidence command is gate wiring. Apply behaviour is covered by '
      + 'tests/pull-applier.test.ts, tests/pull-apply-integrity.test.ts, tests/pull-page-stager.test.ts and '
      + 'tests/pull-mapping-lifecycle.test.ts.',
  },
  {
    file: 'tests/source-file-size-gate.contract.test.ts',
    category: 'ci-gate',
    anchors: 'the 600-line new-file limit, and `check:source-size` being part of the static CI job',
    reason: 'The gate script and its CI invocation are the artifacts under test; the third case already runs the '
      + 'real evaluator over the live src tree, so only the wiring and the frozen limit live in text.',
  },
  {
    file: 'tests/sync-coverage-ratchet.contract.test.ts',
    category: 'ci-gate',
    anchors: 'per-file coverage floors for Pull/New/core owners, the ratchet evaluator rejecting a missing or '
      + 'regressed listed file, and the V8 coverage config + named CI job wiring',
    reason: 'Coverage floors and the include list only exist as configuration consumed by the coverage runner; the '
      + 'evaluator itself is executed for real by the other cases in this file, so the text part is the CI wiring '
      + 'and the frozen baseline keys.',
  },
  {
    file: 'tests/sync-named-ci-jobs.contract.test.ts',
    category: 'ci-gate',
    anchors: 'the real-stack owner job content, `test:sync-real-stack` / `test:sync-budget-contract` script bodies, '
      + 'the four critical MV3 specs inside `evidence:critical-mv3`, and the multi-device recovery spec staying out '
      + 'of the default gate',
    reason: 'Workflow YAML and npm scripts are the artifacts under test; verifying them by execution would mean '
      + 'running the e2e/evidence commands, which is explicitly out of the host unit lane.',
  },
  {
    file: 'tests/sync-state-store.contract.test.ts',
    category: 'schema-pin',
    anchors: 'database identity and version 15, every object store and compound index name, the documented '
      + 'single-authority-per-durable-fact table and atomic store combinations, and the store being part of the '
      + 'production build / release scan',
    reason: 'This is a storage-format freeze: the durable schema and its authority document are the artifact under '
      + 'test, and the point of the pin is that the names/version do not drift. Behaviour over that schema is '
      + 'covered by tests/sync-state-store.test.ts, tests/sync-state-store-indexes.test.ts, '
      + 'tests/sync-state-store.atomic.test.ts and tests/schema-v15.test.ts.',
  },
]);

/**
 * Source-reading helpers are not contract files, so they are not gated by the
 * policy test; they are listed here so their purpose stays explicit and a new
 * helper must be registered deliberately.
 */
export const SOURCE_READER_HELPERS: readonly { readonly file: string; readonly purpose: string }[] =
  Object.freeze([
    {
      file: 'tests/service-worker-graph.ts',
      purpose: 'Concatenates src/service-worker.ts with every src/sw/*.ts so the static anchors listed above can '
        + 'see the whole worker graph. Not itself an assertion; behavioural entry coverage lives in '
        + 'tests/service-worker-entry-behavior.test.ts.',
    },
    {
      file: 'tests/read-sync-state-source.ts',
      purpose: 'Concatenates src/sync-state-store.ts with src/sync-state/*.ts for the frozen storage-schema anchors '
        + 'in tests/sync-state-store.contract.test.ts. Not itself an assertion; store behaviour lives in '
        + 'tests/sync-state-store*.test.ts.',
    },
  ]);

export function staticAnchorAllowlistFiles(): readonly string[] {
  return STATIC_ANCHOR_ALLOWLIST.map((entry) => entry.file);
}

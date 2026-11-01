# MCP Context Optimization Follow-up Acceptance

Review baseline: `05a89d7d`. Implementation: `32bb910d`. Plan: [MCP context optimization](../mcp-context-optimization-plan.md). The initial implementation and headless-review records remain historical evidence; this report describes the corrections and their additional verification.

Both reported rule-authoring defects are repaired. Deterministic repository verification now includes first-use rule creation over both MCP transports and a native Chromium browser-rule execution chain. Actual model loading and long-session model performance remain unverified because no configurable target model host or model API credentials are available. No model calls were made in this follow-up. Compact entry conditions still have not been established.

## Changes

- `rule-authoring` now includes `collections.get_snapshot` and optional `nodes.search`. Its explicit membership grows from 21 to 23 IDs. This admits two additional standard reads within existing catalog and scope authorization; it grants no scopes. Snapshot pagination provides a fallback when search is absent or unauthorized. Other task sets and Worker membership are unchanged.
- Capability descriptions and input-provenance metadata explain the transition from `rules.preview.previewId` to `rules.set_state.change.activationPreviewId`, the current rule revision, and the need for another preview after relevant state changes. Pausing and archiving do not require an activation preview. Input schemas, approval requirements and business validation remain unchanged.
- `collections.list` effect metadata now acknowledges that the production service can initialize an account's library. A read-like name is not treated as proof that the operation never writes business state.
- The existing strict/compat wire regression now uses default output limits. Its prior enlarged fixture limits are no longer necessary.
- The operating guide documents folder discovery, pagination, optional search and activation. The source generator still validates explicit helper IDs and regenerates deterministic, self-contained contracts and digests.

## First-use Rule Authoring

[The new PostgreSQL regression](../../../packages/server/tests/integration/automation/task-rule-authoring.integration.test.ts) runs separately over strict and compat HTTP routes. It begins with owned folders and bookmarks but no rules or binding sets. More than 200 earlier nodes force the destination onto a later snapshot page.

The test discovers the collection through `collections.list`, follows `page.nextCursor`, finds the destination by title and kind, and passes the discovered ID to `automation.bindings.save`. It then validates and saves a rule. Enabling without an activation preview is rejected. Updating the binding revision after preview also rejects activation. A fresh preview enables the rule, and exact command replay returns the same result. Removing the task selection rejects subsequent snapshot calls.

The test uses real PostgreSQL collection reads, production MCP read adapters, both transport routes, the Automation unit of work, previews and command receipts. Its OAuth verifier supplies a synthetic admitted identity; persisted credential/profile behavior remains covered by the existing catalog integration suite. No private folder ID or prebuilt binding is injected into the authoring calls.

The initial test incorrectly expected a folder rename to invalidate the preview. Folder bindings intentionally follow identity, so that expectation was replaced with a real binding-revision update. The compat transport preserves the business error's safe message rather than the strict stable-code envelope; the assertion now checks the supported wire behavior. Neither change relaxes business validation.

## Native Browser Chain

[The new browser integration](../../../packages/server/tests/integration/automation/task-browser-rules.integration.test.ts), run under xvfb, uses a disposable Chromium profile and [a test-only extension](../../../packages/server/tests/support/native-browser-rule-bridge.ts) bundling the production browser-rule handler, device runner, IndexedDB journal and bookmark guards. Chrome bookmark and storage APIs are real; they are not replaced with an in-memory bookmark mock.

A selected `browser-rules` MCP facade queues requests in the real PostgreSQL device bridge. The test driver fetches those requests through authenticated device HTTP routes, forwards them into Chromium, posts the actual browser result back through the completion route, and polls the MCP result. The assertions cover:

1. Read the current rule revision and discover the destination through the browser-folder operation.
2. Configure a rule with that revision and destination.
3. Preview without moving bookmarks.
4. Apply the reviewed preview and observe the native bookmark move.
5. Replay the same server command and browser request without a duplicate run or move.
6. Undo the run and verify original bookmark order and an empty destination.
7. Remove the task selection and reject another apply call.

This is an integrated server/production-handler/native-browser test. The test driver carries the device messages; it does not test the installed extension's sign-in, consent UI, scheduled polling or a model's tool selection. Those boundaries are not claimed as verified by this test. The existing transport and credential suites cover their respective server boundaries independently.

The browser test is explicitly skipped without DISPLAY. Run the xvfb command below for acceptance; a database-only invocation that skips it is not browser evidence. No new runtime debug endpoint or test hook is shipped in the production extension.

## Catalog Measurements

The rule-authoring regression captures actual strict and compat `tools/list` responses for the same synthetic Manager and scopes: `mcp:read:own`, `automation:read`, `automation:manage`, `nodes:write`. The mounted standard surface contains all three core read tools plus `collections.list`; optional search and standard writes are not installed in this fixture. The application mounts the actual PostgreSQL read ports, rather than a single standard sentinel. All rows use default host output limits.

Values are UTF-8 bytes of compact JSON objects containing `name`, `description` and `inputSchema`. They are not token usage or model-loaded context.

| Selection | Tools | Strict bytes | Strict reduction | Compat bytes |
| --- | ---: | ---: | ---: | ---: |
| Omitted | 85 | 100910 | Baseline | 100811 |
| recovery | 6 | 3651 | 96.38% | 3618 |
| rule-authoring | 22 | 41960 | 58.42% | 41861 |
| sync-diagnostics | 8 | 3214 | 96.81% | 3148 |
| browser-rules | 11 | 9686 | 90.40% | 9686 |

The recovery and synchronization catalog-size goals pass for this configuration. Rule authoring retains the required schemas and discovery tools rather than removing capabilities to hit a percentage. The deployed user's exact catalog remains configuration dependent and unmeasured.

Final static Automation-only input/full UTF-8 bytes are 108571/289690 for all 90 tools, 98995/251195 for the 81 Manager tools, and 9577/38496 for the 9 Worker tools. The 18 selected Automation rule-authoring definitions use 40045 input bytes; standard helpers are additional. No schema constraints or results were truncated to obtain these measurements.

## Model Experiments and Cost Control

This follow-up made zero model-backed test or review calls and incurred USD 0 in additional model API charges. All additional validation is deterministic, including the native-browser test. No premium model or fallback was used.

The earlier headless audit's unknown usage and failed limits cannot be reconstructed or retroactively marked passed. Keep that historical A18 failure in the [initial report](mcp-context-optimization.md) and [headless record](mcp-context-optimization-headless-review.md). In particular, a CLI context-window setting, a command-start monitor and an API-equivalent estimate are not enforceable aggregate billing controls.

Do not rerun that headless procedure as a performance or budget acceptance test. Any future model experiment remains blocked until the actual host can select an inexpensive compatible model, account for the entire rendered input including tools/history, enforce request/output bounds before dispatch, and expose usage or a conservative billable bound for every attempt, including errors and interruptions. Reserve the worst-case permitted cost before each request; an unknown prior charge must not be treated as zero or retried automatically. The plan's USD 2 aggregate cap and prohibition on premium fallback remain in force. No replacement model host or unused public experiment gateway was built to fabricate missing evidence.

A12 remains an external verification gap. Server catalog measurements, source audits and browser correctness tests cannot substitute for per-turn loading, token usage, duplicate-result transmission, latency and long-session measurements in the actual inexpensive-model host.

## Acceptance Status

| Plan IDs | Follow-up status |
| --- | --- |
| A01 | Local static and authorized wire measurements reproduced for both transports, now with the full mounted standard read surface. Deployed-host observations remain external. |
| A02, A09 | Descriptions, activation input provenance, helper references, effects and generated versions checked; generated drift and metadata tests pass. |
| A03, A04, A06, A07 | Catalog integration and wire enforcement regressions pass, including revocation, combined roles, selection changes and shared/separate authorization bindings. No new chat-session assumptions were introduced. |
| A05 | The missing first-use folder-discovery chain is repaired and tested over strict/compat. Native browser configure/preview/apply/replay/undo is now exercised through the durable bridge. Installed-host/model orchestration remains outside these fixtures. |
| A08, A10 | Existing Worker and approval implementations are unchanged. The preceding independent review passed their targeted lifecycle/approval tests; current catalog regressions preserve the combined-role fences. The new tests add real activation receipts and native browser replay evidence. |
| A11 | Automation generation, SDK pins, OpenAPI Automation synchronization, server types and changed-file lint pass. No configuration DTO or package tarball change is required for these corrections. |
| A12 | Not run: actual model host and observable inexpensive-model loading are unavailable. |
| A13-A17 | Not applicable: compact entry conditions remain unmet; no gateway was implemented. |
| A18 | This follow-up is a zero-model-call run. The initial failed control and unknown historical aggregate cost remain recorded; future model calls require the preconditions above. |

## Reproduction and Results

Run from the repository root. Install the existing server and extension development dependencies and the Playwright Chromium runtime first. No model credentials are needed.

```sh
npm --prefix packages/server run check:automation-tools
npm --prefix packages/node run check:automation
node scripts/check-sdk-pins.mjs
npm --prefix packages/server run openapi:automation
npm --prefix packages/server run typecheck
npm --prefix packages/server run test:unit -- tests/unit/phase4b/mcp-task-selection-wire.test.ts tests/unit/automation/capability-metadata.test.ts tests/unit/automation/browser-rule-catalog.test.ts --disableConsoleIntercept
xvfb-run -a npm --prefix packages/server run test:integration:file -- tests/integration/automation/task-rule-authoring.integration.test.ts --disableConsoleIntercept
xvfb-run -a npm --prefix packages/server run test:integration:file -- tests/integration/automation/tool-catalog.integration.test.ts tests/integration/automation/task-browser-rules.integration.test.ts --disableConsoleIntercept
node packages/server/scripts/measure-mcp-context.mjs --static
git diff --check
```

The focused unit run passed 5 tests. First-use rule authoring passed both transport cases. The final combined catalog/native-browser run passed 7 tests, including the native Chromium case rather than a skip. This is 14 distinct focused passing tests for the correction; earlier successful audit runs are documented separately and are not counted again. Changed TypeScript files passed targeted ESLint. Generation, SDK pins, server typecheck and OpenAPI Automation synchronization passed.

All disposable apps, database containers, Chromium processes and temporary extension/profile directories were closed or removed. No development server was left running. No push, deployment or publication was performed.

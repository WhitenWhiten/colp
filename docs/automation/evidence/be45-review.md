# BE-4 / BE-5 close-out checks and execution evidence

Baseline `490428a`, worktree `/home/whiten/known/colp-wt/automation`, branch
`feat/colp-automation`. AW-02 uses existing evidence; AW-27, 28, 29, 44, 46, 41, 57 and 58
each have their own commit, see the [status table](../status.md). This round did not access real dot, did not change the remote spike,
did not publish a service and did not change the Web/extension runtime.

## Problems fixed during the cross-check

- A real MCP HTTP call exposed local `$defs` being wrongly treated as core COLP definitions; fixed the resolution of the closed
  schema and passed the existing canonical-schema regression. Earlier direct service calls cannot replace this evidence.
- When a callback has already returned 410/413 or 2xx, the receiver's response body does not take part in the delivery decision. The bounded
  body is read only for challenge verification, so an oversized body cannot turn a terminating response into a retry. Each send still re-signs the original durable bytes.
- When work was already claimed before the callback returned, the success receipt is still recorded as accepted; revocation, pause, subscription
  generation and current authority are still checked. A background stop no longer starts the remaining network attempts of the round.
- Subscription refresh updates the authenticated, bearer-free credential observation; the database directly caps refreshBefore
  before credential expiry, avoiding small drift from taking the time twice in application and database. An expiring credential must be refreshed first.
- Events discovery, worker, capability DTO, health checks and accepted counts all respect the installation state / feature flags.
  When disabled they report unavailable/null; the accepted count is not the number of completed tasks.
- Command replay of run-once and mark-read re-checks current Owner/source authority, so an old success receipt
  cannot bypass revocation. With runtime off, an old manual preview cannot be started. Historical capacity errors are rejected explicitly.
- A verified device receipt may arrive after the canonical source cursor; bounded completion records are now looked up from durable intake effects
  and deduplicated with a separate stage receipt. Counting does not rescan current bookmarks.
- Known server-only digest/review count rules have no browser intake part and are not put into the browser
  bundle; complete supported M1 intake is still emitted and other unsupported rules are still rejected, without silent degradation.
- Output order and the read watermark keep database microsecond precision; a new output cannot fall behind an old watermark through clock repetition or rollback.
- New modules import through the public facade; only the explicit Automation→hardened-egress and route-registration dependencies were added.
  The module-level import rules were not relaxed.

## Actual verification

All backend E2E ran on Node 22 + `xvfb-run -a`; PostgreSQL was created and reclaimed in isolation by the test tooling.
Only this round's features and the existing paths they affect were run. Rounds overlap; repeated runs below are not added up as new cases.

| Check | Result |
| --- | --- |
| 10-file cross integration (Events, manual, count, output, existing polling/preview/usage) | 45 cases; 43 passed, 2 exposed a fixture returning the draft from creation instead of the enabled state; after fixing the fixture the 4 existing preview cases passed |
| Targeted regression after the fixes, including fresh/upgrade/real pg_dump/pg_restore | 24 cases; 22 passed, 2 new permission tests' soft-delete fixture violated collection/root/children constraints; changed to delete the full tree in one transaction and re-tested successfully |
| Final manual/output/bundle/late-device combination | 4 files, all 9 passed, 80.00 seconds |
| Two-target routing, expired key clearing, stable resubscription | 1 new case passed; a shared credential is not described as two isolated identities |
| OAuth refresh observation and deadline | 1 new case passed; the first regression caught a deadline about 14ms past the credential, fixed with a database LEAST and asserted with zero tolerance |
| Targeted re-test of output microsecond precision | The original output pagination / late unread / command-replay authorization cases passed |
| Related server unit tests (webhook/config/admission/evaluation/preview) | 26 passed |
| Node Events / canonical schema closure / Automation schema | 45 passed |
| Build and boundaries | server build (including migration compilation), typecheck, check:imports, OpenAPI/Automation drift, ordering of 5 new migrations, git diff --check passed |
| Local package | Node build/pack, server vendor and npm 10 runtime manifest refreshed; nothing published to npm |

The integrations above cover **56 distinct cases** in total, re-tested in targeted runs per problem found; there is no claim of a single
one-shot 56/56 command log. AW-44 separately records 500,000 evaluations and bounded queue load measurements, not treated as a production SLA.

Main reproduction entry:

```sh
# Node 22/npm 10
xvfb-run -a npm --prefix packages/server run test:integration:file -- \
  tests/integration/automation/events-subscriptions.integration.test.ts \
  tests/integration/automation/events-delivery.integration.test.ts \
  tests/integration/automation/events-retention.integration.test.ts \
  tests/integration/automation/events-lifecycle.integration.test.ts \
  tests/integration/automation/run-once.integration.test.ts \
  tests/integration/automation/count-batch.integration.test.ts \
  tests/integration/automation/count-batch-device.integration.test.ts \
  tests/integration/automation/run-outputs.integration.test.ts \
  tests/integration/automation/worker-pipeline.integration.test.ts \
  tests/integration/automation/worker-preview.integration.test.ts \
  tests/integration/automation/usage-read-model.integration.test.ts \
  tests/integration/automation/persistence.integration.test.ts \
  tests/integration/automation/bundles.integration.test.ts
```

The late-device case uses real Sync/session/receipt verification, with the executor an explicitly labelled storage fixture;
real worker pairing / MCP / effect evidence comes from other integration cases, keeping evidence types separate.

Real dot account isolation, platform rescan, host burst behaviour and the real hosted full lifecycle remain external acceptance per
[AW-46](aw-46.md). All temporary test services of this round were closed; the existing remote spike was untouched.

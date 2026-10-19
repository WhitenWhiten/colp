# Module and File Map

**Version:** 0.2.1-design. Generated from [tasks.json](tasks.json) by `validation/build-docs.py`: every file a packet creates or modifies, with the packet and milestone. Paths under `Known-Extension/` are in the private Know-N repository (EXTENSION_REPO); server/shared/Web paths are in COLP_REPO. State is a recorded baseline claim or verifyAtAW01; absence of a local checkout during documentation generation must never be reported as proof a file is new. Migration prefixes are placeholders resolved at merge time (data model §0).

## Files by repository

### Know-N (private)

| Path | Packets | Milestones | State |
|---|---|---|---|
| `Known-Extension/e2e/automation.spec.ts` | AW-56 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `Known-Extension/package-lock.json` | AW-49 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `Known-Extension/src/automation/binding-projector.ts` | AW-49 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `Known-Extension/src/automation/bundle-store.ts` | AW-49 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `Known-Extension/src/automation/causation.ts` | AW-20 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `Known-Extension/src/automation/executors/browser-classifier.ts` | AW-62 | Later | verify at AW-01 (not inferred from reviewer filesystem) |
| `Known-Extension/src/automation/indexeddb-store.ts` | AW-21 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `Known-Extension/src/automation/model-consent.ts` | AW-62 | Later | verify at AW-01 (not inferred from reviewer filesystem) |
| `Known-Extension/src/automation/observed-create.ts` | AW-20 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `Known-Extension/src/automation/pre-save.ts` | AW-19 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `Known-Extension/src/automation/receipt-sync.ts` | AW-50 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `Known-Extension/src/automation/recovery.ts` | AW-21 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `Known-Extension/src/automation/runtime-profile.ts` | AW-49 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `Known-Extension/src/automation/status-ui.ts` | AW-54, AW-60 | M2, M3 | verify at AW-01 (not inferred from reviewer filesystem) |
| `Known-Extension/src/bookmark-event-ingress.ts` | AW-20 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `Known-Extension/src/capture/contracts.ts` | AW-19 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `Known-Extension/src/classification-intent.ts` | AW-19 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `Known-Extension/src/popup-classification.ts` | AW-19 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `Known-Extension/src/save-status.ts` | AW-19 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `Known-Extension/src/service-worker.ts` | AW-21 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `Known-Extension/src/sw/capture.ts` | AW-19 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |

### colp (public)

| Path | Packets | Milestones | State |
|---|---|---|---|
| `deploy/backup.sh` | AW-09 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `deploy/restore.sh` | AW-09 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `docs/automation/README.md` | AW-01 | M0 | verify at AW-01 (not inferred from reviewer filesystem) |
| `docs/automation/agents.md` | AW-32 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `docs/automation/evidence/events-lifecycle.md` | AW-46 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `docs/automation/evidence/events-spike.md` | AW-02 | M0 | verify at AW-01 (not inferred from reviewer filesystem) |
| `docs/automation/m1-release-evidence.md` | AW-63 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `docs/automation/release-evidence.md` | AW-35 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `examples/worker-script/claim-and-summarize.mjs` | AW-32 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/extension/_locales/en/messages.json` | AW-68 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/extension/_locales/zh_CN/messages.json` | AW-68 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/extension/e2e/mv3-browser-rule-list.spec.ts` | AW-73 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/extension/e2e/mv3-browser-rule-run-once.spec.ts` | AW-73 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/extension/e2e/mv3-browser-rules.spec.ts` | AW-68 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/extension/options.css` | AW-68 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/extension/options.html` | AW-68 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/extension/scripts/generate-public-suffix.mjs` | AW-73 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/extension/scripts/shots-stub.mjs` | AW-68 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/extension/src/automation/browser-overlap.ts` | AW-69 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/extension/src/automation/browser-rule-store.ts` | AW-67, AW-73 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/extension/src/automation/browser-rules-pane.ts` | AW-68, AW-69, AW-71 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/extension/src/automation/browser-rules.ts` | AW-67, AW-71, AW-73 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/extension/src/automation/indexeddb-store.ts` | AW-72 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/extension/src/automation/messages.ts` | AW-67, AW-73 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/extension/src/automation/options-pane.ts` | AW-68, AW-73 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/extension/src/automation/pre-save.ts` | AW-67 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/extension/src/automation/public-suffix.ts` | AW-73 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/extension/src/automation/rule-conditions.ts` | AW-73 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/extension/src/automation/rule-editor-dialog.ts` | AW-73 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/extension/src/automation/rule-list-decide.ts` | AW-73 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/extension/src/automation/rule-list-flatten.ts` | AW-73 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/extension/src/automation/rule-list-pane.ts` | AW-73 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/extension/src/automation/rule-list-store.ts` | AW-73 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/extension/src/automation/rule-preview-pane.ts` | AW-73 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/extension/src/automation/rule-preview.ts` | AW-73 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/extension/src/automation/rule-set-dialog.ts` | AW-73 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/extension/src/automation/rules-config-format.ts` | AW-73 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/extension/src/automation/rules-config-pane.ts` | AW-73 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/extension/src/automation/run-once-pane.ts` | AW-73 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/extension/src/automation/run-once.ts` | AW-73 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/extension/src/automation/runtime-profile.ts` | AW-67 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/extension/src/capture/contracts.ts` | AW-67, AW-73 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/extension/src/sw/auth.ts` | AW-72 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/extension/src/sw/automation-browser.ts` | AW-67, AW-69, AW-71, AW-73 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/extension/src/sw/automation-config.ts` | AW-73 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/extension/src/sw/automation-run.ts` | AW-73 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/extension/src/sw/automation.ts` | AW-67, AW-71, AW-72 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/extension/src/sw/capture.ts` | AW-67 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/extension/tests/automation-browser-move.test.ts` | AW-71 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/extension/tests/automation-browser-overlap.test.ts` | AW-69 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/extension/tests/automation-browser-pane.test.ts` | AW-68 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/extension/tests/automation-browser-rules.test.ts` | AW-67 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/extension/tests/automation-disconnect.test.ts` | AW-72 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/extension/tests/automation-rule-list-decide.test.ts` | AW-73 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/extension/tests/automation-rule-list-store.test.ts` | AW-73 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/extension/tests/automation-rule-preview.test.ts` | AW-73 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/extension/tests/automation-rules-config.test.ts` | AW-73 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/extension/tests/automation-run-once.test.ts` | AW-73 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/extension/tests/automation-worker-browser-rules.test.ts` | AW-67 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/node/docs/API.md` | AW-04 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/node/docs/AUTOMATION_BROWSER_PROFILE.md` | AW-03 | M0 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/node/docs/MCP_SDK_POLICY.md` | AW-27 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/node/package.json` | AW-04 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/node/src/automation/arbitrate.ts` | AW-07 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/node/src/automation/compile.ts` | AW-06 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/node/src/automation/entity-map.ts` | AW-61 | M4 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/node/src/automation/fingerprint.ts` | AW-05 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/node/src/automation/index.ts` | AW-04 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/node/src/automation/normalize.ts` | AW-05 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/node/src/automation/predicate.ts` | AW-06 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/node/src/automation/schema.ts` | AW-04 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/node/src/automation/semantic-diff.ts` | AW-61 | M4 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/node/src/automation/task-contracts.ts` | AW-07 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/node/src/automation/template.ts` | AW-61 | M4 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/node/src/automation/types.ts` | AW-04 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/node/src/automation/validate-graph.ts` | AW-07 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/node/src/mcp/2026-07-28/events-schema.ts` | AW-27 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/node/src/mcp/2026-07-28/events.ts` | AW-27 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/node/src/shared/mcp-sdk-boundary.ts` | AW-27 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/node/tests/automation/normalization.test.ts` | AW-05 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/node/tests/automation/predicate.test.ts` | AW-06 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/node/tests/mcp/automation-events-contract.test.ts` | AW-02 | M0 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/migrations/<monotonic-prefix-after-current-head>_automation_configuration.ts` | AW-09 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/migrations/<monotonic-prefix-after-current-head>_automation_m2_deliveries.ts` | AW-29 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/migrations/<monotonic-prefix-after-current-head>_automation_m2_policy_and_attempts.ts` | AW-22 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/migrations/<monotonic-prefix-after-current-head>_automation_m2_subscriptions.ts` | AW-27 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/migrations/<monotonic-prefix-after-current-head>_automation_m2_targets_and_profiles.ts` | AW-26 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/migrations/<monotonic-prefix-after-current-head>_automation_m3_batches.ts` | AW-57 | M3 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/migrations/<monotonic-prefix-after-current-head>_automation_m3_outputs.ts` | AW-58 | M3 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/migrations/<monotonic-prefix-after-current-head>_automation_m4_entity_maps.ts` | AW-39 | M4 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/migrations/<monotonic-prefix-after-current-head>_automation_m4_templates.ts` | AW-36 | M4 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/migrations/<monotonic-prefix-after-current-head>_automation_runtime.ts` | AW-09 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/openapi/fragments/automations.yaml` | AW-10 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/infrastructure/automation/aggregate-store.ts` | AW-15, AW-57 | M1, M3 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/infrastructure/automation/cel-evaluator.ts` | AW-43 | M4 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/infrastructure/automation/database-types.ts` | AW-09 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/infrastructure/automation/delivery-worker.ts` | AW-29 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/infrastructure/automation/executors/server-model.ts` | AW-48 | Later | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/infrastructure/automation/fact-capture.ts` | AW-13 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/infrastructure/automation/health-worker.ts` | AW-11 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/infrastructure/automation/job-store.ts` | AW-16 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/infrastructure/automation/lease-store.ts` | AW-23 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/infrastructure/automation/restore-revalidation.ts` | AW-44 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/infrastructure/automation/retention-worker.ts` | AW-44 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/infrastructure/automation/schedule-store.ts` | AW-40 | Later | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/infrastructure/automation/source-position-store.ts` | AW-14 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/infrastructure/automation/webhook-signer.ts` | AW-28 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/infrastructure/automation/webhook-verifier.ts` | AW-28 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/infrastructure/outbox/automation-ingest.ts` | AW-14 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/infrastructure/outbox/router.ts` | AW-14 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/infrastructure/telemetry/automation-metrics.ts` | AW-55 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/accept-intake-receipt.ts` | AW-17 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/admit-event.ts` | AW-15 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/approval-service.ts` | AW-25 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/claim-job.ts` | AW-23 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/compile-bundle.ts` | AW-18 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/count-batch.ts` | AW-57 | M3 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/dependency-index.ts` | AW-08 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/effect-gateway.ts` | AW-24 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/executor-policy.ts` | AW-22 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/health-service.ts` | AW-11 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/job-planner.ts` | AW-16 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/metadata-proposal.ts` | AW-39 | M4 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/placement-history.ts` | AW-51 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/placement-undo.ts` | AW-51 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/preview-service.ts` | AW-10 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/replay-service.ts` | AW-47 | Later | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/resolve-bindings.ts` | AW-08 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/result-reuse.ts` | AW-22 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/route-run.ts` | AW-29, AW-42 | M2, M4 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/rule-service.ts` | AW-10 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/run-once-service.ts` | AW-41 | M3 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/run-output-service.ts` | AW-58 | M3 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/run-service.ts` | AW-16 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/scheduler.ts` | AW-40 | Later | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/server-intake.ts` | AW-33 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/submit-result.ts` | AW-24 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/target-service.ts` | AW-26 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/template-service.ts` | AW-36 | M4 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/template-upgrade.ts` | AW-38 | M4 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/undo-service.ts` | AW-25 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/domain/bindings.ts` | AW-08 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/collections/application/canonical-mutation.ts` | AW-13 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/mcp/application-catalog.ts` | AW-30 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/mcp/application-context.ts` | AW-30 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/mcp/application-facade.ts` | AW-31 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/mcp/automation-catalog.ts` | AW-30 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/mcp/automation-tools.ts` | AW-31 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/mcp/events-adapter.ts` | AW-27 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/transport/automation-device-routes.ts` | AW-17, AW-18 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/transport/automation-work-routes.ts` | AW-23, AW-31 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/transport/product/automation-binding-routes.ts` | AW-10 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/transport/product/automation-delivery-routes.ts` | AW-29 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/transport/product/automation-output-routes.ts` | AW-58 | M3 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/transport/product/automation-policy-routes.ts` | AW-22 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/transport/product/automation-rule-routes.ts` | AW-10, AW-41 | M1, M3 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/transport/product/automation-run-routes.ts` | AW-16 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/transport/product/automation-target-routes.ts` | AW-26 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/transport/product/automation-template-routes.ts` | AW-36 | M4 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/tests/integration/automation/count-batch.test.ts` | AW-57 | M3 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/tests/integration/automation/end-to-end.test.ts` | AW-64 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/tests/integration/automation/events-lifecycle.test.ts` | AW-46 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/tests/integration/automation/load-and-recovery.test.ts` | AW-44 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/tests/integration/automation/m1-backend.test.ts` | AW-66 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/web/src/App.tsx` | AW-12 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/web/src/api/automationClient.ts` | AW-12 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/web/src/components/Layout.tsx` | AW-12 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/web/src/pages/Agents.tsx` | AW-53 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/web/src/pages/Automations.tsx` | AW-12 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/web/src/pages/ResourceDetail.tsx` | AW-12, AW-52 | M1, M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/web/src/pages/WriteApprovals.tsx` | AW-52 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/web/src/pages/agents/AgentCard.tsx` | AW-53 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/web/src/pages/agents/ConnectGuide.tsx` | AW-53 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/web/src/pages/automations/Digests.tsx` | AW-45 | M3 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/web/src/pages/automations/NeedsAttention.tsx` | AW-12 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/web/src/pages/automations/PreviewPanel.tsx` | AW-12 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/web/src/pages/automations/RuleDetail.tsx` | AW-34 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/web/src/pages/automations/RuleEditor.test.tsx` | AW-70 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/web/src/pages/automations/RuleEditor.tsx` | AW-12, AW-70 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/web/src/pages/automations/RuleSentence.tsx` | AW-12 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/web/src/pages/automations/RunDetail.tsx` | AW-34, AW-45 | M2, M3 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/web/src/pages/automations/RunOnce.tsx` | AW-59 | M3 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/web/src/pages/automations/TemplateInstall.tsx` | AW-37 | M4 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/web/src/pages/automations/TemplateUpgrade.tsx` | AW-65 | M4 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/web/src/pages/automations/ruleDraft.test.ts` | AW-70 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/web/src/pages/automations/ruleDraft.ts` | AW-70 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |


## Import rules

The shared package imports no `node:*`, `chrome`, database client, model SDK, Fastify or MCP transport. Application automation code imports typed ports, not infrastructure instances. MCP adapters translate wire data into application inputs. Browser code resolves native identity locally and imports the shared package through its published dependency. Only infrastructure adapters fetch remote pages, call providers or deliver callbacks.

## Contract and test locations

OpenAPI source: `packages/server/openapi/fragments/automations.yaml`, bundled into `colp-server-v1.yaml` with prefixed component names; generated clients under `packages/server/generated/openapi/` and `packages/web/src/generated/` are never edited by hand. Events fixtures under `packages/node/tests/mcp/`; server tests under `packages/server/tests/`; extension e2e under `Known-Extension/e2e/`. This pack lives in `docs/automation/` once AW-01 copies it; the root README links to it.

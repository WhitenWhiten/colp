# Persistence, Transactions and State Machines

**Status:** proposed PostgreSQL design. **Version:** 0.2.1-design. Table names are new. JSONB holds versioned closed documents and never excuses missing integrity checks. Tables are introduced by milestone; a later milestone's tables are not created early "for convenience", so that a server that stops at M1 carries no dead schema.

## 0. Migration naming (G9)

Migrations are Kysely files with a sortable UTC prefix (R25). The head at design time is `202610290100_link_preview_object_bytes.ts`. An automation migration named with a smaller prefix would sort before an already-applied file and fail the next upgrade with `corrupted migrations`. Rule: use the merge-day UTC prefix, confirm it sorts after the newest file in `packages/server/migrations/` at merge time, and add the CI check from AW-01. Forward-only, expand-contract, as `migrations/README.md` requires.

## 1. Table inventory by milestone

All account-owned keys include the owner identity in queries and authorization. Database constraints complement application authorization.

### M1

| Table | Essential columns | Constraints and indexes |
|---|---|---|
| `automation_settings` | owner_id, paused, paused_at, paused_by, revision | one row per owner; read on every admission and bundle compile |
| `automation_rules` | id, owner_id, current_revision_id, desired_state, created_at, updated_at | owner/state index; current revision FK |
| `automation_rule_revisions` | id, rule_id, revision, definition_json, semantic_digest, created_at | unique(rule_id, revision); immutable |
| `automation_binding_sets` | id, owner_id, rule_id (nullable for shared sets), current_revision, name | owner index |
| `automation_binding_revisions` | binding_set_id, revision, values_json, semantic_digest | unique(binding_set_id, revision) |
| `automation_dependencies` | rule_revision_id, role, resource_kind, resource_id, dependency_revision, stage | reverse lookup (resource_kind, resource_id); ancestor closure |
| `automation_incidents` | id, owner_id, rule_id, dependency_key, code, revision, severity, state, first_seen, last_seen | unique active (dependency_key, code, revision) |
| `automation_event_facts` | source_event_id, operation_id, collection_id, node_id, commit_ordinal, occurred_at, origin, facts_json, facts_version, root_run_id | unique source_event_id; (collection_id, commit_ordinal) index; private |
| `automation_intake_receipts` | id, owner_id, device_id, replica_generation, local_receipt_id, operation_id, state, receipt_json | unique(device_id, replica_generation, local_receipt_id); operation/state index |
| `automation_source_positions` | owner_id, collection_id, last_inspected_ordinal | unique(owner_id, collection_id); advanced only after durable admission |
| `automation_activations` | rule_revision_id, collection_id, after_ordinal, disabled_after_ordinal, aggregate_epoch | unique rule/collection/activation generation |
| `automation_admission_receipts` | rule_revision_id, source_event_id, stage, decision, run_id | unique(rule_revision_id, source_event_id, stage) |
| `automation_aggregate_state` | rule_revision_id, epoch, partition_key, sequence, remainder_json | unique(revision, epoch, partition); locked before member changes (used by M3 batches; created in M1 because admission writes it) |
| `automation_runs` | id, kind (`intake`, `batch`, `manual`), rule_revision_id, binding_revision, policy_revision (nullable in M1), member_ids, state, created_at | owner/time/id index |
| `automation_jobs` | id, run_id, task_id, target_id (nullable), input_digest, contract_id, state, active_generation, result_id | unique(run_id, task_id, target_partition); ready-queue index |
| `automation_effect_receipts` | id, run_id, job_id (nullable for M1 placement), step_id, target_partition, plan_id (nullable for M1), operation_id, before_folder, before_revision, after_revision, effect_digest | unique(run_id, step_id, target_partition) with a non-null normalized partition; canonical operation linkage plus idempotent plan reconciliation; never rely on SQL NULL uniqueness |
| `automation_device_bundles` | owner_id, device_id, revision, profile, digest, issued_at, expires_at, paused, settings_revision, status | current bundle index |
| `automation_preview_records` | id, owner_id, config_digest, result_json, expires_at | expiry index |
| `automation_tag_rejections` | owner_id, rule_id, tag_key, rejected_at | unique(rule_id, tag_key) |

### M2

| Table | Essential columns | Constraints and indexes |
|---|---|---|
| `automation_execution_policies` | id, owner_id, current_revision | owner index |
| `automation_execution_policy_revisions` | policy_id, revision, configuration_json | unique(policy_id, revision) |
| `automation_connection_profiles` | id, owner_id, client_id, credential_binding_id, catalogs_json, enabled, revision | unique owner/binding/profile identity; mirrors the Agents page switches |
| `automation_targets` | id, owner_id, connection_profile_id, name, wake_mode (`events`, `poll`), poll_interval_minutes, pairing_generation, privacy, broadcast_opt_in, state, last_seen_at | eligible target index |
| `automation_executors` | id, owner_id, kind, target_id (nullable), config_json, verified_capabilities, credential_ref, revision | created with a target; credential_ref never plaintext |
| `automation_job_attempts` | job_id, generation, executor_id, claim_token_hash, lease_until, outcome, provider_request_ref | unique(job_id, generation); live lease index |
| `automation_results` | id, job_id, generation, input_digest, output_json, proposal_digest, status | one accepted result per job/input/contract |
| `automation_usage_counters` | owner_id, rule_id, target_id, day, runs, jobs, calls | unique(rule_id, target_id, day) |
| `automation_pairings` | id, target_id, code_hash, expires_at, consumed_at | single-use atomic consumption; short retention |
| `automation_subscriptions` | id, owner_id, target_id, identity_digest, event_name, canonical_arguments, encrypted_url, encrypted_secret, secret_generation, state, refresh_before | unique(identity_digest); one active per target/event by default |
| `automation_deliveries` | id (event_id), job_id, target_id, subscription_id, body_bytes_or_ref, generation, state, next_attempt_at | unique(job_id, target_id, subscription_generation, occurrence_kind); due index; rows exist only for targets in events mode |

### M3

| Table | Essential columns | Constraints and indexes |
|---|---|---|
| `automation_run_outputs` | id, run_id, job_id, target_id, result_id, text_json, created_at | unique(result_id); stable run/created_at/id index |
| `automation_digest_reads` | owner_id, run_id, through_output_id, read_at | unread count for the Digests list |

### M4

| Table | Essential columns | Constraints and indexes |
|---|---|---|
| `automation_templates` | id, owner_id, publisher, template_key, version, digest, package_json, review_state | unique publisher/key/version/digest; no private bindings |

Existing tables reused, never duplicated: command receipts, canonical operations and audit, change plans and collection versions (R07), agent policy rows (R20), the master-key encryption path.

## 2. Transaction A: capture committed facts

The verified baseline order is collection-lock → canonical-plan → allocation → resource → operation → audit → outbox. The proposed extension inserts private facts after audit and before outbox, using source event identity allocated within the transaction. Before-state is taken from locked planning inputs before mutation; after-state comes from the resulting plan/rows. Static Outbox scheduling remains last. A rollback removes all of them. No HTTP, no evaluation of user predicates, no model call while collection locks are held. Facts come from the plan and rows already in hand.

An event's after-URL, parent and ancestry are event-time values. For large subtrees capture a versioned ancestry reference, not the tree.

## 3. Transaction B: admit and aggregate

```text
begin
  lock source-position row and applicable admission partition in canonical order
  capture a stable committed high-water ordinal
  if globally paused:
    record/advance inspected and skipped-admission fence through high-water
    commit; stop (no admitted run, model task or delivery)
  for eligible source facts after the active rule fence:
    verify current authority and server-derived intake disposition
    insert unique admission receipt; duplicates perform no new action
    each: create one pinned intake run, with verified placement effect if any
    M3 countBatch: lock revision/epoch/partition; append distinct member;
      remove exactly N ordered members for each run; persist remainder
    M2+ only: instantiate permitted task DAG, policy/budget state and recipients
      transition dependency-ready jobs to ready; persist wake scheduling atomically
  advance inspected source ordinal through irrelevant operations too
commit
```

M1 never reads/writes execution-policy, usage-counter, subscription or delivery tables. Deterministic placement is not dropped by worker cost caps. A rule/global resume fences out the paused interval at a fresh committed high-water; it does not accidentally replay skipped bookmarks. Pending jobs from before pause retain pins and are separately held/cancelled/resumed under the chosen lifecycle policy. New source facts after resume are not lost behind an older inspection cursor.

Pure matching may run outside the lock only when all inputs and versions are pinned and revalidated before committing the decision. A failing evaluator marks that rule blocked; source inspection records a recoverable diagnostic and other rules proceed.

## 4. Transaction C: claim (M2)

Select a ready job for the authenticated target. If an unexpired claimant exists, return conflict. Otherwise increase generation, store a fresh token hash and return the token once with the lease. Heartbeats need the same token and generation plus current authority. Generation is a fencing token. At expiry, distinguish "no known external side effect" from uncertain progress; only a safe retry or an explicit Owner retry reassigns.

## 5. Durable result/plan orchestration (M2)

The existing plan coordinator is not assumed to accept an outer job transaction. Validate a typed proposal, then persist job generation, input/proposal digest, stable plan command identity and `committing` state. Recheck current authority, resource/content revisions and the allowed subtree when planning and again when committing. Manual policy yields `awaitingApproval`; trusted policy follows the existing reversible-plan path.

Call the existing idempotent plan/commit coordinator outside the job lock. Link its canonical operation/version to the effect receipt in a separate short idempotent transaction and mark the job succeeded only after that linkage is durable. A crash after canonical commit but before job completion is recovered by looking up the SAME plan/operation/command, not by executing another effect. A missing or ambiguous commit outcome remains committing/uncertain until reconciled. Any future same-transaction receipt hook needs explicit source verification and a separate contract change; it is not presumed here.

One undoable effect corresponds to one isolated reversible plan unit; multi-step jobs checkpoint effect IDs and remain partial until required steps finish. Metadata-only results and run-level digest/review text are accepted results without fake canonical mutation plans. M1 placement receipts/compensation are the separate Owner-authorized path described in AW-51, not a dummy worker job.

## 6. Transaction E: callback delivery (M2)

A delivery worker leases in a short transaction, rechecks authority, pause and expiry, signs the fixed body and sends outside locks, then records accepted or failed only if it still owns the generation. Never write accepted before sending; never mark a job succeeded because a callback returned 200; never hold a transaction open while a bot runs.

## 7. State transitions

```text
Server:          paused <-> running (automation_settings)
Rule desired:    draft -> enabled <-> paused -> archived
Rule effective:  draft | active | degraded | blocked | paused | archived
Receipt:         waitingForSync -> accepted | review | rejected
Run:             waiting -> running -> completed | partial | review | blocked | cancelled | failed
Job:             pending -> ready -> leased -> committing -> succeeded
                                  |         -> awaitingApproval -> succeeded | cancelled
                                  |         -> uncertain -> ready (explicitly safe) | blocked
                                  |         -> failed | stale | review
Delivery (M2):   pending -> sending -> accepted
                          |        -> retrying -> sending
                          |        -> deadLetter | cancelled | awaitingSubscription
Incident:        open -> acknowledged -> resolved (by revalidation only)
```

Desired state and observed health are independent. No transition from acknowledged to resolved without a passing revalidation.

## 8. Retention, erasure and replay

Never purge unfinished members or active job inputs behind a retention default; when they must expire, create an incident and a terminal record. Historical replay (Later) requires retained facts or declares incomplete coverage. Delete credentials and callback secrets promptly on revocation. Account erasure removes private content; compact tombstones stay only where the product policy permits.

Backups are whole-database dumps (`deploy/backup.sh`); encrypted secrets need the same `COLP_SERVER_SECRET` on restore. A restored server starts with `automation_settings.paused = true`, revalidates bindings and subscriptions, and marks in-flight attempts uncertain.

## 9. Migration sequence

Create tables and indexes first; add nullable source linkage and facts capture behind `KNOWN_FEATURE_AUTOMATION_CAPTURE`; deploy readers before producers; enable capture in shadow mode; verify no missed operation paths against canonical source events; then enable admission for the Owner. No automatic migration of historical bookmarks into runs: run-once is the explicit path. Consumers accept explicitly supported facts versions; old versions yield `missingInput`, not invented metadata. Disable admission and delivery before rolling back code that cannot read current jobs; keep tables during rollback until in-flight work drains.

## 10. Identity and recovery constraints

Normalize nullable target partitions to an explicit sentinel for uniqueness; PostgreSQL NULL values must not permit duplicate M1 effects. Poll and Events workers use the same job handles independent of delivery rows. Source and task digests bind canonical IDs, relevant revisions, input field selection and accepted predecessor outputs. Access lost after admission means unavailable/review, never an authority snapshot that grants future access. An Owner read marker references the final output actually viewed, not a wall-clock time that can swallow a concurrent unread result.

# BE-1 / BE-2 hardening semantics

This implementation note supersedes earlier evidence where the behavior below differs.
The imported design remains provenance; it is not rewritten to disguise an implementation
change. These changes remain M1: no model, worker policy, target, Events subscription,
Web UI, native browser runtime or background page fetcher is introduced.

## Parsing and evaluation

The validator compiles the existing recursive Predicate union using its required unique
`kind` discriminator, retaining the object check and closed generated schemas. It stops
validation after a failure instead of recursively exploring incompatible `all`/`any`
branches. General JSON depth/node bounds and the finite 16-level/128-node semantic bound
remain in force. Tests exercise deeply nested inputs in a separately killable subprocess,
not with a Vitest timeout around synchronous code that could block the test runner itself.

Fixed trusted schema compilation is prepared before the per-input deadline. Untrusted
facts validation and normalization consume that deadline. A synchronous rule batch uses
one opaque, private normalized snapshot, evaluates each eligible rule once, then arbitrates
once. The handle cannot be serialized as authority and cannot be forged or reused for a
different source/version. It is not a global cache of mutable live bookmarks or permissions.

Literal path `startsWith`, normalized exact equality, host suffix boundaries, missing-input
propagation, explicit selections, conflict resolution and compatible placement sharing
retain their original meaning. Validation and preview do not reserve daily capacity.

## Canonical intake roots and device evidence

Canonical collection root and the `bookmarks-bar`, `other-bookmarks`, `mobile-bookmarks`
folder roles use one domain predicate. The event-time parent-root flag comes from locked
canonical planning; folder names and native browser IDs never establish this fact.
Source adaptation, server effects and observed create-then-move receipt verification use
the same definition. Root location alone still does not establish consent for a new move.

Receipts still require current authenticated device/session/generation, immutable bundle,
rule and binding pins, current scope/priority/authority, both canonical operations where
applicable, input/result digests and conservative current-resource fences. Successful
verification describes an effect that already happened; it never requests a second move.

## Waiting receipt recovery

The waiting quota bounds newly waiting work, not a valid completed canonical proof or an
idempotent retry. Owner serialization makes count/reservation atomic across devices.
Expired, missing or superseded bundle pins and obsolete replica generations are retired
to `review` in bounded batches, with their original input/actor evidence retained.
Reclamation runs during receipt intake and source processing; it does not require the
missing operation to arrive. It is not a promise of an always-running retention service.

The receipt ledger is the work queue; a source slice is only a wake-up. Complete canonical
proofs are revisited even when their source cursor already passed or the wake has no new
source rows. Each reconciliation slice handles ten proofs and requests continuation for
more. Pause blocks acceptance; stale-evidence retirement is not placement authorization.

## Daily runnable admission limit

`policy.maxRunsPerDay` now governs runnable server admissions per logical rule and **UTC
calendar day**, independent of the database session timezone. Definition replacement,
retry, worker restart and `continuePinned` cannot reset the logical rule's count or charge
the same run twice. A reservation, effect and source cursor share the transaction.

Overflow remains a persisted waiting run with the original definition, binding and source
pins. It is not silently dropped, rebased or executed. One durable delayed wake per Owner,
collection and UTC boundary revisits eligible work; excess work is deferred again if
necessary. The Run explanation reports the boundary. `held` continues to mean an explicit
Owner hold, not every automatic waiting reason. Global pause, explicit hold, cancellation,
current authority and later manual edits retain precedence. Cancellation does not refund a
previously admitted run; this is admission accounting, not a model-cost ledger.

Review/conflict/missing-input records do not spend runnable capacity. An authenticated
receipt for an already-committed device effect remains real history even above the server
limit and counts against later server admissions. **The backend cannot retroactively cap
an offline device effect.** Validation and preview disclose this boundary. Native browser
coordination of a globally shared offline quota is not claimed by BE-2.

## Missing immutable inputs

`missingInput: review` creates an inspectable review run. `missingInput: defer` retains an
inspectable, cancellable waiting run with its original immutable pins and a reason.
Neither is silently treated as a non-match. A deferred missing-input plan is never selected
by the placement executor, even after `continuePinned`.

M1 does not invent a page fetcher, fill event-time facts from today's bookmark, or silently
change the normalizer/profile to make a deferred source match. Automatic live-input repair
is not installed. The editor receives this warning before activation. Verified canonical
receipt evidence can still record an effect where existing receipt rules permit it;
otherwise the Owner may cancel the retained run. A new explicit workflow must use its own
supported preview/admission contract rather than rewrite the old source.

## Preview and Undo expectations

Current-state sampling is hypothetical, not recovered intake history. The preview reports
separate counts for placement plans, match-only, preserved intent, overridden, blocked,
conflicting, missing and unmatched inputs. A zero planned-run count can mean that matching
rows lack provable intake intent; it does not justify fabricating that intent.

Single-effect Undo remains a compensating canonical move with the existing conservative
resource **and collection content** fences. Unrelated later collection changes can make
Undo unavailable. Hardening does not weaken this into force restore or per-field rollback.

## Upgrade and evidence

Apply forward migrations `202610301000_automation_receipt_waiting_index` and
`202610301100_automation_intake_capacity`. The latter backfills daily reservations from
existing completed/effected intake runs without rewriting their pins or effect identity.
Whole-database backup includes these tables; restore still starts globally paused.

Regression entry points are the shared Automation tests, server Automation unit tests,
and `tests/integration/automation`. New cases cover bounded parsing, normalization reuse,
linear rule evaluation, canonical browser roots, waiting quota concurrency/reclamation,
empty-source recovery, daily rollover/holds/cancellation, immutable missing inputs,
capacity migration, mixed durable routes and actual process termination before ack.
Test presence is not a test result. Executed results and exact tested commits belong in
the accompanying evidence record; these backend fixtures do not establish browser-store,
production load or real deployed-host acceptance.

# Delivery Lanes and Frontend Handoff

**Status:** implementation ownership plan. All UI work is frontend work and is deferred in the backend-only path. tasks.json is the source of task IDs; file-ownership.json is the file ownership inventory. backend-batches.json is the dependency-closed local schedule.

## 1. Single ownership

| Lane | Owns | Does not own |
|---|---|---|
| contracts | Baseline evidence, contract review and vocabulary freeze (AW-01) | Product runtime files or UI |
| shared-core | Pure schemas, normalization, finite evaluator, arbitration and task contracts inside @know-n/colp/automation | Chrome/DOM/React/Node built-ins, network, database, provider-specific Events |
| backend | Server use cases, persistence, authorization, jobs, effects, OpenAPI producer artifacts, worker transport and Events adapters | React pages, frontend generated clients, browser local state or native bookmark APIs |
| web | Every Web screen, UI state, controls, strings, navigation, Web client generation and API consumption | Authoritative lifecycle, permission decisions, budgets or workflow scheduling |
| extension | Native mapping/capture/receipts, local bundle installation, Chrome lifecycle, extension UI and consumer integration | Canonical server identity, server authorization or server job transitions |
| worker-reference | Runnable host-neutral polling example and setup documentation (AW-32) | A guaranteed autonomous provider deployment or server-owned model executor |
| integration | Composition of lane-owned evidence into the M1/M2 product release gates | Reimplementing another lane to bypass a missing handoff |

For this local delivery, shared-core is part of the backend work budget even though its API is browser-compatible. Compatibility is tested by an isolated import/bundle fixture, not by developing the browser extension. The entire Known-Extension checkout remains untouched; this is a scheduling choice, not a claim that every extension line is UI.

## 2. Splits made from the uploaded mixed packets

| Existing packet retained for backend/core | Deferred consumer packet |
|---|---|
| AW-03 bounded profile; AW-04 exported core; AW-18 rule-bundle service | AW-49 extension installation, mapping and runtime profile |
| AW-17 canonical receipt ingestion | AW-50 extension local receipt persistence and Sync handoff |
| AW-25 plan approval and conservative Undo adapter | AW-52 Web approval/Undo controls |
| AW-26 target/profile/pairing service; AW-30 catalogs; AW-32 reference worker | AW-53 Agents screens and connection guide |
| AW-55 backend waiting/budget read model | AW-34 Web history; AW-54 extension status |
| AW-41 run-once preview/start service | AW-59 run-once UI |
| AW-57 count aggregation; AW-58 output/unread persistence | AW-45 Web digest screens; AW-60 extension badge |
| AW-36 template install/export; AW-38 upgrade/rollback | AW-37 install wizard; AW-65 upgrade/rollback UI |
| AW-48 later server-owned executor | AW-62 later extension background executor |

AW-51 explicitly owns the M1 placement explanation/Undo backend previously missing from the independent M1 release. AW-61 owns shared portable-template/entity-map semantics. AW-66 is the backend-only M1 acceptance gate; AW-64 is the backend polling/plan gate. Neither gate waits for a frontend or a real hosted callback.

## 3. What a backend handoff contains

Publish the versioned OpenAPI/JSON Schemas, bounded positive and negative fixtures, error/recovery semantics, auth scheme, pagination rules and actual backend tests. Provide representative states: draft, invalid/stale preview, active, paused, blocked dependency, capability unavailable, no safe Undo and conflicting newer edit. For M2 add unpaired/paired, no work, leased, uncertain, awaiting approval, committing, succeeded and delivery unavailable.

The backend owns the canonical schema source. Web and extension generate or adapt their clients in their own work. A UI must not guess missing fields by inspecting server tables or infer a workflow transition from a successful network request. Backend descriptions must distinguish desired state from observed effective state and delivery acceptance from job success.

Backend tests use real database fixtures and transport clients where those semantics matter; they do not require a screen. Frontend can start layout and mock integration after the relevant schema slice is frozen. Full consumer integration waits for the producer packet's acceptance, not merely its task ID appearing in a roadmap.

## 4. Merge order and shared files

Do not run two agents concurrently against the same schema fragment, SDK boundary or route manifest. Even within one lane, shared-file producers are merged serially or through a named integrator. The pure evaluator can proceed in parallel with persistence after the common types are stable. Every packet still honors its listed dependencies.

AW-01 owns review records; the backend owns the actual server OpenAPI fragment. Each task has its own evidence file. A cross-lane defect returns to the owning producer with a minimal failing fixture; consumers do not add private compatibility branches to conceal it.

Local package build/pack validation closes AW-04's backend deliverable. Public npm distribution precedes AW-49's release consumption but does not block local backend work. Migration filenames must sort after the actual database/repository head, even if a timestamp-looking head is ahead of the calendar.

## 5. Distinct gates

BE-1 completes configuration and preview only; no bookmark movement is claimed. AW-66 proves the durable M1 backend without UI or M2 services. AW-64 proves the local polling worker/plan lifecycle without Events. AW-02/AW-46 prove the selected Events profile and, separately, the actual hosted lifecycle. AW-63/AW-35 remain full product gates combining frontend, extension, backend and applicable host evidence. A backend milestone may be accepted without calling the full product shipped.

# Phase 0 exit evidence tests

These tests are evidence for engineering foundations only. They do not expose a Product HTTP endpoint, claim a COLP deployment profile, or freeze the draft Product OpenAPI contract.

The integration suite requires a real PostgreSQL instance (never SQLite or an in-memory substitute). Obtain a database via:

- `scripts/with-postgres.mjs` (prefers an already-set usable `KNOWN_TEST_DATABASE_URL` / `DATABASE_URL`, otherwise Testcontainers), or
- a developer-supplied external URL alone.

**Evidence modes** (`KNOWN_PG_EVIDENCE_MODE`, see `scripts/postgres-evidence-mode.mjs`):

| Mode | How selected | Missing PostgreSQL |
| --- | --- | --- |
| `acceptance` | `CI=true`/`CI=1`, or `KNOWN_PG_EVIDENCE_MODE=acceptance` (also `ci` / `fail-closed`) | **Fail closed** (not skip/pass) |
| `default` | local, no explicit mode | **Fail closed** (not silent skip) |
| `local-opt-out` | `KNOWN_PG_EVIDENCE_MODE=local-opt-out` (aliases: `skip`, `opt-out`) | Explicit `describe.skip` with a loud console warning; **not** valid CI evidence |

`with-postgres.mjs` always fails closed when it cannot connect to an external URL or start Testcontainers; local opt-out does not soft-pass evidence runners. CI sets acceptance (GitHub Actions already sets `CI=true`; the workflow also sets `KNOWN_PG_EVIDENCE_MODE=acceptance`).

The evidence suite covers:

- migrations from an empty schema, idempotent `latest`, full down/up reconstruction, and connection cleanup;
- real PostgreSQL serialization, deadlock, unique-constraint, rollback, and unknown commit acknowledgement probes;
- a separately spawned API process and database-backed `/health` and `/ready` probes;
- Outbox lease generation/CAS and Product command receipt constraints on PostgreSQL;
- import-boundary and secret-scan positive and negative fixtures;
- logger redaction of credentials and raw header values;
- the minimal COLP adapter contract through package public exports only;
- a versioned, repeatable performance workload and machine-readable thresholds.

Performance numbers are engineering trial evidence, not an external SLO. Results must be stored with Node/PostgreSQL versions, iteration counts, concurrency, and observed pool waiters. Thresholds must not be relaxed merely to make a run pass.

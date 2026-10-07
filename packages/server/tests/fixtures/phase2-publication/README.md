# Phase 2 Publication Redis evidence fixtures

This directory holds the machine-readable evidence contract for the Redis
hot-data cache performance/failure evidence task
(`docs/12-redis-hot-data-cache-plan.md` §6.4 T14, §11 T14 证据命令与产物路径).

## Files

- `redis-evidence.schema.json` — JSON Schema (draft 2020-12) for the T14
  evidence artifact. Mandatory fields: `format`, `schema`, `timestamp`,
  `gitSha`, `gitDirty`, `fixture`, `scenarios`, `counts`,
  `latencyDistribution`, `payloadBytes`, `versions`, `outboxInvalidation`,
  `breakerEvidence`, `knownLimitations`, `pass`. No secret or business-body
  field exists in the schema by design.

## How the artifact is produced

The runner is `tests/integration/phase2-publication-redis-evidence.integration.test.ts`
(real PostgreSQL via `scripts/with-postgres.mjs` + a dedicated Testcontainers
Redis). It validates the produced artifact against this schema before writing it.

Replay commands (see the plan doc §11.1):

```bash
npm run evidence:phase2-publication-redis
npm run evidence:phase2-publication   # T14 evidence + T13 acceptance
```

Artifact output (overwrite-safe, tmp + rename):

- default: `docs/evidence/phase2-publication-redis-evidence.json`
- override: `KNOWN_PHASE2_PUBLICATION_REDIS_EVIDENCE_OUTPUT=<path>`

## Contract unit test

`tests/unit/phase2-publication-evidence-contract.test.ts` statically validates
this schema (parses, required fields, representative sample, fail-closed
mutations) and the pure contract module
`scripts/evidence/phase2-publication-redis-evidence.ts`. It never
runs the evidence runner, Redis or PostgreSQL.

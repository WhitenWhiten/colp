# Site adapter execution evidence

Started 2026-10-24 from clean `53438380`. Only the prepared OrbStack image and dependency volumes are used. Status is per exit criteria, not code volume. No commits are pushed. Commands below run from the repository root unless a directory is specified.

| Task | Status | Evidence / blockers |
| --- | --- | --- |
| SA-00 | Complete | Contracts and fixtures below |
| SA-01–SA-10 | Not started | Follow dependencies in the implementation plan |

## SA-00 — fixtures and contract decisions

- Implementation: commit containing this entry (parent `53438380`); `src/site-adapters/{contracts,limits,schema,schemas,graph}.ts`, Bilibili identity normalizer, fixtures and contract tests. No pre-existing diff.
- Prototype: [fingerprints](prototype-fingerprints.json), version 0.1.0. External directory has no Git metadata, so no source commit is claimed. Fixtures revision 1 uses synthetic IDs/titles in shapes observed 2026-10-23; no private responses are included.
- Identity v1: `bilibili` / numeric decimal account and collection IDs / `video:av:<aid>` for verified type 2 resources. Canonical URL is `https://www.bilibili.com/video/av<aid>`. Unsafe numeric IDs, missing IDs and label-derived identities are rejected. BV and short-link URL resolution remains unavailable until separately verified; no equal-URL aliasing.
- Runtime contracts are shared with the documentation via re-export. Closed validators use a finite schema algebra without eval/code generation. v1 has no authorized host recipes; `read` is rejected. Page omissions distinguish invalid, unsupported, missing and failed details. Read failures additionally distinguish network, challenge, capacity and stale cursor. These extend the original draft.
- Limits: 256 KiB observation, 512 KiB/100 entities per SDK page, 2 MiB streamed site response, 64 edges, 32-depth layout. Site API: 1,000 IDs/page, 100 details/request, 200 ID pages, two cursor buffers. Reads: 8s request, 10s pre-bootstrap, 30s command; at most three transient attempts, 3s backoff, 10s automatic wait ceiling. Host queue 16, one in-flight read/connection, 1.5s spacing; lease 60s. 412/challenge pauses without retry. 429 honors Retry-After or pauses when it cannot fit. Capacity: 10,000 pending observations/50,000 import items; no unfinished eviction.
- Exact checks: `node packages/extension/scripts/with-orbstack.mjs run node_modules/.bin/vitest run tests/site-adapter-contracts.test.ts` → 12/12; `node packages/extension/scripts/with-orbstack.mjs run node_modules/.bin/tsc --noEmit --strict --skipLibCheck --target ES2023 --module NodeNext --moduleResolution NodeNext --lib ES2023,DOM docs/site-adapters/contracts.ts docs/site-adapters/examples.ts src/site-adapters/schemas.ts src/site-adapters/bilibili/identity.ts tests/site-adapter-contracts.test.ts` → passed; `git diff --check` → passed.
- Coverage: unit/fixture only. Success, empty vs missing data, failure, partial and stale-context fixtures are distinct. Wire rejects spending/command injection, arbitrary reads, extra fields, overlapping deltas, duplicate IDs, missing readback edges, unsafe URLs, bytes and depth overflow. Browser/site acceptance not run for this task.
- OS/runtime: macOS host, prepared Linux arm64/Node 24 runner. No browser or provider enabled; no native or model effects. Container removed after checks; caches retained. Next: SA-01.

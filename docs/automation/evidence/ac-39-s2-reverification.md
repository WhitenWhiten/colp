# AC-39 — s2 re-verification after local optimization

Status: **failed; saving availability is still blocked**.
Tested commit: `75d921c6dea8960cd99bf08019e692cd6cbc7e11`.
Measured on 2026-10-14 UTC.
The preceding [local comparison](ac-39-local-optimization.md) is not substituted
for these measurements on the intended deployment host.

## Method

The same s2 host, Node 22.23.2, PostgreSQL 16.15, six-connection application pool,
5-second connection/lock timeouts, 15-second statement timeout, 40 PostgreSQL
connections and 128 MiB shared buffers were used. The old application, database
and Caddy were stopped normally; their containers and volumes were retained.
The benchmark ran against a new isolated PostgreSQL container on loopback port
15439, with isolated schemas and the exact committed runner.

Thresholds stayed unchanged: zero failed saves, save p95 <= 1 second, maximum
save latency <= 2 seconds, run-once <= 10 seconds; the rule stage also retains
its 10-second operation budget. All stages ran under xvfb, sequentially, with
600-second process timeouts and host sampling. The manual cases requested three
rounds, but the runner stopped each after the first failed-save observation.

These remain application/database transaction measurements, not a full HTTP,
reverse-proxy, browser or hosted-provider capacity test. The evaluator and vendor
package are unchanged between `f6beff6` and `75d921c`; their previous three-million
evaluation result was retained rather than rerunning an unrelated microbenchmark.

## Manual placement still blocks saving

| Observation | Previous s2 result | Optimized s2 result |
| --- | ---: | ---: |
| 100 members, canonical seed, one concurrent save per group | 12.89 s | 12.87 s |
| Queries in that run-once | 5,757 | 4,368 |
| Observed collection-gate hold, lower bound | 12.79 s | 12.79 s |
| Same-collection save | failed at 5.06 s | failed at 5.06 s |
| Same-Owner other-collection save | 310 ms, succeeded | 615 ms, succeeded |
| Foreign-Owner save | 529 ms, succeeded | 632 ms, succeeded |
| 100 members, bulk seed, 20 arrivals per save group | 15.36–19.56 s (2 runs) | 14.71 s (1 run) |
| Queries in that burst run-once | 5,758 | 4,369 |

The optimization removed about **24% of the manual query count**, but the
low-concurrency case still held the collection gate for longer than the lock
timeout. It does not require pool saturation to fail. All 100 placements committed
in both measured cases, but that does not satisfy ordinary save availability.

In the 20-arrival burst, all 20 same-collection saves failed; 12 same-Owner
other-collection saves and 14 foreign-Owner saves also failed from pool-acquisition
timeouts. The gate was observed held for at least 14.61 seconds, with five waiters.
As before, the control groups share the application pool: their failures show
starvation behind blocked writes, not a cross-Owner collection lock.

Timings are individual observations on a shared VM, not a causal estimate of
hardware speed or an SLA. In particular, a lower query count must not be reported
as a demonstrated latency improvement in the low-concurrency control. Larger
500/1,000-member manual loads were not attempted after the saving failure.

## Rule-count scaling improved and passed this stage

Three rounds per size used the same workload as the initial s2 run: shared folder
bindings, one new canonical bookmark before each admission drain, and a preview
sample growing from 1 to 12 bookmarks across the sequence.

| Rules | Optimized preview, seconds | Preview queries, before → after | Optimized admission drain, seconds |
| --- | --- | --- | --- |
| 1 | 0.053–0.085 | 45 → 45 | 0.055–0.082 |
| 50 | 0.136–0.283 | 1,221 → 68 | 0.370–1.200 |
| 200 | 0.219–0.361 | 4,821 → 68 | 1.725–2.197 |
| 500 | 0.370–1.158 | 12,021 → 68 | 5.340–9.389 |

The 500-rule preview previously took 20.61–23.35 seconds, and admission
14.75–19.53 seconds. The repeated read reduction is visible on s2, and all cases
are now within the stage's 10-second operation budget. The slowest 500-rule
admission is still close to that boundary. This workload does not establish
latency under concurrent saving or with 500 rules and 1,000 preview members.

## Finite queue recovery passed

The 50-save burst plus initial fixture task again produced exactly 51 ready jobs.
All 51 reached `succeeded`, without duplicate effect receipts, in **53.14 seconds**
after consumption resumed. Admission drained in 12.85 seconds. Saving had zero
errors, p95 **912 ms**, and maximum **937 ms**, within the unchanged candidate
thresholds. The previous observation was p95 1,350 ms and 59.13-second recovery.

This is one finite queue observation, with saves before the recovery phase. It
does not establish sustained overload capacity or saving availability during
the admission/recovery drain. The queue gate checks saving and finite recovery;
its admission-drain duration is reported separately from the rule-operation gate.

## Evidence and cleanup

- [Environment, image and source hashes](fixtures/ac-39-s2-75d921c/environment.txt)
- [Canonical-seed control](fixtures/ac-39-s2-75d921c/control.jsonl)
- [Burst saving](fixtures/ac-39-s2-75d921c/burst.jsonl)
- [Rule scaling](fixtures/ac-39-s2-75d921c/rules.jsonl)
- [Queue recovery](fixtures/ac-39-s2-75d921c/queue.jsonl)
- [Stage exits](fixtures/ac-39-s2-75d921c/exits.txt): control 1, burst 1, rules 0, queue 0.
- [One-second host samples](fixtures/ac-39-s2-75d921c/vmstat.txt)
- [Restoration check](fixtures/ac-39-s2-75d921c/restoration.txt)

The PostgreSQL image digest exactly matches the previous s2 run. Neither failed
manual case was retried at a larger size or counted as a passing stage. No
production implementation changed during re-verification.
The disposable database container and volume were removed. After evidence was
collected, the temporary checkout and Node runtime were removed as well. The
original application and PostgreSQL were restored healthy, Caddy was running,
and the restoration check found no remaining test Node or Xvfb process.

## Reproduction

Check out `75d921c`, use Node 22, install the locked server dependencies and point
`KNOWN_TEST_DATABASE_URL` at a disposable PostgreSQL instance. From `packages/server`:

```sh
AC39_STAGE=manual AC39_SIZES=100 AC39_ROUNDS=3 AC39_SAVE_COUNT=1 AC39_CANONICAL_SEED=1 \
  AC39_OUTPUT=/absolute/path/control.jsonl \
  timeout --kill-after=20s 600s xvfb-run -a node --import tsx tests/support/ac39-capacity.ts
AC39_STAGE=manual AC39_SIZES=100 AC39_ROUNDS=3 AC39_SAVE_COUNT=20 AC39_CANONICAL_SEED=0 \
  AC39_OUTPUT=/absolute/path/burst.jsonl \
  timeout --kill-after=20s 600s xvfb-run -a node --import tsx tests/support/ac39-capacity.ts
AC39_STAGE=rules AC39_RULE_SIZES=1,50,200,500 AC39_ROUNDS=3 \
  AC39_OUTPUT=/absolute/path/rules.jsonl \
  timeout --kill-after=20s 600s xvfb-run -a node --import tsx tests/support/ac39-capacity.ts
AC39_STAGE=queue AC39_ROUNDS=1 AC39_OUTPUT=/absolute/path/queue.jsonl \
  timeout --kill-after=20s 600s xvfb-run -a node --import tsx tests/support/ac39-capacity.ts
```

## Release consequence

AC-39 remains failed. The remaining manual transaction still runs canonical
mutations sequentially while owning the replica gate. Reducing metadata work
helped the query count, but further work must address the canonical mutation
cost under that lock while preserving immutable preview, atomicity, revision
fences, audit, effects and recovery. Raising timeouts alone would extend waits
without establishing save availability.

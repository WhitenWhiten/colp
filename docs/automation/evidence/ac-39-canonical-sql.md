# AC-39: canonical SQL optimization and s2 verification

Date: 2026-10-14 UTC. Tested source: `1c168ad1561f0150af07e1a68c6c34138f9ac36b`.
**AC-39 remains failed.** Manual execution became faster in these observations,
but concurrent saving still fails. The queue test completed all work, but its
save p95 also exceeded the existing limit this time.

## Change and verification scope

This is a local canonical adapter optimization, with no new scheduler, queue,
transaction boundary, migration, timeout or pool setting:

- Read affected parents together; update their revisions together; read back and
  validate every parent and the target after the writes, including AFTER triggers.
- Insert independent revision ledgers in one SQL statement, retaining each
  operation's resource, content, policy and children revision evidence.
- Read outbox collection, node and parent revision evidence together, selecting
  only the fields used by the event. Parent revision reads retain their parent
  filter to use the existing composite index.

Atomic rollback, canonical operation identities, audit, facts, outbox, effect
receipts, immutable task inputs and Sync revision fences remain in place.

Local checks under Node 22: typecheck, changed-file ESLint, import boundaries and
diff whitespace checks passed. The two canonical integration files passed 41
cases; manual batch, run-once, placement undo and worker pipeline passed 36 cases.
The manual batch regression observed 768 queries for 20 placements, versus the
previously recorded 928; it now requires fewer than 800 queries and checks a
suppressed parent write rolls back the complete move. No pre-change benchmark
was rerun. The baseline is the [previous s2 measurement](ac-39-s2-reverification.md).

## Environment and method

Same s2 host: 3 vCPUs, approximately 2 GiB RAM, Node 22.23.2, PostgreSQL 16.15.
The PostgreSQL image digest is unchanged:
`sha256:275447c94b11b151decd1f29877965301d5a77032037c46de93d990f739f00a9`.
Original COLP, PostgreSQL and Caddy were stopped normally during testing.
The isolated database used port 15439, max_connections 40 and shared_buffers
128 MB; the application retained pool size 6, connection/lock timeout 5 seconds
and statement timeout 15 seconds. Source hashes were checked against the commit.

The existing runner and acceptance thresholds were unchanged: no failed saves,
save p95 <= 1 second and max <= 2 seconds, run-once <= 10 seconds, and rule preview
and admission <= 10 seconds. All runs used xvfb and an external 600-second timeout.
These are application/database measurements, not full HTTP latency measurements.

## Manual results

| Measurement | Previous `75d921c` | Optimized `1c168ad` |
| --- | ---: | ---: |
| Canonical-seeded 100-member run, one save per group | 12.866 s | 10.572 s |
| Queries in that run | 4368 | 3568 |
| Observed collection gate hold, lower bound | 12.785 s | 10.412 s |
| Same-collection single save | Failed at 5.064 s | Failed at 5.070 s |
| Same-Owner other collection single save | 615 ms, success | 559 ms, success |
| Foreign-Owner single save | 632 ms, success | 574 ms, success |
| Bulk-seeded 100-member run, burst of 20 saves per group | 14.714 s | 8.730 s |
| Queries in burst run | 4369 | 3569 |
| Same-collection burst failures | 20/20 | 14/20 |
| Same-Owner other collection burst failures | 12/20 | 11/20 |
| Foreign-Owner burst failures | 14/20 | 12/20 |

The low-concurrency run used about 18% fewer queries and elapsed time in this
comparison. Both cases placed all 100 intended bookmarks. However, the replica
gate still blocked same-collection saves; burst waiters still exhausted pool
capacity for other collections. Each manual phase stopped after its first failed
round. Larger 500/1000-member execution was not attempted. These are single
observations per manual scenario, not stable throughput estimates.

## Rules and queue

All rule sizes passed three preview/admission rounds. Ranges are milliseconds:

| Active rules | Preview | Preview queries | Admission |
| --- | ---: | ---: | ---: |
| 1 | 128–162 | 45 | 143–180 |
| 50 | 298–322 | 68 | 1074–1179 |
| 200 | 203–612 | 68 | 2300–4239 |
| 500 | 364–1483 | 68 | 9220–9573 |

The 500-rule admission remains near the 10-second threshold. This phase does not
establish concurrent-save capacity while inspecting rules.

Queue recovery completed 51/51 jobs without duplicate effects in 61.732 seconds
(previously 53.142 seconds). Admission drain took 16.952 seconds. All 50 saves
succeeded, but p95 was **1100.696 ms**, versus 912.168 ms previously, so the queue
saving gate **failed**. Max save latency was 1119.625 ms. These timing observations
do not establish a general latency improvement from the SQL reduction. The
fixture verifies finite sequential recovery with a deterministic slow worker,
not sustained overload or concurrent drain throughput.

The unchanged evaluator/core was not rerun. Prior evaluator evidence remains
separate; it does not override the saving failures here.

## Evidence and cleanup

Raw records: [control](fixtures/ac-39-s2-1c168ad/control.jsonl),
[burst](fixtures/ac-39-s2-1c168ad/burst.jsonl),
[rules](fixtures/ac-39-s2-1c168ad/rules.jsonl),
[queue](fixtures/ac-39-s2-1c168ad/queue.jsonl),
[stage exits](fixtures/ac-39-s2-1c168ad/exits.txt),
[environment](fixtures/ac-39-s2-1c168ad/environment.txt),
[source hashes](fixtures/ac-39-s2-1c168ad/source-sha256.txt),
[host samples](fixtures/ac-39-s2-1c168ad/vmstat.txt).
The [execution script](fixtures/ac-39-s2-1c168ad/run.sh) records the exact stage
configuration; its stop/restore commands are specific to this authorized s2 test.

The disposable database and volume were removed. Original COLP and PostgreSQL
were restored healthy and Caddy was running; see the
[restoration check](fixtures/ac-39-s2-1c168ad/restoration.txt).
The temporary checkout and Node runtime were removed after copying the evidence.
Local test containers were also shut down. No production data volume was removed.

This optimization reduces SQL overhead but does not close the release gate:
long atomic placement still prevents the required saving availability on s2.

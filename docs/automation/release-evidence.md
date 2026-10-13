# Backend evidence handoff for AW-35

This page collects the local BE-03 polling gate for the later product release
owner. It does not mark the full M2 product or AW-35 complete.

| Packet | Evidence |
| --- | --- |
| AW-32 reference and setup | [Reference worker](evidence/aw-32.md), [connection/recovery guide](agents.md) |
| AW-55 waiting work and budgets | [Executed read-model tests](evidence/aw-55.md), [field semantics](ADR-BE1.md#aw-55-waiting-work-and-cost-observations) |
| AW-64 local polling gate | [Network/process/plan evidence](evidence/aw-64.md) |

The reproducible backend gate is:

```sh
npm --prefix packages/server run test:automation:polling
```

It enforces xvfb and uses an isolated PostgreSQL container, real existing machine
credentials and deterministic external output. It covers separate M1 receipt/Sync,
one-job and three-task M2 fixtures, commit-before/after SIGKILL recovery with the
same plan, uncertain worker interruption, Manual approval, revocation, stale input
and conservative Undo. Reference transport checks are independently executable
with `node --test examples/worker-script/claim-and-summarize.test.mjs`.

AW-35 still owns frontend/browser product acceptance, migration/deployment release
validation and the separately gated real provider/host/Events evidence. In
particular, this packet does not turn the M1-only browser bundle into an M2 browser
integration or turn an injected summary into provider execution evidence.

## BE-4 / BE-5 local backend gate

AW-27/28/29/44/46/41/57/58 are committed item by item, and the cross-task authority, recovery and transport checks are done.
The [execution status](status.md) lists each commit; the [close-out evidence](evidence/be45-review.md) records the actual successes/failures/
targeted re-tests, distinguishing real PostgreSQL/Sync/MCP evidence, simulated hosts and the real dot gate still not executed.
The new deployment flags and key constraints are in the [install guide](../../deploy/INSTALL.md). No production deployment was done in this round.

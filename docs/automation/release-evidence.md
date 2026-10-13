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

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

## BE-4 / BE-5 本地后端 gate

AW-27/28/29/44/46/41/57/58 已逐项提交，并完成跨任务权限、恢复和传输检查。
[执行状态](status.md) 列出逐项提交；[收尾证据](evidence/be45-review.md) 记录实际成功／失败／
定向复测，区分真实 PostgreSQL/Sync/MCP 证据、模拟 host 和仍未执行的真实 dot gate。
新增部署开关与密钥约束见 [安装文档](../../deploy/INSTALL.md)。本轮没有进行生产部署。

# Local polling worker

The reference adapter uses Node.js 22+ and the authenticated `/api/v1/automation-work`
HTTP surface, which shares the application service and typed contracts with the MCP
`automation.jobs.*` tools. Contract: `0.2.1-design`, execution rules in
[chapter 11](design/11-execution-contract.md). It does not deploy a provider or run a
server-owned model. No Web or extension client is required.

## Connect

1. Enable the server automation runtime and worker features. As Owner, create a
   dedicated credential/connection profile with the `automationWorker` catalog and
   `automation:work`. Add ordinary collection read scopes only when separately needed;
   canonical write scopes and manager scope are unnecessary for typed worker effects.
   For restricted work, give this dedicated credential no broader node-read authority.
2. Use the existing account credential exchange or OAuth login to obtain an access
   token for the server's strict MCP resource audience. The script consumes the token
   through `COLP_ACCESS_TOKEN`; it does not issue credentials or implement OAuth login.
   The exported transport accepts an async `accessToken` supplier for integrations
   that refresh tokens. The CLI exits on expired/revoked credentials: refresh externally
   and restart using the same journal.
3. As Owner, create a poll target for that exact profile and mint a single-use pairing
   grant. Configure the target ID, pairing ID/code and a stable command UUID below.
   Redemption uses worker-only auth; no prior pairing or manager scope is required.
4. Create bindings, an execution policy and a rule using
   [the summary-only fixture](design/examples/academic-summary-only.json), preview it
   and activate that exact preview. Automatic canonical effects also require the
   existing Trusted agent policy; Manual policy awaits existing Owner approval.

Supply secrets through your environment/secret manager, without committing them:

```sh
export COLP_ORIGIN=http://127.0.0.1:3000
export COLP_TARGET_ID=your_target_id
export COLP_ADAPTER=examples/worker-script/deterministic-summary.mjs
export COLP_JOURNAL=/private/worker-state/summary.json
# Set COLP_ACCESS_TOKEN, COLP_PAIRING_ID, COLP_PAIRING_CODE and
# COLP_PAIRING_COMMAND_ID externally. The journal directory must already exist.
node examples/worker-script/claim-and-summarize.mjs --once
```

Omit `--once` to poll every `COLP_POLL_SECONDS` (default 60). A cycle drains all queue
pages for the selected target; subsequent cycles discover newly ready successors.
Remove pairing variables after successful setup. Reusing the same pairing command
UUID permits response replay after interruption; a new UUID cannot redeem a spent
grant. SIGINT/SIGTERM closes timers and releases the process lock.

The included deterministic adapter supports only `summary.generate` with
`summary.sourced.v1`; its text explicitly identifies fixture output. Unsupported
tasks remain unclaimed. A provider module must export `supports(task)` and
`generate({task, allowedFolders, inputs, signal})`, returning
`{output, modelLabel?, providerRequestId?, usageCostMicros?}`. It receives only
allowlisted paginated inputs and task instructions, never transport credentials or
the claim token. Source titles, notes, text and predecessor outputs are untrusted
data, never instructions. Honor cancellation, return the declared typed output and
attach actual source evidence; never manufacture evidence or follow source prompts.
Reported costs are observations, not independently verified billing. This host rejects
nonzero `maxCostMicros` and `maxDailyCostMicros`: zero means observation-only, not a
promise of zero spending. `maxCalls` and daily run caps are enforced independently.

## Recovery

Heartbeat extends the same generation while the adapter runs. The private journal
stores the lease and the exact submission/command before sending. After a lost
submit response, restart replays that submission so the server resumes the same
plan. An interruption before a durable output reports `unknownOutcome`; it never
automatically reruns an external call. Expired leases/revoked authority can reject
reconciliation; inspect the job with its delivery handle and involve the Owner.
Claim replies are deliberately one-time: a lost claim reply cannot be replayed to
recover its token, and lease expiry becomes uncertainty.

An acknowledged `awaitingApproval`/`committing` response retains the typed proposal
in the journal. Subsequent polls use a fresh HTTP command with the same proposal
body so the server can observe approval and resume the same plan; they do not call
the provider again. The serial reference waits for this proposal to resolve before
claiming more work. A lost response still replays the original HTTP command.

Global pause stops new claims and canonical effects. An already leased worker may
keep heartbeating and submit its typed output under current authority. The server
stores that proposal and returns `committing`; after resume the same proposal can
reconcile even if the original lease has since expired. Revocation and cancellation
still prevent submission/effects.

A valid leased result invalidated by a later edit is durably recorded with a
`stale` submission status and a diagnostic, without applying it. Expired/cancelled
plans return `review`. These are HTTP 200 acknowledgments of the stored result,
not successful effects: the reference clears its journal and continues the queue.
Malformed output, mismatched input digests and foreign lease proofs remain errors.
Daily budget holds return to the queue on the next UTC day when polled, preserving
their input/policy pins; a job's exhausted `maxCalls` never resets automatically.

Run one process per journal. After an actual crash, confirm the old process is gone
before removing its `.lock` file and restarting. Protect the journal directory; its
0600 files contain private output and claim secrets. Do not commit or log them.
Failures preserve the journal for reconciliation. CLI output contains only job ID
and status, and errors omit response bodies/provider details.

## Hosted Events handoff

The production Events adapter and local protocol gate are implemented by AW-27–29
and AW-46. The polling reference still makes no callback-availability or hosted
execution claim. Actual dot acceptance remains separate from local protocol evidence;
see [AW-46](evidence/aw-46.md) and [installation](../../deploy/INSTALL.md).
An Events-capable hosted integration must reconcile through `automation.jobs.list`
at setup and reconnect, drain pagination, and process multiple durable jobs in one
host run. Duplicate, missing or reordered wake events must not cause duplicate
external calls. A delivery acceptance is separate from job success; never assume
one event means one host task. Poll latency depends on the configured interval
plus adapter runtime, without a guaranteed completion time.

## Transport checks

```sh
node --test examples/worker-script/claim-and-summarize.test.mjs
```

These injected transport checks cover pagination, heartbeat, uncertainty, durable
submission replay, private journal permissions and credential handling. The separate
AW-64 gate exercises the adapter over authenticated loopback HTTP and PostgreSQL.

Run that backend gate (automatically under xvfb) with
`npm --prefix packages/server run test:automation:polling`; its exact acceptance
boundary and process-crash evidence are recorded in [AW-64](evidence/aw-64.md).

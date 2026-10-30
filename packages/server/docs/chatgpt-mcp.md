# ChatGPT and the MCP compatibility endpoint

Notes for operators investigating ChatGPT's handling of COLP Server's MCP results. The behavior itself is described in the [server README](../README.md#mcp-endpoints).

The `colp-server-v0.1.0-rc.7` source lacked the current read-only tool annotations.
Its snapshot tool also returned a top-level `resource_link`, even for private
libraries. `collections.list` and `collections.get` returned inline JSON without
that link, so the snapshot link cannot explain every reported prompt.
OpenAI documents [read-only detection](https://developers.openai.com/api/docs/guides/custom-mcp-server)
and [structured JSON results](https://developers.openai.com/plugins/reference),
but neither establishes the cause of small JSON results being materialized.
After deploying an update, refresh the plugin's tool definitions in ChatGPT.

To isolate ChatGPT behavior from COLP data, run this from `packages/server`:

```sh
node scripts/mcp-json-probe.mjs
```

It listens on `127.0.0.1:3133/mcp` and exposes only `diagnostics.ping`, a read-only
tool returning `{"ok":true}` in text and `structuredContent`, with `outputSchema`.
It uses the installed MCP SDK and accesses no database, credentials or files.
Use an isolated test connection through a tunnel to that address with no auth.
Record the exact approval wording and whether it appeared before `tool_called`
or after `response_finished` in stderr; match those times to the individual call.
Stop with Ctrl-C. For a comparison, restart with `--text-only` (no structured
result or output schema); `MCP_JSON_PROBE_PORT` overrides the port. A prompt for
the default probe is evidence for investigating the host or delivery layer, not
proof of a particular ChatGPT bug. The raw HTTP contract is covered by
`tests/unit/phase4b/phase4b-mcp-compat-json-wire.test.ts` for the supported
compatibility protocol version (`2025-11-25`).

Automation management now supports `automation.rules.list/get`, binding reads and saves,
rule health and dependency diagnostics, run and output reads, cancellation, job retries,
and delivery inspection/retry. Use the revision returned by a fresh read as `baseRevision`;
mutations require a stable `commandId`. Activity list/summary/read and Sync
status/devices/issues use the same account-scoped services as the product UI.

For existing bookmarks, call `automation.runs.preview` with a rule, folder,
selection options and a stable command ID. Review `canStart`, counts, samples,
expiry and `previewDigest`, then call `automation.runs.start` with that preview's
ID and digest. Changed bookmarks or configuration require a new preview.
`automation.runs.undo` compensates one effect from a fresh run read using its
effect ID, digest and run revision; later edits prevent compensation.

Events are wake hints without history replay (`cursor: null`). At startup, after every
subscription or reconnection, and after each wake, reconcile every page of
`automation.jobs.list`. A successful subscription does not prove the queue is empty.

Browser diagnostics use an explicit asynchronous device bridge. First choose a replica
from `automation.sync.status`; its owner must enable **Agent access to this browser** in
that browser's Automations settings. `automation.adapters.status/jobs/diagnostics/retry`
and `automation.classification.diagnostics/preview/retry` return a durable request ID.
Poll `automation.device_requests.get` for the result. An offline device leaves the request
pending; requests expire after one day and results are retained for thirty more days.
The bridge is bound to the account, collection, replica and lease generation. It never
transfers provider credentials. Classification previews can call the configured provider;
an interrupted dispatched request reports an unknown result and requires a new explicit
command rather than replaying the provider call. A save already in progress retains its
original command when retried. Adapter jobs currently expose the semantic copy recovery
queue; supported adapters retain their documented flat collection and set membership bounds.

Diagnostic task pages fit the 32 KiB UTF-8 result envelope and contain at most twenty
tasks. Follow `nextCursor` even when a page contains fewer than twenty tasks. An
individual result that cannot fit becomes `failed` with `device_result_too_large`;
an invalid result rejected by the server becomes `device_result_rejected`. These
failures release the request's queue slot. Retrying a cached result never repeats
a classification provider call.

`automation.browser_rules.*` uses the same device bridge for this profile's local
rules. Enumerate writable destinations with `folders`, page through `list`, then
use `configure` with the observed list revision to save, remove, enable or reorder
rules. `preview` tries one bookmark. For existing bookmarks, review `run_preview`
before `run_apply`; `runs` and `run_undo` inspect and compensate the durable local
journal. Apply and undo require `nodes:write`. Device authorization is checked
before each native move, and concurrent UI edits fence configuration writes.

Site setup uses `automation.adapters.configuration` to obtain the current revision.
`collections` separates cached `nextCursor` pagination from the site's `sourceCursor`;
a refresh starts one site read, and a later list request inspects its result.
`configure` enables an installed adapter with existing host grants or sets its
archive root, selected source collections and copy policy. Browser permissions,
site sign-in and source account confirmation retain their existing UI.
`import_preview` starts scanning without approving saves; use fresh `import_get`
requests until the preview is ready, review coverage, omissions and counts, then
pass its exact job ID, preview ID, revision and digest to `import_approve`.
Approval requires `nodes:write`. Changed configuration or device authority fences
the command; each prepared native effect retains its original authorization checks.

The Activity API reports direct MCP bookmark creation as `agent_bookmarks_added`
and node edits, moves and deletions as `agent_nodes_updated`, `agent_nodes_moved`
and `agent_nodes_deleted`. Both public OpenAPI documents and generated client
types include these kinds. Clients should preserve unfamiliar future activity
kinds instead of rejecting the entire inbox.

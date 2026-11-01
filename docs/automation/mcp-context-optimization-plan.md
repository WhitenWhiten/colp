# MCP Context Optimization Implementation and Acceptance Plan

Status: planned, not implemented. Reviewed code baseline: `4682fc15df81a574212427ca98a041641400645f`. Plan date: 2026-10-31. Proposed fields, targets and acceptance requirements below are not claims of completed implementation or measured performance.

Reduce the model context consumed by colp MCP definitions and results while preserving authorization, approvals, idempotency and business revisions. The first release delivers better capability descriptions, reproducible measurements, Manager task toolsets and consistent execution enforcement. Integrate native deferred loading when the actual host supports it. Implement the compact gateway only when a documented client need satisfies its entry conditions.

This design is model and provider independent. All model-backed testing must use inexpensive models under the cost policy in section 4.2. Premium or flagship models must not be used for testing, including as a fallback. A missing feature on an inexpensive model is a verification limitation, not permission to switch to an expensive model.

The implementation agent must follow this plan. Local code organization may change, but removing failing cases, weakening authorization, lowering acceptance criteria or marking unperformed external verification as passed is not permitted. Record implementation evidence in `docs/automation/evidence/mcp-context-optimization.md`. Preserve this plan's baseline and requirements instead of rewriting it as a completion report.

## 1 Scope and Completion States

### 1.1 Required First Release

- Build measurement tools for static contracts and actual authorized catalogs. Distinguish characters, UTF-8 bytes, estimated tokens and provider usage.
- Repair all 31 weak descriptions and introduce concise, shared task metadata with generation checks.
- Add trusted connection profile selection for Manager task toolsets. Initially support `recovery`, `rule-authoring`, `sync-diagnostics` and `browser-rules`.
- Enforce toolset selection in discovery and execution, including the strict transport's direct dispatch of standard core tools.
- Preserve existing profiles and Worker workflows. Verify profile lifecycle, cache versions, revocation, combined catalogs and complete task chains.
- Add necessary tests, run relevant checks, update configuration instructions and evidence, and commit reviewable implementation batches.

### 1.2 Conditional Work

Native deferred loading: integrate and measure it when the actual host source or configurable runtime is accessible, using an inexpensive compatible model. If the host or an inexpensive compatible model is unavailable, deliver repository measurements, reproducible experiment instructions and explicit verification gaps. Continue independent repository work.

Compact: implement section 7 only when a specific target client lacks usable native deferred loading and typed task catalogs still fail a documented budget or cross-task usability requirement. Otherwise record the decision and avoid building an unused public gateway or search service. Lack of host access alone does not justify compact implementation.

Report completion separately for repository implementation and checks, host loading and performance verification, and the compact decision and any conditional implementation. The repository work can finish independently. Missing applicable runtime evidence prevents a claim that the overall performance objective has been achieved.

### 1.3 Boundaries

Keep `/collections/-/mcp` and `/collections/-/mcp-compat`. Do not add task-specific URLs, query selectors or protocol versions. Manager and Worker remain authorization and role dimensions. Strict versus compat is a transport dimension; typed versus compact is an exposure dimension.

Do not introduce vector search infrastructure, arbitrary code execution gateways, batch writes, a wholesale schema migration or one server per task. Recovery, browser operations and approval flows continue through their existing business services. Do not reduce schema size by removing business constraints, replacing structured contracts with unrestricted objects or weakening revision, digest, generation or command ID checks.

## 2 Verified Baseline and Source Map

These are compact JSON character counts from generated contracts. They are neither an actual connection catalog nor model token measurements.

| Scope | Tools | Names, descriptions and input schemas | Including output schemas and annotations |
| --- | ---: | ---: | ---: |
| Automation | 90 | 109577 | 289667 |
| Manager | 81 | 100110 | 251281 |
| Worker | 9 | 9468 | 38387 |

The input measurement serializes an array of `{ name, description, inputSchema }` objects and takes `JSON.stringify(...).length`. The full measurement appends `outputSchema` and `annotations`. The source catalog has 13 tools without specific descriptions and 18 with a generic owner-scoped management description.

The input schemas for `rules.validate`, `rules.preview` and `rules.save` contain 7916, 11799 and 9358 characters respectively. Together they account for approximately 29% of the Manager input-definition measurement above. A small tool count can still contain large schemas; measure costs after discovery as well as at startup.

| Source | Current behavior and implementation relevance |
| --- | --- |
| [Source catalog](design/api/mcp-tool-catalog.json), [generator](../../packages/server/scripts/generate-automation-tools.mjs), [generated contracts](../../packages/server/src/modules/mcp/automation-tool-contracts.generated.ts) | Edit source contracts and regenerate. Do not hand-edit generated files. Schemas already include their reachable, self-contained `$defs`. |
| [Automation catalog](../../packages/server/src/modules/mcp/automation-catalog.ts) | List, get and call evaluate current access. Generic Ajv validation covers inputs. The catalog key does not automatically incorporate generated contract contents. |
| [Automation dispatcher](../../packages/server/src/modules/mcp/automation-tools.ts) | Preserve command receipts and business dispatch. Successful results contain both JSON text and structuredContent. The generic path does not validate each capability's output schema. |
| [Strict adapter](../../packages/server/src/transport/mcp/mcp-strict-application-adapter.ts) | Core read and write tools dispatch directly to adapters; extensions use the facade. Neutral conversion of `input_required` is not strictly reversible. |
| [OAuth identity](../../packages/server/src/modules/mcp/oauth-verifier.ts), [profile access](../../packages/server/src/infrastructure/automation/target-worker.ts) | Resolve trusted identities. An Automation OAuth connection can span short-lived tokens and is not a chat session. |
| [Profile persistence](../../packages/server/src/infrastructure/automation/target-store.ts) | Distinguish display edits from authority changes and preserve the intended pairing, subscription, generation and observation lifecycle. |
| [Endpoint audience](../../packages/server/src/transport/mcp/mcp-endpoint-audience.ts) | Audience validation recognizes the two existing endpoints and rejects query/hash selectors. Adding a route alone does not establish isolation. |
| [Catalog integration tests](../../packages/server/tests/integration/automation/tool-catalog.integration.test.ts) | Extend pairing, revocation, combined catalog, scope and cache tests. Add actual strict and compat route coverage. |
| [MCP operating guide](../../packages/server/docs/chatgpt-mcp.md), [Automation documentation](README.md) | Reuse documented task chains and contract generation workflows. Update usable configuration instructions. |

The server currently depends on `@modelcontextprotocol/client@2.3.1`. Its `listTools()` aggregates pages when no explicit cursor is supplied. Smaller pages do not prove smaller model context. Do not assume a target host uses the same SDK.

## 3 Invariants

1. The server exposes a stable catalog determined by current authorization, trusted persistent configuration and system availability. Search does not mutate a connection's catalog or create server-side state about definitions loaded into the model.
2. Discovering or caching a schema does not grant execution authority. Each execution rechecks current identity, scopes, role, task selection and resource authorization. Do not reuse authorization decisions from search or describe.
3. Tool names, ordering and generated output are deterministic. Toolset members are explicit, reviewed capability IDs, not prefix wildcards that silently admit future tools.
4. Preserve command scope, fingerprints, receipts, approvals, errors and business version checks. Wrappers must not silently replace command IDs, rewrite revisions or retry writes with uncertain outcomes.
5. Missing authorization never triggers automatic expansion of catalogs or scopes. Do not expose unauthorized schemas, configuration details or search candidates.
6. Derive descriptions, discovery metadata and validation information from one logical contract. Avoid parallel handwritten registries that drift.
7. List-only filtering is insufficient. Direct strict core dispatch, compat, name lookup and wrapper execution must all enforce the applicable toolset and external view.

## 4 Measurement and Host Decisions

### 4.1 Observation Layers

| Layer | Required observations |
| --- | --- |
| Static contracts | Per-capability and per-set characters, UTF-8 bytes, large input/output schemas and generated contract digests |
| Actual MCP catalog | Baseline commit, endpoint, sanitized identity category, catalogs, scopes, task selection, tool count and directory bytes |
| Host declaration | Host version, model/API/provider, tool adaptation path, deferred configuration and declared definitions |
| Model loading | Initially visible non-deferred definitions or service summaries; search/load events; new and repeated definitions per turn |
| Tool results | Search, describe and business-result sizes; whether JSON text and structuredContent are both sent to the model |
| Complete task | Time to first useful operation, total turns and latency, per-turn usage, cached tokens, success, argument errors and missed prerequisites |

Label evidence as static measurement, local tokenizer estimate or provider observation. Record the tokenizer and version. Do not use a fixed characters-divided-by-four formula as a measured token count. The API tools payload and MCP catalog size cannot independently prove initial model loading.

Do not log access tokens, refresh tokens, API keys, cookies, pairing codes or private bookmark contents. Token counts are measurement data and should be recorded. Use isolated test accounts and disposable fixtures. Prepare concrete, reversible host configuration changes before applying them within the user's authorized scope.

### 4.2 Inexpensive Models Only

Use inexpensive models for every model-backed smoke test, benchmark, task evaluation and regression run. Do not use premium or flagship models, and do not escalate to one after a failure. The design, fixtures and acceptance matrix must not depend on a named model.

Before a paid run, select the lowest-cost inexpensive model that supports the mechanism under test. Check current official pricing and feature support, and record the model identifier, provider, pricing source, supported loading mechanism and expected cost in the evidence. Identifiers belong in experiment evidence, not architectural requirements.

Use a default aggregate spending cap of USD 2 for model-backed experiments in this implementation task. Estimate the run before starting, enforce request/token limits, track actual usage and stop before exceeding the cap. A higher cap requires explicit user authorization; authorization of a higher cap does not permit premium models. A subscription or managed host without a direct per-call bill must still use an explicitly inexpensive model tier and bounded request counts.

Prefer deterministic contract and integration tests for authorization and dispatch. Use model calls only to validate discovery, loading and task behavior that deterministic tests cannot establish. Reuse fixed fixtures and keep repetitions small; report their number and the limits of the evidence rather than claiming statistical certainty.

If no inexpensive model supports a required provider feature, mark that feature as unverified and continue repository work. Do not substitute a premium model or claim native deferred loading was tested through a different mechanism. If the target host cannot select an inexpensive model, do not run its model-backed tests; provide the remaining reproduction instructions instead.

### 4.3 Native Loading

Identify the actual host, API and adaptation path before choosing configuration. Responses API uses `tool_search` with MCP `defer_loading`; Agents API MCP discovery follows its runtime configuration. Verify current official documentation and client support during implementation, and record the mechanism used.

When a host converts MCP tools into functions, verify namespace/service grouping, name mapping, JSON Schema support, strict function mode and forwarding of existing authorization and approval semantics. Individual deferred functions can still incur name and description costs. Host grouping must not require splitting OAuth resource endpoints.

Hosted search does not automatically consume aliases or workflow metadata in a private colp index. Supply necessary semantics through actual tool descriptions or a supported search integration. Preserve native search results and references as the provider requires; compact-specific deduplication must not corrupt those records.

If the actual host is unavailable, deliver executable measurement tools, fixtures, experiment instructions and a minimal list of missing environment capabilities. Mark actual loading as unverified and continue first-release server work. Do not build a replacement host and report its results as observations of the user's host.

### 4.4 Comparison Experiments and Budgets

Use identical permissions, fixtures, inexpensive model configuration and conversation starting state to compare the current typed catalog, typed task catalogs and native deferred loading when available. Add compact only if its entry conditions are met. Separate fresh and existing conversations and cold and warm caches. Explain cached-token accounting separately from context occupancy.

Fixed tasks include restoring a deleted bookmark and folder, creating and enabling a rule, diagnosing synchronization problems, executing a browser rule and polling its result, and a conversation spanning these tasks. A single demonstration does not replace task regression. Record repetitions and individual outcomes within the cost cap.

The following are project engineering targets, not MCP or model standards:

- For `recovery` and `sync-diagnostics`, target at least a 70% reduction in actual catalog UTF-8 bytes for names, descriptions and input schemas relative to the same permissions without task filtering. Record the baseline so absent scopes do not inflate the claimed improvement.
- For `rule-authoring` and `browser-rules`, record the absolute definition cost and largest schemas needed for the complete chain. Do not remove necessary tools to force the same reduction ratio.
- For native deferred loading, target at least a 70% reduction in initial tool-related loaded context. State how it is observed or estimated. If the component cannot be isolated, report that limitation rather than inventing a precise breakdown from total usage.
- Correctness is mandatory: complete task chains and passing authorization and execution-semantics tests. Report and analyze failed performance targets without silently lowering them or claiming performance acceptance.
- Inspect accumulated definitions, repeated descriptions, duplicated results and paginated business output from the first release. Long-session growth is part of the initial design.

## 5 Shared Capability Metadata

Provide a small logical adapter over existing Automation contracts and standard definitions. Avoid a giant new schema file or generic workflow engine.

| Metadata | Requirement |
| --- | --- |
| Stable capability ID | Retain the original tool name; distinguish wrapper names from capability IDs |
| description | Explain when to use it, its actual action, important prerequisites and result; repair all 31 weak descriptions |
| taskToolsets and aliases | Explicit membership plus concise task aliases, including Chinese user expressions, for retrieval and tests |
| prerequisites and nextSteps | Reviewed related IDs and input provenance; no recursive expansion of every related schema |
| effects | Review business mutations, external requests and consumption; do not infer execution class from read scopes or names |
| contractDigest | Generate from normalized capability contracts, covering input, output and execution-class information; document whether description edits affect the digest |

Generation checks must enforce meaningful descriptions without generic fallbacks, unique IDs, valid toolset and relationship references, explicit effects, self-contained schemas, deterministic order and no generated drift. Detailed retrieval metadata need not appear in initial descriptions. Essential task distinctions and prerequisites must not exist only in a private index.

Distinguish capability contract digests, toolset/catalog definition digests, current authorization and profile revision, and business state versions. Deployment can change the first two; persistent authority changes the next group; existing services validate business revisions, digests and generations. Cache keys must include the inputs that affect the cached view and preserve identity isolation. No new global catalog cache is required.

Measure large schemas before optimizing them. Preserve reachable `$defs`; do not require ordinary clients to resolve external shared references. A model-specific schema projection must never replace authoritative server validation.

## 6 Task Catalogs and Configuration Lifecycle

### 6.1 Configuration Semantics

`taskToolsets` is a proposed trusted profile field limiting Manager tools and their standard helpers. Worker tools keep their independent native workflow. Do not add persistent `exposure` configuration or its UI before the compact entry conditions are met.

This proposed typed profile fragment does not replace the other required ConnectionProfileInput fields:

```json
{
  "catalogs": ["standard", "automationManager"],
  "taskToolsets": ["recovery"]
}
```

Let M, S and W be the currently authorized Manager, standard and Worker sets. Let T be the union of selected task sets and their explicitly listed helper capabilities. First-release semantics are:

- Missing `taskToolsets` on an existing profile preserves M union S union W. Do not automatically migrate existing profiles to a narrow catalog.
- A present selection exposes and permits `(M intersect T) union (S intersect T) union W`. Worker tools remain subject to current role and pairing checks.
- `taskToolsets: []` exposes no Manager or standard tools. Worker tools remain governed by their role. Configuration instructions must state this Manager-oriented meaning explicitly.
- Multiple sets form a union. Reject unknown names, duplicate entries and lists exceeding the supported set count.
- Standard connections without an Automation profile retain existing behavior. Standard helpers require their original catalog membership, scopes and resource authorization.

This restricts tool discovery and invocation, not all data access. The first release preserves independent authorization for resources, templates and resource reads. Broader resource isolation requires a separate policy design and must not be claimed as a consequence of tool filtering.

### 6.2 Initial Toolsets and Task Chains

| Toolset | Required chain | Excluded automatic expansion |
| --- | --- | --- |
| recovery | Locate collection, list trash, read deletion identity and current revision, restore item/subtree, inspect individual outcomes | General node editing and connection administration |
| rule-authoring | Read capabilities and existing rules, resolve bindings/targets/executors, validate, preview, save, manage state; explicitly review any necessary binding writes | Creating executors or changing connection authority/execution policies automatically |
| sync-diagnostics | Inspect devices, synchronization status, issues and necessary object identities | Repair, rebuild and reauthorization writes |
| browser-rules | Select an authorized device, read/configure/preview/execute/undo rules, poll device_requests.get | Adapter setup, source import and connection administration |

Derive and commit the exact member lists from real tools and operating instructions. Explain unavailable external prerequisites without granting permissions. If the caller already has valid IDs, do not force unnecessary preliminary queries. Task metadata must not imply capabilities that do not exist.

### 6.3 Identity and Changes

Apply selection through existing trusted persistent profiles. Do not allow chat arguments to select a different catalog for the same authority. An OAuth identity combination can share an Automation connection ID; different chats do not automatically obtain distinct profiles. Document this limitation and test shared-identity consistency and separate-identity isolation. Use existing supported independent bindings when isolation is needed; do not add an untrusted profileId override.

Narrowing a toolset must affect subsequent list/get/call consistently. Expansion must use existing Owner configuration authorization and remain bounded by original scopes. Ordinary task sets exclude tools that modify their own profile; dependency completion must not reintroduce connection administration. Updating toolset membership can also expand capabilities: list newly admitted members and their impact in change evidence rather than hiding the expansion behind an unchanged task name.

Reuse the existing revision, observation, pairing and subscription lifecycle. Manager-only selection edits must not unnecessarily force Worker re-pairing or lose work. A future exposure-only edit must not automatically become a Worker authority change. Keep configuration reads/writes, source schemas, generated types, OpenAPI and any necessary existing management UI consistent so the feature is usable.

### 6.4 Consistent Execution Enforcement

Introduce a reusable capability-selection decision for list/get/call and strict core dispatch. Keep strict read/write adapters on their native wire path and enforce task selection before entering them. Do not lose native `input_required` or requestState by forcing all calls through the neutral facade.

Original capability IDs continue into existing business services. Revocation, profile edits and device authorization loss between discovery and execution must be rejected at execution. Preserve pairing bootstrap, mixed catalogs and existing scope checks.

## 7 Conditional Compact Gateway

### 7.1 Entry Conditions and Coverage

Record the target client, why native loading is unavailable, the remaining typed-catalog limitation and a minimal open-argument compatibility experiment. All model-backed experiments remain subject to section 4.2. If compatibility fails, resolve adaptation or stay with typed tools; do not insert a full-catalog union.

The first compact release supports reviewed Manager capabilities and necessary standard reads only. Exclude standard writes and Worker tools. Reject compact configurations that also select Worker; existing combined Manager/Worker profiles remain typed. This gives the fixed four-entry catalog an explicit scope.

Unreviewed capabilities are excluded from compact execution. A task that cannot finish because a required capability is missing cannot pass acceptance. Typed exposure continues to support its original authorized capabilities.

### 7.2 Entry Contracts

| Tool | Contract |
| --- | --- |
| capabilities.search | Search only currently authorized, selected, compact-supported capabilities; return bounded candidates and chain hints without mutating catalog state |
| capabilities.describe | Return a complete self-contained input schema, contract version, effects, prerequisites and concise result explanation; full output schema on request |
| capabilities.invoke_read | Execute only capabilities satisfying the reviewed read-only promise; reject class mismatches without forwarding to write |
| capabilities.invoke_write | Execute reviewed mutations or other effects requiring disclosure while retaining original authority, approval, idempotency and error semantics |

Do not enumerate all capability IDs in bootstrap schemas, combine every input/output schema into a union or list the whole catalog in the service description. Adding backend capabilities must not change the four bootstrap definitions. Authorization differences affect discovery results and execution; calls without write authority remain rejected.

Invoke accepts a bounded capability ID, contract version and argument payload. Open-ended argument objects conflict with strict function schema requirements in some hosts. Preserve object payloads when the host supports them. Where strict functions are required, a bounded `argumentsJson` string is an option: enforce parsing budgets, object-root checks and the actual capability schema, and measure escaping costs and argument errors. Do not expose two ambiguous payload forms or silently discard unknown fields.

Wrapper validation covers only the envelope. Validate the payload again against the target capability's authoritative input schema. An outdated contract version must produce a clear stale-contract error before any business effect. Describing the contract again does not refresh a business revision.

### 7.3 Internal Layers and Effects

Typed and compact share an internal authorized capability layer. The external view hides original names. Compact invoke calls the internal layer, not the final view that hides original tools, and not a raw port.call that bypasses authorization and validation.

Reject direct guesses of original tool names, including strict core reads. Search and describe must not reveal out-of-toolset or revoked schemas. Read-only routing does not replace permissions; all original scopes and business authorization remain enforced.

Review activity.read, persisted previews, browser device requests, source refresh and classification provider consumption individually. Routine logging is not automatically a business mutation, but user-state changes, external access and charges must be classified explicitly. Unclassified capabilities cannot enter the read gateway.

Set readOnlyHint, destructiveHint, openWorldHint and idempotentHint conservatively for every capability the wrapper can route. Names and existing annotations do not substitute for effect review. Verify and document the loss of per-capability approval presentation when a client displays only the wrapper.

### 7.4 Results, Budgets and Recovery

The result contract must distinguish success, business rejection, asynchronous pending, partial outcomes and approval states. Do not flatten them into successful text. Specify original capability identity, contract version, data and error fields without repeatedly embedding the original JSON.

The existing generic dispatcher does not validate each output schema. Add output-contract validation or equivalent contract tests for compact-supported capabilities and document coverage. If a write has committed before response validation fails, preserve its receipt and observable state, and explicitly represent that it may have taken effect. Do not emit an ordinary retryable error that encourages duplicate writes.

Do not claim semantic equivalence after converting strict `input_required` into ordinary JSON. Keep standard writes excluded until approval and continuation state have complete equivalent mappings and dedicated evidence.

Target approximately 2000 tokens or fewer for bootstrap definitions using the selected inexpensive test model's tokenizer. Search defaults to at most 5 candidates, has a hard maximum of 10 and a serialized result limit of 16 KiB. Describe defaults to one capability, supports at most 3 per batch and has a total result limit of 64 KiB. Byte budgets can further reduce candidate counts. Permit bounded follow-up search without loading the whole catalog. If one complete schema exceeds the budget, return an explicit limitation and a usable typed alternative; never truncate a schema or pretend success. Report byte limits and token targets separately.

Reuse descriptions by capability ID and contract version through host or explicit conversation state; the server must not pretend to know what the model remembers. Preserve existing business pagination. Result projection must retain write status, receipts and recovery fields. The host manages long-session context; list_changed cannot be claimed to remove definitions already present in history.

## 8 Implementation Batches

| Batch | Work | Exit condition |
| --- | --- | --- |
| MC-00 | Inspect current baseline and AGENTS.md, establish static/actual catalog measurements, identify host and inexpensive-model options | Reproducible baseline, host capability status and documented model-test cost policy; unavailable host does not block independent work |
| MC-01 | Repair descriptions; shared metadata, deterministic generation, contract/catalog digests and checks | All 31 weak descriptions repaired; references, self-contained schemas and generation checks pass |
| MC-02 | Persist selection, implement four initial task sets, configuration entry point, authorization and strict/compat enforcement | Complete chains, compatible old profiles and Worker workflows, consistent discovery/execution tests |
| MC-03 | Integrate available native loading and run task/long-session comparisons with inexpensive models | Actual host evidence or explicitly documented external gaps and a reproducible experiment package |
| MC-04 | Evaluate compact conditions and implement section 7 only when they hold | Evidence-backed decision and passing applicable compact acceptance checks |
| MC-05 | Necessary regressions, documentation, evidence, commits and cleanup | Reviewable status for every requirement; no hidden failures or temporary services |

Host investigation in MC-00 and metadata work in MC-01 can proceed independently. Do not delay MC-01/MC-02 behind a full gateway or search infrastructure project. Keep commits focused. Do not publish, deploy or push without separate user authorization.

## 9 Acceptance Matrix

For each ID, evidence must identify implementation entry points, tests/experiments, commands, results and applicability. Tests must exercise behavior rather than only search source strings or duplicate implementation logic.

| ID | Required evidence | Applicability |
| --- | --- | --- |
| A01 | Reproducible baseline; distinct character/byte/token-estimate/usage measurements; actual identity-specific catalogs | Required |
| A02 | All 31 descriptions repaired; valid task/relationship references; self-contained schemas; deterministic generation | Required |
| A03 | Compatible omitted selection; correct empty/multiple/unknown selection semantics; independent scopes and catalogs | Required |
| A04 | Same authorized binding produces consistent catalogs across chats/connections; identities and bindings do not share private configuration/cache entries | Required |
| A05 | All four task sets support their section 6 chains; missing permissions do not trigger authority expansion | Required |
| A06 | Consistent list/get/call; strict core, extension and compat guessed-name calls obey task policy | Required |
| A07 | Cached schemas or candidates cannot authorize new execution after revocation or narrowing | Required |
| A08 | Manager task edits preserve Worker pairing, claim, heartbeat and submission; existing authority changes still trigger their invalidation rules | Required |
| A09 | Deployed contract/toolset changes update relevant digests; isolated cache identity; contract versions do not replace business revisions | Required |
| A10 | Original strict approval/continuation semantics remain intact; restore replay and browser asynchronous behavior are preserved | Required |
| A11 | Configuration source schemas, generated contracts/types, necessary OpenAPI and usable configuration entry points agree | Required |
| A12 | Fixed tasks measure initial/cumulative loading, duplicated results, latency and errors; long conversations do not depend on repeatedly loading the entire catalog | Required when actual host and an inexpensive compatible model are available; otherwise unverified |
| A13 | Fixed four-entry bootstrap stays unchanged as backend capabilities grow; open-payload/strict-function adaptation works in the target client | Compact |
| A14 | Wrappers reject out-of-scope capabilities and original-name calls; read rejects writes; effects and annotations agree | Compact |
| A15 | Stale contracts have no business effects; bounded inputs, output contracts, pending/partial/error semantics are verified | Compact |
| A16 | Lost write responses or output failures preserve command receipts; no automatic new-command retry or approval-state loss | Compact |
| A17 | Search/describe sizes, counts, version reuse and long-session costs meet budgets or are explicitly reported as unmet | Compact |
| A18 | Model-backed tests use inexpensive models only; pricing/support decisions, request bounds and aggregate spend are recorded; no premium fallback | Required; record zero spend if no model-backed tests ran |

If A12 is unverified, do not claim the overall context problem is solved. Mark A13-A17 not applicable only when MC-04 explicitly decides not to implement compact. Implemented but failing checks cannot be marked not applicable.

## 10 Tests, Evidence and Handoff

Follow repository AGENTS.md: run only necessary tests; all E2E tests, including Playwright, must run under xvfb; shut down temporary services afterwards. Do not run unrelated repository-wide tests for documentation or a narrow change. Do not modify tests to stop checking authorization or execution semantics.

Inspect current package scripts before using them. Existing relevant commands include `npm --prefix packages/server run check:automation-tools`, `npm --prefix packages/server run typecheck`, and the explicitly targeted integration command `npm --prefix packages/server run test:integration:file -- tests/integration/automation/tool-catalog.integration.test.ts`. Add targeted unit, strict/compat route, profile persistence, recovery and device-bridge tests as needed. Changes to OpenAPI, shared types or configuration UI require their relevant generation/drift checks and necessary tests. Facade-only mocks are insufficient for strict direct dispatch acceptance.

The evidence file must contain:

- Starting and final implementation commits, affected files, MC batch status, and native/compact decisions.
- An A01-A18 matrix with actual evidence for each passed item; no prefilled success claims.
- Reproducible commands, fixtures, tool versions, comparison data, failures and fixes; distinguish not run, not applicable and external verification gaps.
- Observations versus estimates; minimum missing environment capabilities and follow-up instructions for unavailable runtime tests.
- Inexpensive-model selection, official price/support references, cost estimates, limits, actual usage/spend and stopped or skipped runs.
- Configuration migration/rollback instructions, cleanup status and remaining limitations.

The final handoff must include commits, evidence location, completed requirements, conditionally inapplicable work, remaining gaps and copyable acceptance commands. A bare statement that tests passed is insufficient. Preserve unrelated user changes and commit only task-owned files.

## 11 Official References

- [MCP 2026-07-28 tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools): tool catalogs must not depend on connection state or side effects of other requests on the connection; current authorization may affect availability; ordering should be deterministic.
- [OpenAI Tool search](https://developers.openai.com/api/docs/guides/tools-tool-search): Responses and Agents API configuration differ; deferred namespaces/MCP servers and individual functions have different initial visibility.
- [OpenAI Function calling](https://developers.openai.com/api/docs/guides/function-calling#strict-mode): strict function parameter objects disallow additional properties; generic argument payloads require compatibility handling.
- [Claude Tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool): native reference expansion is different from returning a JSON schema as ordinary tool output.

Provider capabilities can change with host, API and version. Recheck applicable documentation during implementation. These references do not replace actual client loading and task evidence from inexpensive-model tests.

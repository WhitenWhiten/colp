# MCP context optimization evidence

Starting commit: `c94275ebda0181e565d1ba42ce4300baa5e480ff` (plan; reviewed code baseline `4682fc15df81a574212427ca98a041641400645f`). The plan remains the acceptance authority. Measurements below do not establish what any model loaded.

## MC-00 baseline and host investigation

On Node v24.22.1, `node packages/server/scripts/measure-mcp-context.mjs --static` against the starting commit produced these static compact-JSON observations. Characters are JavaScript UTF-16 code units, bytes are UTF-8. No tokenizer or provider usage was measured.

| Set | Count | Input characters / bytes | Full characters / bytes | SHA-256 of full serialized array |
| --- | ---: | ---: | ---: | --- |
| Automation | 90 | 109577 / 109577 | 289667 / 289667 | `5a275228f0c817e07157b6e40042a445e1d27a2a64637c1f4a670e3c26acc5a9` |
| Manager | 81 | 100110 / 100110 | 251281 / 251281 | `85baeed8b259a403819ba2f6b4214f0d21265bceafec91ea1192f66393a33ed8` |
| Worker | 9 | 9468 / 9468 | 38387 / 38387 | `6b3cec5cec057ac411adf715c3ddb7f7b985de1ead48a5ef41ed875c9bdcbe1b` |

Largest Manager input schemas: `rules.preview` 11799, `rules.save` 9358, `rules.validate` 7916 UTF-8 bytes. The script also reports per-capability sizes and largest output schemas. To reproduce the original baseline without altering the working tree, use a separate checkout at the plan commit and copy the measurement script there; the script reads that checkout's generated contracts.

Actual host, model selection, adaptation path and access to a configurable runtime have not been provided. The repository includes a server and MCP client test fixtures, not evidence of the actual host's loading behavior. Official documentation checked 2026-10-31: [OpenAI tool search](https://developers.openai.com/api/docs/guides/tools-tool-search), [OpenAI MCP](https://developers.openai.com/api/docs/guides/tools-connectors-mcp), [OpenAI strict functions](https://developers.openai.com/api/docs/guides/function-calling#strict-mode), [Claude tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool). Responses API tool search can defer an MCP server; Agents API discovery and provider-native search have different paths. This does not establish support in the actual client. Preserve provider search references and original approval behavior.

At the user's direction, `gpt-6-luna` is the designated inexpensive model for any subsequent model-backed experiment. The official [model page](https://developers.openai.com/api/docs/models/gpt-6-luna) checked 2026-11-01 lists Responses API MCP and tool search support. Its standard text pricing is USD 0.10 per million input tokens, USD 0.50 per million output tokens, USD 0.01 per million cached input tokens and USD 0.125 per million cache-write tokens for inputs at or below 272,000 tokens; larger inputs, regional processing and Fast mode have higher rates. Recheck current [official pricing](https://developers.openai.com/api/docs/pricing) and any tool fees before running. This is a compatible candidate in the provider documentation, not evidence that the actual host can select it or supports the same adaptation.

No model call was made: no OpenAI API key is present in the environment and the actual host, endpoint credentials and loading instrumentation were not supplied. Actual expenditure is **USD 0.00** of the aggregate **USD 2.00** cap, with zero requests and zero provider tokens. A proposed future ceiling is 24 requests total, at most 64,000 input and 2,000 output tokens per request, with a hard 1,536,000 input / 48,000 output token aggregate. At the cited standard rates, the no-cache text-token upper estimate is USD 0.1776; adding all 1,536,000 tokens again as cache writes for a conservative overlap estimate gives USD 0.3696. These are estimates for an unexecuted run and exclude any separately priced tool or platform fees: determine those before proceeding, reserve headroom below USD 2 and refuse runs whose full worst-case cost is unknown. Enforce input limits in the host before each request and output limits in API requests, record actual usage and stop before the cap. Premium/flagship fallback is prohibited. If the target host cannot select `gpt-6-luna`, do not use a different model without the user's direction. Local tokenizer estimates are reported separately below; provider usage is unavailable.

## Reproduction package for an actual host

Use isolated accounts and synthetic disposable bookmarks, folders, rules and an authorized browser. Do not record credentials, pairing codes, cookies or private data. Capture only tool definitions from authenticated `tools/list`, without authorization headers, for the same binding/scopes at baseline and each selection. For each captured JSON array or `tools/list` result run:

```sh
node packages/server/scripts/measure-mcp-context.mjs --catalog /tmp/sanitized-tools.json --endpoint strict --identity isolated-manager --catalogs standard,automationManager --scopes automation:read,automation:manage,mcp:read:own,nodes:write --selection recovery
```

Record the commit, host/API/provider and version, model and price, catalog/scopes/selection, tool count, definitions and byte totals; never treat those totals as model loading. In the actual host compare full typed, each task selection, and the supported native deferred mode with identical authorization and fixtures. Record fresh versus existing conversations and cold versus warm caches separately. For each run capture initial non-deferred definitions or service summaries, search/load events, definitions newly loaded and repeated per turn, result bytes (including whether both JSON text and structured content reach the model), business pagination, first useful action time, turns, latency, usage/cached tokens, failures, argument errors and missed prerequisites. Cached-token billing is not context occupancy. Run each fixed task at least once: restore a deleted bookmark and folder; create/enable a rule; diagnose Sync; execute a browser rule and poll; and a conversation spanning the tasks. Record each individual outcome; small samples are not statistical proof. If the host cannot expose loading separately from aggregate usage, report the missing breakdown, not an invented ratio. The host must supply configurable tool adaptation, actual loading/search observations and an inexpensive compatible model; otherwise A12 remains unverified.

For an actual host built on the OpenAI Responses API, the documented shape to compare is below. Replace the placeholders in memory with an isolated authorized endpoint and token; do not write them to logs or commit them. Keep the host's original approval handling, and preserve the returned search records and approval continuations. This is an unexecuted configuration sketch, not proof that the user's host uses Responses API or accepts this protocol.

```json
{
  "model": "gpt-6-luna",
  "max_output_tokens": 2000,
  "tools": [
    {"type": "tool_search"},
    {
      "type": "mcp",
      "server_label": "colp",
      "server_description": "Manage authorized bookmarks, automation rules, recovery, synchronization diagnostics and browser rules.",
      "server_url": "<actual authorized MCP endpoint>",
      "authorization": "<isolated OAuth access token>",
      "defer_loading": true,
      "require_approval": "always"
    }
  ]
}
```

For the eager comparison, remove `tool_search` and `defer_loading` while retaining the same connection and approval policy. For each task run, include its fixed input, enforce the request/input/output ceilings above, record provider usage and explicitly test approval continuation. If the actual host uses a different API, follow its native integration instead of treating this sketch as a substitute-host result.

## MC-04 compact decision

No specific target client has been shown to lack native deferred loading, and no remaining typed-catalog budget or cross-task usability failure has been established for such a client. Compact entry conditions are not met. Do not implement the four-entry gateway based only on the host-access gap.

## MC-01 contract and task metadata

The source catalog now has explicit effect fields, including durable browser requests, persisted rule and run previews, activity read state and potential provider consumption. These are descriptive metadata, not a new execution authorization. The 13 missing and 18 generic descriptions were replaced. `mcp-task-toolsets.json` contains reviewed explicit member lists and English/Chinese aliases; `mcp-capability-relations.json` gives optional input provenance, not mandatory recursive calls. The generator checks IDs, task names/members, relationships, descriptions, effects and closed local references, and emits deterministic SHA-256 contract digests. A contract digest includes description, scopes, availability, input and output schemas, annotations and effect fields. The overall generated definition digest also covers task membership and relationships. Business revisions and authority remain separate.

`npm --prefix packages/server run check:automation-tools` passed. `node packages/server/scripts/measure-mcp-context.mjs --static` reports Automation-only task inputs: recovery 4 tools / 2755 bytes, rule-authoring 18 / 39644, sync-diagnostics 5 / 1775, browser-rules 11 / 9686. These omit standard helpers and are static, not authorized catalogs or token counts.


## MC-02 implementation and local observations

Implementation commits: `faeac02d` (MC-00 measurement), `a31ba377` (MC-01 descriptions and metadata), `a2e96e34` (MC-02 selection, generated configuration contracts, SDK packaging, transport enforcement and tests). The evidence/experiment package follows in the commit containing this report. MC-00, MC-01 and MC-02 repository implementation are complete; MC-03 has an external host gap; MC-04 is decided without compact; MC-05 local checks and cleanup are recorded below. The original plan has not been edited.

The Owner UI and existing revision-checked HTTP profile API accept the optional field. The shared source adjustment, Node generated validator/types, Automation MCP schema and OpenAPI/web types agree. Existing JSON profiles need no migration. Removing the field through the same Owner API/UI rolls back selection; old binaries should only be restored after removing the new field. Profiles are bound to an authenticated connection, not a chat. The tested OAuth connection identity also varies with scopes, audience and epoch. Worker opt-in, pairing generation, observation and event subscription survive Manager task edits; unrelated authority changes retain their existing invalidation rules.

The committed task membership is the entire reviewed expansion from an empty selection: recovery 6 IDs, rule-authoring 21, Sync diagnostics 8, browser rules 11, including explicitly listed standard helpers. The exact IDs are in `docs/automation/design/api/mcp-task-toolsets.json`. Selecting a set admits only those IDs already authorized by the catalog and scopes; rule-authoring includes binding-set saves but excludes connection-profile, executor and policy writes. Future membership edits can expand authority within existing scopes and must be reviewed as such. Resource reads/templates remain independently authorized and are not restricted by these toolsets.

`automation-catalog.ts` applies one decision to list/get/call, re-fetching profile access; the strict adapter checks that same current view before directly entering native core read/write adapters. Compat calls re-enter the facade. There is no global catalog cache. A catalog key includes the generated definition digest, a digest of the actual standard definitions, principal, scopes, current profile revision and selection. Per-capability contract digests include descriptions, input/output schemas, execution/effect metadata and scopes. The generated toolset digest changes when membership changes. These are not business revisions, deletion revisions, device generations, approvals or command receipts.

During review the strict full catalog hit the SDK's fixed 10,000-node result snapshot limit. The result builder now permits an explicit trusted host fields budget; only the server-owned tool-list result uses a finite 100,000-node, 64-depth, 1 MiB bound. Default result and write-input limits remain unchanged. The explicit budget is not taken from client input. This was verified by the Node result-contract test and the actual strict wire catalog test.

### Measurements

These are compact JSON `{name,description,inputSchema}` UTF-8 bytes, one repetition, with no model calls. Full catalog measurements include output schemas and annotations separately. The strict Fastify fixture used a synthetic authenticated Manager with `standard,automationManager` and `mcp:read:own,automation:read,automation:manage,nodes:write,access:write`; it supplied three real standard read descriptors and one standard write sentinel, not the complete production standard catalog. The same identity and scopes were used for every row. The fixture raised the host output node/depth configuration to capture the catalog; the fixed result snapshot limit was separately corrected as above.

| Strict fixture selection | Tools | Input bytes | Reduction vs same fixture unrestricted |
| --- | ---: | ---: | ---: |
| Omitted | 85 | 101822 | — |
| recovery | 5 | 3300 | 96.76% |
| rule-authoring | 20 | 40732 | 60.00% |
| sync-diagnostics | 7 | 2863 | 97.19% |
| browser-rules | 11 | 9686 | 90.49% |

The 70% recovery/Sync engineering targets are met in this fixture only. The production connection's actual catalog and the initial model-loaded context remain unmeasured. The fixture lacks `collections.list`, so it is not the complete task directory. For a separate real PostgreSQL-backed combined Manager/Worker credential with the same granted scopes and a single standard sentinel, the neutral authorized catalog was 91 tools / 109834 bytes unrestricted and 13 / 12331 bytes for recovery, an 88.77% reduction. Nine Worker tools remain in both views. This is an actual verified fixture binding, not the user's deployed identity or a wire/model-loading observation.

Final static Automation-only input/full sizes, characters then UTF-8 bytes: all 90 tools 109731/109739 and 290850/290858; Manager 81 tools 100155/100163 and 252355/252363; Worker 9 tools 9577/9577 and 38496/38496. Automation-only selected input bytes: recovery 2755; rule-authoring 39644; Sync 1775; browser rules 9686. The largest selected rule schemas are preview 11799, save 9358 and validate 7916 bytes; browser configure is 2391 bytes. Schemas and business constraints were not truncated.

An optional local `tiktoken` 0.11.0 `cl100k_base` estimate of the serialized input definitions was: baseline Automation 27485, Manager 25067, Worker 2421 tokens; final Automation 27575, Manager 25126, Worker 2452; final selected Automation-only recovery 719, rule-authoring 9593, Sync 379, browser rules 2511. These are local tokenizer estimates, not provider usage, initial model context, or a named model requirement. No provider usage, latency, cached-token count, first action time, long-session accumulation, duplicate transmission measurement or actual host search/load event was observed. The current generic Automation dispatcher constructs both JSON text and `structuredContent`; whether a particular host forwards both is unverified. Existing business pagination remains in use.

Reproduce token estimates without modifying repository dependencies:

```sh
python -m pip install --target /tmp/colp-mcp-tokenizer tiktoken==0.11.0
PYTHONPATH=/tmp/colp-mcp-tokenizer python packages/server/scripts/estimate-mcp-tokens.py --static
git show c94275ebda0181e565d1ba42ce4300baa5e480ff:packages/server/src/modules/mcp/automation-tool-contracts.generated.ts > /tmp/colp-mcp-baseline-contracts.ts
PYTHONPATH=/tmp/colp-mcp-tokenizer python packages/server/scripts/estimate-mcp-tokens.py --static --contracts-file /tmp/colp-mcp-baseline-contracts.ts
```

For a sanitized actual catalog, pass `--catalog /tmp/sanitized-tools.json` to the tokenizer script. `tiktoken` may download its encoding data on first use. Remove the temporary directory and file after the experiment. These scripts never print authentication headers or tool results.

## Acceptance matrix

Statuses below concern the implementation commit and the exact local checks listed in the next section. `External gap` means an observation requires the actual host/model or deployment; `partial` is not a passing claim.

| ID | Status | Locations, evidence and applicability |
| --- | --- | --- |
| A01 | Passed locally; external gap | Measurement scripts, static baseline above, strict fixture wire catalog, and `tool-catalog.integration.test.ts` verified binding. Local tokenizer estimates and provider usage are explicitly separated; deployed identity-specific catalogs are not available. |
| A02 | Passed | Source catalog, `mcp-task-toolsets.json`, `mcp-capability-relations.json`, generator and `capability-metadata.test.ts`: 31 descriptions, explicit effects, closed references, unique IDs, valid relationships, generated drift and version mutations. |
| A03 | Passed | `contract-adjustments.json`, shared validator and `tool-catalog.integration.test.ts`: omitted, empty, union, duplicate, unknown and max count; scope/catalog tests. |
| A04 | Passed locally | `tool-catalog.integration.test.ts`: two verified short-lived OAuth tokens for the same connection yield the same selection; another client and the same client with a different scope-bound connection do not see it. No claim about separate chats in an unobserved host. |
| A05 | Partial; complete live browser chain not run | Recovery PostgreSQL tests restore bookmark/subtree and replay; targeted worker pipeline validates, previews, saves and enables a rule under selection; device-bridge test executes selected Sync reads and queues/polls a browser apply with simulated device completion; extension test previews/applies/undoes with a fake browser. An integrated real-browser/host chain and actual permissions are unverified. Missing permissions are rejected in catalog and browser tests. |
| A06 | Passed | `mcp-task-selection-wire.test.ts` exercises real strict/compat HTTP routes, guessed core read/write and Automation names, plus narrowing between requests. Profile and scope checks also run in `tool-catalog.integration.test.ts`. |
| A07 | Passed locally | Same wire test rechecks a previously listed tool after narrowing; `tool-catalog.integration.test.ts` exercises credential revocation. No cached descriptor is passed as authority. |
| A08 | Passed locally | Targeted `worker-pipeline` test performs paired claim/heartbeat/submission after Manager selection; `events-lifecycle` checks unchanged observation, pairing generation and subscription; `targets-pairing` verifies authority edits still invalidate. |
| A09 | Passed | `capability-metadata.test.ts` changes generated descriptions, schemas, effects and memberships in an isolated copy; it checks identity/profile/standard-definition key changes. Recovery integration tests independently enforce deletion revisions and replay. |
| A10 | Passed locally | `phase4b-mcp-compat-write-approval.test.ts` covers strict `input_required`/requestState and compat approval; selected recovery tests cover exact replay; selected browser bridge test checks pending → running → done with simulated device. |
| A11 | Passed | Shared generated validator/types, `sync-automation-openapi.mjs`, OpenAPI/web drift checks and `AutomationWorkers.test.tsx`; Owner UI and existing revision-checked API documented in `chatgpt-mcp.md`. |
| A12 | External verification gap / not run | Actual host, inexpensive compatible model, adaptation configuration and per-turn loading observations are missing. Reproduction package above; no overall performance-success claim. |
| A13 | Not applicable | MC-04 conditions are not met; no compact bootstrap implemented. |
| A14 | Not applicable | No compact wrappers implemented. |
| A15 | Not applicable | No compact wrappers implemented. |
| A16 | Not applicable | No compact wrappers implemented; existing receipts/approval paths remain in use. |
| A17 | Not applicable | No compact search/describe service implemented. Long-session host observations remain an A12 gap. |
| A18 | Passed | `gpt-6-luna` selected; official pricing/support and bounded unexecuted estimate above. No model-backed tests; USD 0.00 actual for zero requests and zero provider tokens against USD 2 aggregate cap. Future paid runs require the pricing/support and budget procedure above, with no flagship fallback. |

## Commands and observed results

Commands are from the repository root. The PostgreSQL wrapper starts a disposable Testcontainers instance and shuts it down. The `-t` filters are intentional; no browser E2E was run. Any future E2E must use xvfb as required by AGENTS.md.

```sh
npm --prefix packages/node run check:automation
npm --prefix packages/server run openapi:automation
npm --prefix packages/server run openapi:drift
npm --prefix packages/web run check:api-types
PATH=/home/whiten/.nvm/versions/node/v22.23.2/bin:$PATH npm --prefix packages/server run runtime:manifest:check
node scripts/check-sdk-pins.mjs
npm --prefix packages/server run typecheck
npm --prefix packages/web run typecheck
npm --prefix packages/node exec -- vitest run tests/mcp/mcp-2026-07-28-request-discovery-result-contracts.test.ts tests/automation/schema.test.ts
npm --prefix packages/server run test:unit -- tests/unit/phase4b/mcp-task-selection-wire.test.ts tests/unit/automation/capability-metadata.test.ts tests/unit/automation/browser-rule-catalog.test.ts --disableConsoleIntercept
npm --prefix packages/server run test:unit -- tests/unit/phase4b/phase4b-mcp-strict-application-extensions.test.ts tests/unit/phase4b/phase4b-mcp-compat-write-approval.test.ts tests/unit/phase4b/phase4b-mcp-compat-read-tools.test.ts
npm --prefix packages/web run test:unit -- src/pages/agents/AutomationWorkers.test.tsx
npm --prefix packages/server run test:integration:file -- tests/integration/automation/tool-catalog.integration.test.ts tests/integration/automation/manager-trash-tools.integration.test.ts --disableConsoleIntercept
npm --prefix packages/server run test:integration:file -- tests/integration/automation/tool-catalog.integration.test.ts -t 'same verified binding'
npm --prefix packages/server run test:integration:file -- tests/integration/automation/worker-pipeline.integration.test.ts -t 'MCP tools dispatch real application operations'
npm --prefix packages/server run test:integration:file -- tests/integration/automation/targets-pairing.integration.test.ts -t 'renames keep the pairing'
npm --prefix packages/server run test:integration:file -- tests/integration/automation/events-lifecycle.integration.test.ts -t 'authenticated discovery'
npm --prefix packages/server run test:integration:file -- tests/integration/automation/device-bridge.integration.test.ts -t 'device bridge queues explicit|selected Sync diagnostics'
npm --prefix packages/extension exec -- vitest run tests/automation-run-once.test.ts -t 'previews, applies and undoes using the existing durable journal|fences a revoked bridge'
node packages/server/scripts/measure-mcp-context.mjs --static
git diff --check
```

Generation/drift, SDK pin and runtime-manifest checks, server/web typechecks, Node tests (30), web UI tests (26), strict/compat tests, selected PostgreSQL tests and selected extension tests passed. The runtime manifest uses npm 10; use the local Node 22 installation on other machines rather than copying the example PATH literally. Individual focused outputs are reproducible with the commands above.

Initial failures were retained as evidence: compat wire fixture initially used a strict-only resource audience and was corrected; the strict unrestricted catalog exceeded the fixed result snapshot budget and was corrected as described; an OAuth identity test initially changed the scope set, which correctly selects another connection, and was corrected to use the same scopes; and the new rule test initially asserted `state` instead of the contract's `desiredState`. The corrected targeted tests passed. An initial multi-file integration invocation unintentionally included the entire worker-pipeline file, reported four catalog failures before the omitted-field fix, and was interrupted instead of running the unrelated cases; the relevant cases were rerun as above. The first packaging refresh under npm 11 failed the npm-10 guard; it was rerun with Node 22/npm 10 and the runtime manifest check passed.

Cleanup: all test apps and Testcontainers instances were stopped; no dev server or model host was started. The optional tokenizer was installed only under `/tmp` and removed after measurement; the reproduction instructions reinstall it there. The test runner’s remaining Ryuk container was explicitly stopped. No push, publication or deployment was performed.

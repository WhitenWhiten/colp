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

No model was selected or called; no request limits were consumed and actual expenditure is **USD 0.00** of the aggregate **USD 2.00** cap. No token estimates or provider usage observations are available. Before any future paid experiment, verify the lowest-cost inexpensive model supporting the actual host mechanism with current official [OpenAI prices](https://developers.openai.com/api/docs/pricing) or the relevant provider's pricing and support documentation; calculate a worst-case cost including all requests, set request and token ceilings below USD 2, and record actual usage. Premium/flagship fallback is prohibited. If the host cannot use an inexpensive compatible model, do not run the model experiment.

## Reproduction package for an actual host

Use isolated accounts and synthetic disposable bookmarks, folders, rules and an authorized browser. Do not record credentials, pairing codes, cookies or private data. Capture only tool definitions from authenticated `tools/list`, without authorization headers, for the same binding/scopes at baseline and each selection. For each captured JSON array or `tools/list` result run:

```sh
node packages/server/scripts/measure-mcp-context.mjs --catalog /tmp/sanitized-tools.json --endpoint strict --identity isolated-manager --catalogs standard,automationManager --scopes automation:read,automation:manage,mcp:read:own,nodes:write --selection recovery
```

Record the commit, host/API/provider and version, model and price, catalog/scopes/selection, tool count, definitions and byte totals; never treat those totals as model loading. In the actual host compare full typed, each task selection, and the supported native deferred mode with identical authorization and fixtures. Record fresh versus existing conversations and cold versus warm caches separately. For each run capture initial non-deferred definitions or service summaries, search/load events, definitions newly loaded and repeated per turn, result bytes (including whether both JSON text and structured content reach the model), business pagination, first useful action time, turns, latency, usage/cached tokens, failures, argument errors and missed prerequisites. Cached-token billing is not context occupancy. Run each fixed task at least once: restore a deleted bookmark and folder; create/enable a rule; diagnose Sync; execute a browser rule and poll; and a conversation spanning the tasks. Record each individual outcome; small samples are not statistical proof. If the host cannot expose loading separately from aggregate usage, report the missing breakdown, not an invented ratio. The host must supply configurable tool adaptation, actual loading/search observations and an inexpensive compatible model; otherwise A12 remains unverified.

## MC-04 compact decision

No specific target client has been shown to lack native deferred loading, and no remaining typed-catalog budget or cross-task usability failure has been established for such a client. Compact entry conditions are not met. Do not implement the four-entry gateway based only on the host-access gap.

## MC-01 contract and task metadata

The source catalog now has explicit effect fields, including durable browser requests, persisted run previews, activity read state and potential provider consumption. These are descriptive metadata, not a new execution authorization. The 13 missing and 18 generic descriptions were replaced. `mcp-task-toolsets.json` contains reviewed explicit member lists and English/Chinese aliases; `mcp-capability-relations.json` gives optional input provenance, not mandatory recursive calls. The generator checks IDs, task names/members, relationships, descriptions, effects and closed local references, and emits deterministic SHA-256 contract digests. A contract digest includes description, scopes, availability, input and output schemas, annotations and effect fields. The overall generated definition digest also covers task membership and relationships. Business revisions and authority remain separate.

`npm --prefix packages/server run check:automation-tools` passed. `node packages/server/scripts/measure-mcp-context.mjs --static` reports Automation-only task inputs: recovery 4 tools / 2755 bytes, rule-authoring 18 / 39580, sync-diagnostics 5 / 1775, browser-rules 11 / 9686. These omit standard helpers and are static, not authorized catalogs or token counts.

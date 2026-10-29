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

# MCP context loading

COLP keeps capability authorization separate from catalog presentation and the
schemas a model host loads. Downloading a complete MCP catalog is not evidence
that a host inserted every definition into model context. API requests can also
declare deferred tools without loading them.

## Measure before changing the host

From `packages/server`:

```sh
node scripts/mcp-context-audit.mjs
node --test scripts/tests/mcp-context-audit.test.mjs
node scripts/mcp-context-audit.mjs --trace /path/to/observed-trace.json
```

The default report parses the actual generated Automation contracts, projects
input definitions separately from full MCP wire definitions, and reports JSON
characters (JavaScript UTF-16 code units) and UTF-8 bytes. It deliberately reports `tokens: null`: no tokenizer
or provider usage has been observed. This counts Automation only; a live profile
can also expose standard tools and can have fewer tools because of its grants.

An optional host trace has the following shape. The values below illustrate the
format; they are not a measured Astra result:

```json
{
  "format": "colp.mcp-context-trace/v1",
  "turns": [{
    "declaredTools": [],
    "initialVisibleDefinitions": [],
    "newlyLoadedDefinitions": [],
    "activeDefinitions": [],
    "searchResults": [],
    "toolResults": [],
    "usage": { "inputTokens": 120, "cachedInputTokens": 0, "outputTokens": 12 },
    "durationMs": 350,
    "argumentErrors": 0,
    "completed": true
  }]
}
```

Omit unobserved fields. An empty array means the host observed an empty set;
absence means unknown. `activeDefinitions` is a current complete snapshot and
can shrink after the host rebuilds context. `observedDefinitionTokens` may be
provided only when the host measures definition tokens with the actual model's
tokenizer or instrumentation. Provider input usage includes other content and
must not be copied into that field. Cached input tokens still occupy context.

Collect these observations at the host's request builder and search-result
loader, not just the MCP server's `tools/list` handler. Measure per-turn result
size, task completion, parameter errors and latency as well as initial loading.
Keep raw traces local: they can contain prompts, credentials, arguments or
private content. The audit report emits counts and measurements, never trace
bodies. Invalid trace input produces only a fixed error message; parser fragments
and private file paths are not printed. Do not commit raw captures.

## Implementation stages and validation status

1. **P0: measurements.** Offline catalog and observed-host trace analysis are
   available. A user's local Astra session cannot be observed from this checkout;
   an unobserved host must remain explicitly unknown.
2. **P1: discovery metadata.** All 90 capabilities now have bounded task labels,
   Chinese/English search terms, prerequisite/next-step hints and reviewed
   effects. Generation rejects missing or unsafe metadata; it stays off wire
   schemas. Independent review corrected Worker queue/input state effects.
   Seventeen targeted tests passed; existing schemas and scopes are unchanged.
3. **P2: task toolsets.** Apply trusted connection-profile selection to discovery
   and execution, preserving existing grants, Worker pairing and protocol paths.
4. **P3: native loading.** Provide host integration and reproducible checks for
   OpenAI/Claude native discovery, without claiming an unrun live model result.
5. **P4: compact surface.** Add bounded search/describe and separate read/write
   invocation through the authorized capability layer.
6. **P5: long conversations.** Verify bounded bootstrap/search/results and
   repeated-task context behavior, including revocation and strict/compat parity.

Each stage is independently reviewed and pushed with `[skip ci]`. The pull
request remains a draft; local verification is recorded instead of launching
GitHub Actions. Workflow files and protected-branch requirements are unchanged.

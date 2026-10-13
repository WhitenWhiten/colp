# AW-02 extension — real COLP engine integration

**Status: passed for the three-stage experimental path.** A real dot authored a
rule from natural language, consumed a report from actual COLP evaluator code
following an MCP event, and submitted a structured summary accepted by COLP's
schema. This extends [AW-02](aw-02.md) without claiming production M2 execution.

## Source and execution boundary

The engine was frozen at
`6e103801fa809c27454703f12009066dc3d05b8f` on `feat/automation`. Source files were
exported using `git archive`, compared byte-for-byte with that commit, and bundled
with esbuild `0.28.1`. [Source provenance](fixtures/aw-02/engine-provenance.json)
contains per-file and bundle hashes. The experiment did not consume concurrent
uncommitted work or later AW-33 changes.

Real functions executed were `validateAutomation`, `validateM1Rule`,
`compilePredicate`, `normalizeEventFacts`, `assessIntakeBindings`, and the server's
`evaluateRuleEvent`. Synthetic facts and folder bindings were supplied by the
fixture. No production database transaction, durable admission, claim, approval
or canonical mutation was exercised. AJV `8.20.0` and ajv-formats `3.0.1` matched
the inspected engine environment.

The dot received the rule schema and a base rule with **no match predicate**.
It generated the conjunction of `hostSuffix(arxiv.org)` and
`startsWith(/abs/)`, then submitted the full rule. The server accepted its first
attempt as `candidate_3f76f81e973fe2e76fa04379` at `03:45:36.555Z` UTC.

| Scenario | Actual plan |
| --- | --- |
| Main-domain paper; genuine subdomain paper | `placed` into the synthetic Academic folder |
| Spoofed hostname; wrong path | `notMatched` |
| Missing path | `missingInput` |
| Explicit folder choice; unknown intent | `preserved` |
| Revoked folder binding | `blocked` |
| Import; restore | `notMatched` |

All ten cases passed. `placed` is an evaluator plan here, not a database effect.
The M1 rule contained no model tasks or execution targets.

## Actual event and model output

The operator then ran:

```sh
node ctl.mjs engine-trigger candidate_3f76f81e973fe2e76fa04379
```

[Archived evidence](fixtures/aw-02/engine-lifecycle.json) contains the generated
rule, ten-case report, delivered event, structured model output and transcript.
The original Chinese summary is retained verbatim as test data; it has not been
translated or rewritten, preserving its recorded digest.

- Event: `evt_7430dd44-c9cf-4b32-87e2-aa623eedde6a`.
- Work item: `job_4e7d5f6d-a901-4932-ae71-8b2bee4b32fc`.
- `03:46:41.300Z`: event created; `03:46:41.771Z`: first delivery returned 200.
- `03:47:10Z`: the dot called the report-reading tool.
- `03:47:28.151Z`: the submitted `TextOutput` passed schema and fixture source
  checks and was saved with `replayed: false`.
- `03:47:34.668Z`: acknowledgment was saved with the exact event/job identifiers.

The output had `kind: text`, `textType: summary`, and `language: zh-CN`. Its
source evidence referenced `fixture://colp-aw02/n_paper_001` at
`2026-10-13T03:00:00Z`. Manual inspection found that the summary accurately
reported the scenarios and explicitly disclaimed production bookmark changes.
Its digest was
`63391e4a7584e98cab0fdf495e14a26704a21a8759c943b460bc544a07b88e96`.

The observed creation-to-result and creation-to-ack intervals were approximately
47 and 53 seconds respectively. These are single samples, not performance claims.
The same persisted subscription delivered successfully after fixture deployment
restarts; this does not establish the entire hosted refresh/expiry lifecycle.

## What this proves

The actual model's rule JSON and summary JSON could be parsed by the pinned COLP
validators. The model successfully moved from an event containing references to
a tool-readable engine report and then to an accepted structured response.
Local negative tests additionally rejected unknown fields, unsupported CEL,
incorrect predicates, missing source evidence and conflicting repeat results.

The output receiver was an experiment wrapper around the real `TextOutput`
validator. It stored an idempotent encrypted receipt, with
`productionEffectCommitted: false`. M1 does not itself create agent jobs: this
fixture's event/work-item bridge was synthetic. It did not implement or invoke
production `automation.jobs.submit`, fabricate a claim token, or write a note.

The three engine-specific tests and the complete 17-test fixture suite passed;
see [test output](fixtures/aw-02/test-results.txt). No unrelated repository tests
were run for this experiment or its documentation handoff.

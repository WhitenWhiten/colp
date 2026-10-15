# Artifact Validation Report

**Result:** PASSED. **Checks:** 63. **Failures:** 0.

Offline artifact structure, JSON Schema, example, selected semantic and planning checks only. No production execution or external OpenAPI linter.

| Check | Result |
|---|---|
| OpenAPI structure/refs: mcp-events.openapi.yaml | passed |
| OpenAPI structure/refs: automation.openapi.yaml | passed |
| Standalone JSON Schema validity/references | passed |
| Example: academic-intake.json | passed |
| Example: academic-bindings.json | passed |
| Example: execution-policy.json | passed |
| Example: rule-create.json | passed |
| Example: ten-bookmark-digest.json | passed |
| Example: github-review.json | passed |
| Example: tag-review.json | passed |
| Example: research-catalog.json | passed |
| Example: research-catalog-bindings.json | passed |
| Example: weekly-digest.json | passed |
| Example: event-facts.json | passed |
| Example: local-receipt.json | passed |
| Example: preview-request.json | passed |
| Example: paper-template.json | passed |
| Example: broadcast-digest.json | passed |
| Example: broadcast-bindings.json | passed |
| Example: broadcast-execution-policy.json | passed |
| Example: m1-placement.json | passed |
| Example: m1-bindings.json | passed |
| Example: m1-rule-create.json | passed |
| Example: m1-bundle-paused.json | passed |
| Example: academic-summary-only.json | passed |
| Example: worker-bootstrap-profile.json | passed |
| Example: run-once-start.json | passed |
| Example: m1-preview-current-state.json | passed |
| Example: browser-rule.json | passed |
| MCP subscription fixture | passed |
| MCP occurrence fixture | passed |
| Contract F01: academic definition | passed |
| Contract F02: unknown root property | passed |
| Contract F03: JS unsupported | passed |
| Contract F04: non-positive batch | passed |
| Contract F05: invalid count type | passed |
| Contract F06: private rule valid | passed |
| Contract F07: create request | passed |
| Contract F08: local receipt | passed |
| Contract F09: preview request | passed |
| Contract F10: template | passed |
| Contract F11: finite host predicate | passed |
| Contract F12: schedule shape only | passed |
| Offline graph/role/policy checks: academic-intake.json | passed |
| Offline graph/role/policy checks: ten-bookmark-digest.json | passed |
| Offline graph/role/policy checks: github-review.json | passed |
| Offline graph/role/policy checks: tag-review.json | passed |
| Offline graph/role/policy checks: research-catalog.json | passed |
| Offline graph/role/policy checks: weekly-digest.json | passed |
| Offline graph/role/policy checks: broadcast-digest.json | passed |
| Offline graph/role/policy checks: m1-placement.json | passed |
| Offline graph/role/policy checks: academic-summary-only.json | passed |
| Offline graph/role/policy checks: browser-rule.json | passed |
| Negative graph/role/privacy fixtures | passed |
| OpenAPI / standalone schema drift | passed |
| Plan IDs / DAG / traceability / operation inventory | passed |
| Markdown local links / code fences | passed |
| MCP design tool catalog references/profiles | passed |
| Reviewed M1 / receipt / pause / preview / run-once boundaries | passed |
| Worker bootstrap and queue contract | passed |
| Single-lane files and no backend-to-frontend dependency | passed |
| Local backend batch order is dependency-closed | passed |
| Formal research example and predecessor contract | passed |

## Not executed

- Full external OpenAPI linter/metaschema validation
- Production CEL evaluator tests
- PostgreSQL transaction/fault tests
- Actual browser extension lifecycle
- Actual hosted-bot (ChatGPT dot) Events subscription/delivery/execution
- Chrome Web Store review
- Repository code changes or CI execution

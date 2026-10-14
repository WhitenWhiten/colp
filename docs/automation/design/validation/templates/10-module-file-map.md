# Module and File Map

**Version:** 0.2.1-design. Generated from [tasks.json](tasks.json) by `validation/build-docs.py`: every file a packet creates or modifies, with the packet and milestone. Paths under `Known-Extension/` are in the private Know-N repository (EXTENSION_REPO); server/shared/Web paths are in COLP_REPO. State is a recorded baseline claim or verifyAtAW01; absence of a local checkout during documentation generation must never be reported as proof a file is new. Migration prefixes are placeholders resolved at merge time (data model §0).

## Files by repository

{{FILE_MAP}}

## Import rules

The shared package imports no `node:*`, `chrome`, database client, model SDK, Fastify or MCP transport. Application automation code imports typed ports, not infrastructure instances. MCP adapters translate wire data into application inputs. Browser code resolves native identity locally and imports the shared package through its published dependency. Only infrastructure adapters fetch remote pages, call providers or deliver callbacks.

## Contract and test locations

OpenAPI source: `packages/server/openapi/fragments/automations.yaml`, bundled into `colp-server-v1.yaml` with prefixed component names; generated clients under `packages/server/generated/openapi/` and `packages/web/src/generated/` are never edited by hand. Events fixtures under `packages/node/tests/mcp/`; server tests under `packages/server/tests/`; extension e2e under `Known-Extension/e2e/`. This pack lives in `docs/automation/` once AW-01 copies it; the root README links to it.

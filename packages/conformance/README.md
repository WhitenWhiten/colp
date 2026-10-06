# @collection-protocol/conformance

A black-box conformance runner for servers that implement [The Collection Protocol](../../README.md). Point it at a live server, in any language, and it reports which `core + publication` requirements the server meets, citing each requirement by its ID in [`protocol/requirements.yaml`](../../protocol/requirements.yaml).

The runner acts like an anonymous COLP client. It starts at `/.well-known/collection-protocol`, follows only the endpoints and links the server declares, and sends read-only `GET` requests. It validates every response with the reference package's JSON Schema and semantic validators.

## Usage

From a checkout of this repository (the package is not on npm yet):

```bash
npm run install:package && npm run build    # build the reference package once
npm --prefix packages/conformance ci
npm run conformance -- https://alice.example
```

You can pass a server origin or the Manifest URL. Loopback `http://` servers work for local development:

```bash
npm run example:publication &               # the example server, on port 8080
npm run conformance -- http://127.0.0.1:8080
```

```text
COLP conformance: core + publication (anonymous, read-only)
Target: http://127.0.0.1:8080/.well-known/collection-protocol

  PASS  PUB-0011  MUST    Manifest is served at /.well-known/collection-protocol
  PASS  PUB-0018  MUST    Response bodies validate against their named $defs
  PASS  CORE-0001 MUST    Snapshots pass semantic validation (root, identity, graph, positions, references)
  ...
  SKIP  PUB-0034  SHOULD  Paginated Snapshots send Link rel="next"
          no paginated Snapshot observed

19 passed, 0 failed, 0 warnings, 2 skipped (12 requests)
```

| Option | Default | Meaning |
|---|---|---|
| `--json` | off | Print the report as JSON, for CI |
| `--max-collections <n>` | 3 | Collections to inspect from the Directory |
| `--max-pages <n>` | 50 | Snapshot pages to follow per Collection |
| `--max-requests <n>` | 200 | Total request budget |
| `--timeout <ms>` | 10000 | Per-request timeout |

The exit status is 0 when no MUST check fails, 1 when one does, and 2 on a usage error. A failed SHOULD is reported as a warning and does not change the exit status. A check that the server gave no chance to observe, such as pagination on a server with only small Collections, is skipped with the reason.

## What it checks

| Area | Requirements |
|---|---|
| Discovery and Manifest | PUB-0011, PUB-0012, PUB-0003, PUB-0001, PUB-0028, PUB-0027 |
| Wire format | PUB-0016 (UTF-8), PUB-0017 (I-JSON), PUB-0018 (named `$defs`), PUB-0020 (media types) |
| Snapshots | CORE-0001 (semantic validation of the assembled Snapshot), PUB-0033, PUB-0034, PUB-0040 |
| Visibility | PUB-0009 (the anonymous Directory lists only public Collections) |
| Errors and queries | PUB-0008 (Problem Details), PUB-0010 (unknown and duplicate parameters) |
| HTTP caching | PUB-0021, PUB-0022, PUB-0024, PUB-0032 |

Not covered yet: authenticated reads (PUB-0007, PUB-0023), and the `feed`, `publisher`, `sync`, and MCP profiles. Those need credentials or writes and will come as opt-in modes.

## Use from code

```js
import { formatReport, runConformance } from '@collection-protocol/conformance';

const report = await runConformance('https://alice.example');
console.log(formatReport(report));
if (report.summary.fail > 0) process.exitCode = 1;
```

## Development

`npm test` runs the suite with `node:test`. It needs the reference package built (`npm run build` in `packages/node`), because the tests start the example server and a deliberately misbehaving proxy in front of it to prove that violations are caught.

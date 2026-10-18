# @know-n/colp-conformance

A black-box conformance runner for servers that implement [The Collection Protocol](https://github.com/WhitenWhiten/colp). Point it at a live server, in any language, and it reports which `core + publication` requirements the server meets, citing each requirement by its ID in [`protocol/requirements.yaml`](https://github.com/WhitenWhiten/colp/blob/main/protocol/requirements.yaml).

The runner acts like an anonymous COLP client. It starts at `/.well-known/collection-protocol`, follows only the endpoints and links the server declares, and sends read-only `GET` requests. It validates every response with the reference package's JSON Schema and semantic validators.

## Usage

Requires **Node.js 22 or later**. Run the CLI directly from npm:

```bash
npx --yes --package=@know-n/colp-conformance@0.1.1 colp-conformance https://your-server.example
```

For repeated use, install it in your project:

```bash
npm install --save-dev @know-n/colp-conformance@0.1.1
npx colp-conformance https://your-server.example --json
```

The reference implementation is installed automatically as a dependency. Replace the URL with your server's origin or Manifest URL. This package's JavaScript API uses ESM.

From a checkout of this repository:

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
| `--max-snapshot-bytes <n>` | 67108864 | Cumulative response bytes retained while assembling one Snapshot |
| `--max-snapshot-members <n>` | 100000 | Cumulative resource-array members retained while assembling one Snapshot |
| `--max-snapshot-objects <n>` | 100000 | Cumulative Snapshot objects retained while assembling one Snapshot |
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
| Errors and queries | PUB-0008 (Problem Details), PUB-0010 (unknown and duplicate parameters), PUB-0041 (406 `unsupported_version` for an unsupported header or Accept version) |
| HTTP caching | PUB-0021, PUB-0022, PUB-0024, PUB-0032 |

Not covered yet: authenticated reads (PUB-0007, PUB-0023), and the `feed`, `publisher`, `sync`, and MCP profiles. Those need credentials or writes and will come as opt-in modes.

## Use from code

```js
import { formatReport, runConformance } from '@know-n/colp-conformance';

const report = await runConformance('https://alice.example');
console.log(formatReport(report));
if (report.summary.fail > 0) process.exitCode = 1;
```

## Development

`npm test` runs the suite with `node:test`. It needs the reference package built (`npm run build` in `packages/node`), because the tests start the example server and a deliberately misbehaving proxy in front of it to prove that violations are caught.

## Release packaging

Development uses `file:../node` so the runner tests the same implementation as the checkout. Keep the source package private and create its release tarball with:

```bash
npm run pack:release -- /path/to/artifacts
```

The command copies the shipped files and Apache-2.0 license into a temporary directory, replaces the local dependency with the exact matching `@know-n/colp` version, and packs a public package. Publish the accepted implementation tarball first, then the accepted runner tarball. Publish the tarball produced by this command; the source directory retains its development dependency.

## Sync resilience adapters (COLP 0.2)

The separate opt-in runner covers the six client/deployment cases in
[`protocol/sync-resilience-cases.json`](../../protocol/sync-resilience-cases.json).
The anonymous publication CLI keeps its existing read-only behavior. Sync
scenarios may write data and must use disposable replicas and collections.

```bash
npm run conformance:sync-resilience -- --json /absolute/path/to/adapter.mjs
# Installed package:
colp-sync-resilience --json /absolute/path/to/adapter.mjs
```

The local adapter exports `async runScenario(caseId)` and optionally `async close()`.
It creates a fresh isolated scenario and returns concrete observations in the
following shapes. `undefined` means unsupported and produces SKIP. The CLI exits
1 on either a failure or a skip, 2 on adapter/usage errors, and always calls
`close()` after loading the adapter. No adapter code comes from a server response.
A scenario exception fails that case without printing credentials from its error.
The JavaScript API is `runSyncResilienceConformance(adapter, { cases?: ids })`;
`verifySyncResilienceCase(id, observations)` can verify evidence inside an existing
fixture. Unselected cases are explicitly skipped.

| Case | Scenario and returned observations |
|---|---|
| SYNC-0032 | Conflict on X, later edit on Y, later edit on X; resolve and recapture X. Return `results: [{opId,targetId,sequence,status}]`, `held: [{opId,targetId,status}]`, `recaptured: [{originalOpId,opId,targetId,sequence,title}]`, `currentNativeTitle`. Results contain the actual consumed conflict receipt and independent applied receipt. |
| SYNC-0033 | Three Pull events, middle event locally unappliable. Return three `events: [{nodeId,state: applied|not_applied}]` in page order, durable `issues: [{nodeId,eventId,code}]`, published `cursor`, `ackedCursor`, actual Ack `warnings`. |
| SYNC-0034 | Tamper with a page/effect digest before staging. Return `failureCode`, `cursorBefore`, `cursorAfter`, complete native snapshots `nativeBefore`/`nativeAfter`, and `setAside` issues. No native change, cursor advance or item downgrade is allowed. |
| SYNC-0035 | Delete a subtree with one protected child and one independent sibling. Return logical IDs in `protected`, `ancestors`, `independent`, `survivors`, `excluded`, `retainedIssues`, plus `previousCursor`/`cursor`. Protected native members and necessary ancestors survive; independent siblings delete. |
| SYNC-0036 | Send new/older health reports and try another installation's proof. Persist Ack warnings. Return actual `report`, `response`, `olderResponse`, `foreignProofStatus`, `ackWarnings`, `storedWarnings`, `authorityBefore`/`authorityAfter`. Authority snapshots must include `leaseExpiresAt`, `lastSeenAt`, `cursor`, `checkpoint`, `lifecycle`. |
| SYNC-0037 | Deliver the same permitted command twice, drop a result response, and try an unavailable action. Return actual `deliveries`, executed command IDs in `executions`, two `resultReports` carrying the retained result, and refused outcomes in `refused`. |

These checks validate observations, not hardware attestation of an adapter. The
repository fixtures drive production extension modules and IndexedDB, and the
server fixture uses PostgreSQL and authenticated HTTP injection. The suite also
feeds deliberately corrupted observations to each verifier to ensure violations
fail. It does not certify browser/live-server end-to-end completion. The optional
Manifest capability is defined by the new schema; an existing deployment using
only the configured extension helper does not thereby advertise that capability.

# MacBook / OrbStack execution environment

Prepared and verified October 24, 2026 for `/Users/whiten/colp`. This is environment-readiness evidence, not implementation acceptance for the proposed adapters. Continue from [execution evidence](execution-evidence.md) and the [implementation plan](implementation-plan.md#ordered-work-packages); environment readiness does not close adapter acceptance gates.

## Ready on this machine

| Component | Verified state |
| --- | --- |
| Docker | OrbStack context `orbstack`, native `linux/arm64` |
| Local runner image | `colp-extension-tests:pw1.61.1` |
| Upstream base | `mcr.microsoft.com/playwright:v1.61.1-noble`, pinned by manifest digest in the [Dockerfile](../../tools/linux-runner/Dockerfile) |
| Runtime | Node `v24.17.0` (packages require Node >=22), Playwright `1.61.1`, bundled Chromium `149.0.7827.55` |
| X11 tools | xvfb and `xdotool 3.20160805.1`; every runner command executes under xvfb |
| Dependencies | Extension and server lockfiles installed into separate Linux Docker volumes; install hooks disabled except the repository-allowlisted esbuild rebuild |
| Build | `dist/development` built successfully; visible on the Mac at `/Users/whiten/colp/packages/extension/dist/development` |
| Real-site browser | ego-lite connected and opened the Bilibili homepage; reported Chrome `154.0.0.0` user agent |
| Cleanup | Verification containers removed; no test server left running; ego task space finished with no kept pages |

The derived image ID at verification was `sha256:093f0d63a5300800c48f01af95fc3cb68eb27aeb05627327f0c0015361a376e4`. Rebuilding may change that ID as distribution packages change; the upstream base digest remains pinned. This setup uses Node 24 rather than CI's Node 22, so the local smoke does not establish Node 22 parity.

## Commands for the next agent

Run these on the Mac from `packages/extension`. [with-orbstack.mjs](../../scripts/with-orbstack.mjs) locates the repository independently of the current directory, mounts it at `/workspace`, and runs commands with `/workspace/packages/extension` as the container working directory.

```sh
cd /Users/whiten/colp/packages/extension
docker context show
docker image inspect colp-extension-tests:pw1.61.1 --format '{{.Os}}/{{.Architecture}}'
```

The context should be `orbstack` and the image `linux/arm64`. Image and dependency caches are already prepared; **do not rerun preparation on every task**. If the image/volumes were removed, the checkout moved, or a lockfile changed:

```sh
node scripts/with-orbstack.mjs prepare
```

Preparation builds the small derived image, runs `npm ci` for the extension and server, rebuilds esbuild only, and records lockfile fingerprints. Server dependencies are needed because existing extension E2E helpers import the server's `pg` package even for the local smoke. No PostgreSQL server is started. If the Playwright version changes, update the runner version and Dockerfile's matching image/digest together before preparing again.

Use the prepared toolchain for normal work:

```sh
# Draft contract check; no browser acceptance claim.
node scripts/with-orbstack.mjs run node_modules/.bin/tsc --noEmit --strict --skipLibCheck --target ES2023 --module NodeNext --moduleResolution NodeNext --lib ES2023,DOM docs/site-adapters/contracts.ts docs/site-adapters/examples.ts

# Rebuild after implementation changes, before loading/testing the extension.
node scripts/with-orbstack.mjs run npm run build:development

# Example of a focused existing unit group; select only tests relevant to the change.
node scripts/with-orbstack.mjs run node_modules/.bin/vitest run tests/manifest-security.test.ts

# The environment smoke already passed; rerun only when relevant.
node scripts/with-orbstack.mjs e2e e2e/mv3-local-import.spec.ts
```

For new adapter E2E coverage, substitute the actual new spec filename; optional Playwright filters can follow it. The `e2e` command requires an existing explicit `e2e/*.spec.ts` as its first argument, preventing an empty selection from launching all suites. It defaults to project `core`. The `run` command accepts explicit argv without host-shell interpolation and also wraps execution in xvfb. It unsets `KNOWN_E2E_HEADED`; do not bypass the display wrapper.

Containers use `--rm`, an init process, and 1 GiB shared memory. The runner cleans up its own named container on completion/failure or SIGINT/SIGTERM. It exposes no host port and mounts no Docker socket. Test-launched services live inside the temporary container. After an abrupt host termination, inspect `docker ps -a` for a container named `colp-adapters-348ae153b4-<run-id>` and remove only that orphan, never unrelated containers.

The repository bind mount makes source edits, build output, and `test-results` visible on the Mac. Linux `node_modules` are mounted over the host directories and are not usable as macOS dependencies. Do not run host-native npm commands against those Linux packages. Use the runner; native Mac dependencies can be installed separately if later needed. Avoid concurrent prepare/build/E2E runs in the same checkout because dependency volumes, `dist`, and `test-results` are shared.

The retained volumes for this checkout are:

- `colp-adapters-348ae153b4-extension`
- `colp-adapters-348ae153b4-server`
- `colp-adapters-348ae153b4-npm`

Keep these and the image for reuse; stopping a run does not delete caches. A different checkout path gets a different volume prefix and requires its own preparation. Only remove caches intentionally; do not use broad Docker prune commands as routine cleanup.

## Real-site acceptance through ego-lite

The user explicitly authorized real-site acceptance in **ego-lite on this Mac** for this adapter task. This is the task-specific exception to the xvfb-only browser-test rule. Automated Playwright/E2E suites still run in OrbStack under xvfb; do not launch native macOS Playwright as a substitute.

Before browser work, read the installed ego-browser skill and run `ego-browser skill`. Follow the returned API, create one task space for the acceptance goal, and use the built extension from the Mac-visible `dist/development` path. The environment check only opened the public Bilibili homepage: it did not verify login, install the COLP build into ego-lite, exercise favorites, or validate adapter behavior. Do not count that check toward gates A1–A6.

Use the browser's existing authorized session if available; do not export cookies into the container. Browser-owned permission prompts or a missing/expired login may require user action under the ego-browser workflow. Record that exact gate as blocked and continue independent fixture/host tasks; do not claim a signed-in test passed. In the current ego connection, `Browser.getVersion` through `task.cdp` was unavailable; reading `navigator.userAgent` through `page.evaluate` worked. Record the actual version evidence source rather than relying on unsupported CDP calls.

Keep real-site tests small and reversible, with a dedicated test collection/root and a record of test-created objects. Distinguish native UI actions from direct API calls. Do not perform a full-account import merely to re-prove the earlier experiment, alter unrelated favorites, or clear the user's browser state. Follow skill cleanup when finished, closing only agent-created pages. Do not keep a test server running after the work.

## Verification record

Executed against COLP base `364a124471da2bc1633e22b8936656e0ba28e865` plus the working-tree documentation and runner changes:

| Check | Result |
| --- | --- |
| Runner syntax (`node --check`) | Passed |
| `prepare` | Image built; extension 193 packages and server 508 packages installed; allowlisted rebuilds passed |
| `run npm run build:development` | Passed |
| Draft TypeScript command above | Passed |
| `tests/manifest-security.test.ts` | 3/3 passed |
| `e2e/mv3-local-import.spec.ts` | 1/1 passed in 13.2 seconds under xvfb; exercised real extension permission granting via xdotool, offline import, and browser-restart persistence |
| ego-lite connection | Bilibili homepage opened; temporary task space closed; signed-in behavior untested |
| Container cleanup | `docker ps -a` empty after validation |

The latest smoke report is `packages/extension/test-results/results.json` (ignored, overwritten by later Playwright runs), with `unexpected: 0`, `skipped: 0`, and `flaky: 0`. The run began at `2026-10-24T09:12:14.716Z`. Save new task-specific evidence separately when implementing adapter gates. This environment does not include a running backend/database or establish server-backed E2E coverage; set up the existing backend harness only when a selected task actually needs it.

## TypeScript memory during implementation

The prepared OrbStack VM reports about 2 GiB RAM. SA-04 project-wide TypeScript checks were killed with exit 137 when large Node heaps allowed them to exceed that limit. A focused strict check of the changed production entry graphs and new tests passed with `node --max-old-space-size=1536 node_modules/typescript/bin/tsc ...` (see the exact command in execution evidence). Do not report a killed full check as passing or rerun environment preparation to address this memory limit.

## SA-10 disposable server/database validation

For the selected source archive server/browser spec only, use:

```sh
COLP_ADAPTER_POSTGRES=1 node packages/extension/scripts/with-orbstack.mjs e2e e2e/mv3-site-adapter-cloud.spec.ts
```

This reuses the same image and dependency volumes and still forces xvfb. The runner additionally starts PostgreSQL 16.4-alpine on a unique temporary Docker network with no published host port. Only that run's database URL enters the test container. The actual COLP Fastify/auth/canonical/Sync harness creates an isolated schema and drops it on close. Finally the runner removes its test/database containers and network, including after failures/signals; it keeps reusable image/volume caches. No separate Know-N backend or classification service is started. The cached PostgreSQL image digest is `sha256:5660c2cbfea50c7a9127d17dc4e48543eedd3d7a41a595a2dfa572471e37e64c`.

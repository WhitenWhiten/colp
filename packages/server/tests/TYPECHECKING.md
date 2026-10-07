# Test typechecking

`npm run typecheck:tests` is part of `ci:quality`. It runs strict TypeScript checks in separate, sequential compiler processes; it does not execute tests or need PostgreSQL.

The initial capability owners are:

| Command argument | Configuration | Checked test surface |
| --- | --- | --- |
| `collections` | `tsconfig.tests.collections.json` | Collection mutation memory adapters and create/delete application consumers, including the access-policy fixture contract |
| `sync-recovery` | `tsconfig.tests.sync-recovery.json` | Recovery database fixture and its imported dependencies |
| `phase4b-config` | `tsconfig.tests.phase4b-config.json` | MCP config env fixture and three config consumer suites |

Run one owner with `npm run typecheck:tests -- collections`. Each configuration lists its roots explicitly; TypeScript also checks their imported TS dependencies. The shared base inherits production strictness, sets `noEmit`, and uses the repository root for cross-package imports. `allowJs: true, checkJs: false` infers exports from real JavaScript modules without requiring invented ambient declarations; it does not disable checking TS consumers.

This is progressive coverage, not a claim that all backend tests compile. HTTP/auth harnesses, broad integration suites and CI script contracts are not yet owners in this gate. An exploratory expansion into the collection HTTP consumers found existing auth-harness capability drift (`sessionRotationSecrets`, session email inputs), response-header types and contract-view narrowing; those need their own bounded follow-up before enrolling that module. The HTTP consumers still run as runtime regression tests for shared-fixture changes. No diagnostic baselines or compiler suppressions hide these files' errors inside an enrolled module.

To expand coverage, add a focused configuration extending the base, resolve its diagnostics and add its name to `scripts/typecheck-tests.mjs`. Keep module ownership small enough for a compiler process to fit the CI memory budget; do not include all backend tests in one program. Port annotations on enrolled fixtures are intentional: adding a required production method must make the fixture fail to compile until it implements that capability.

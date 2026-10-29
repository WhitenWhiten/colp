# Contributing to COLP

Thank you for helping improve the Collection Protocol. This repository holds two things that move together: the protocol specification in [`protocol/`](protocol) and the Node.js reference implementation in [`packages/node/`](packages/node).

## Ways to contribute

- **Report a bug** in the package or an inconsistency in the specification with a [bug report](https://github.com/WhitenWhiten/colp/issues/new?template=bug_report.yml).
- **Propose a protocol change** with a [protocol change proposal](https://github.com/WhitenWhiten/colp/issues/new?template=protocol_change.yml). Please open the issue before writing a large pull request, so the design can be agreed first.
- **Improve documentation**, examples, and diagrams.
- **Ask a question or float an idea** in [Discussions](https://github.com/WhitenWhiten/colp/discussions).
- **Report a security vulnerability** privately as described in [SECURITY.md](SECURITY.md). Never in a public issue.

How changes are decided, including the comment period for protocol changes, is described in [GOVERNANCE.md](GOVERNANCE.md).

## Development setup

You need Node.js 22 or later (see `.nvmrc`), npm, and Python 3 for the example validator. The repository's `.editorconfig` sets the basic formatting.

```bash
git clone https://github.com/WhitenWhiten/colp.git
cd colp
npm run install:package   # npm ci in packages/node
npm run build
npm test
```

Common commands, run inside `packages/node`:

| Command | What it does |
|---|---|
| `npm test` | Runs the Vitest suite |
| `npm run typecheck` | Type-checks sources and tests |
| `npm run refresh:protocol` | Copies `protocol/` schemas, examples, and registries into `fixtures/protocol` and regenerates TypeScript types |
| `npm run check:protocol` / `npm run check:types` | Fail when the copied assets or generated types are stale |
| `npm run generate:traceability` | Validates the requirement registries and regenerates `docs/TRACEABILITY.md` |
| `npm run refresh:evidence` | Runs the full suite and records which requirements passed in `src/conformance/generated/evidence.json` |
| `npm run check` | The full local gate: everything above plus coverage floors, the build, and `pack:check` |
| `node examples/publication-server.mjs --self-test` | Runs the example server against `ColpClient` (needs a build first) |

The black-box conformance runner in `packages/conformance` has its own tests, which need the reference package built first:

```bash
npm --prefix packages/conformance ci
npm --prefix packages/conformance test
```

When you add a requirement that a client can observe over HTTP, consider adding a check for it to `packages/conformance/src/runner.mjs`.

The browser extension in `packages/extension` has its own [README](packages/extension/README.md) with build, test and release commands. Its unit and browser tests import COLP Server, so install both packages first. Browser tests run a real Chromium under xvfb on Linux.

```bash
npm --prefix packages/server ci
npm --prefix packages/extension ci
npm --prefix packages/extension test
```

Validate the protocol examples from `protocol/`:

```bash
python -m venv .venv && . .venv/bin/activate
python -m pip install -r requirements-dev.txt
python scripts/validate_examples.py
```

## Changing the protocol

The prose, the schema, and the implementation must agree. A protocol change pull request updates all of the following together:

1. **Specification text** in `protocol/SPECIFICATION.md` or `protocol/docs/`. Normative text is English and uses BCP 14 keywords (`MUST`, `SHOULD`, `MAY`) in uppercase. Every numbered heading has a stable `<a id="colp-section-N"></a>` anchor; do not renumber existing anchors.
2. **JSON Schema** in `protocol/schemas/`, if the wire format changes. Every request and response DTO has a named `$defs` entry.
3. **Examples** in `protocol/examples/`, mapped to their `$defs` contract in `protocol/scripts/validate_examples.py`.
4. **Requirement registry** in `protocol/requirements.yaml` (or `requirements-0.2.yaml` for 0.2 additions). Each normative statement gets a stable ID, a `source` anchor, the implementing modules, and test IDs. Never reuse or renumber an ID.
5. **Implementation and tests** in `packages/node`. Tag the tests that verify a requirement with `[evidence:<test-id>]` in a `describe` or `it` name.

Then, in `packages/node`, run `npm run refresh:protocol`, `npm run refresh:evidence`, and commit the regenerated files.

If you find that the prose and the schema disagree, treat it as a specification bug and fix the side that is wrong; do not pick one in code.

## Writing documentation

- Every protocol chapter opens with an **In short** box that says what the chapter covers and who should read it, and ends with links to the previous and next chapters. Keep both when you edit a chapter, and update the box when the chapter's scope changes.
- Add new terms to the [glossary](protocol/GLOSSARY.md), with a link to the section that defines them.
- Link to files instead of only naming them in backticks, and link to a section through its `colp-section-N` anchor.
- Write each paragraph or list item on a single line; do not hard-wrap prose.
- Markdown that ships in the npm package (`packages/node/README.md`, the docs listed under `files` in `packages/node/package.json`, and `packages/node/docs/README.md`, which npm always includes) may link only to other shipped files. Link to anything else with an absolute GitHub URL; `npm run pack:check` fails on a broken link.
- When you change `README.md` or `protocol/README.md`, update the Chinese and Japanese translations next to it (`README.zh-CN.md` and `README.ja.md`) as well.
- The README banner and diagrams in `docs/assets` are generated, in English, Chinese, and Japanese and for light and dark themes. Change the copy or layout in [`docs/assets/generate.mjs`](docs/assets/generate.mjs), run `node docs/assets/generate.mjs`, and commit the regenerated SVG files with it.
- The product screenshots in `docs/assets/screens` are generated too: [`scripts/capture-readme.mjs`](scripts/capture-readme.mjs) renders the real web app and extension against synthetic data, in English and in Simplified Chinese where the UI has it. Rerun it after a UI change the READMEs show, look at every image, and commit them together. It needs ffmpeg, xvfb, and `npm ci` in `packages/web` and `packages/extension`.

## Pull requests

- Keep each pull request focused on one change, and describe the motivation and the user-visible effect.
- Add or update tests for every behavior change. Bug fixes should come with a test that fails without the fix.
- Run `npm run check` in `packages/node` before asking for review; CI runs the same gates.
- Follow the style of the surrounding code; the package compiles with TypeScript `strict` mode.
- Update [CHANGELOG.md](CHANGELOG.md) under "Unreleased" for user-visible changes.

### CI scope

`colp-ci` runs on pull requests and pushes to `main`. The lightweight `changes` job
selects affected jobs using [`scripts/select-ci-jobs.mjs`](scripts/select-ci-jobs.mjs).
The required `ci-gate` always reports, including when all build/test jobs are skipped.

| Changed files | Selected checks |
|---|---|
| Documentation, changelogs and reports | Only `changes` and `ci-gate` |
| Package/lockfile root versions, extension manifest versions, server's generated release version | Only `changes` and `ci-gate`; dependency, permission or code changes still select checks |
| Node SDK | SDK checks, coverage, package and conformance; apps install a separately pinned SDK |
| Server | Server suites and extension/production Web integration checks |
| Web | Web checks and cross-application browser tests |
| Extension | Extension checks and server integration suites that import extension code |
| Protocol/generated contracts, shared tooling or CI configuration | Their consumers; shared tooling and CI changes run the full suite |

Cross-package fixtures and generated API types also select their consuming jobs.
Protocol Markdown used by drift checks still runs `static`; machine-readable
automation contracts under `docs/automation/design` retain their checks.
Release tags continue to run the separate server-image and extension-release workflows.

The selector compares every commit in a push and uses the merge base for a pull
request. Renames/deletions are included. Unknown paths or unavailable Git history
select the full suite. Use **Run workflow** for a manual full run. To inspect a
local commit range without running tests:

```bash
node scripts/select-ci-jobs.mjs "$(git rev-parse BASE)" "$(git rev-parse HEAD)"
```

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).

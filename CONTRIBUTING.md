# Contributing to COLP

Thank you for helping improve the Collection Protocol. This repository holds two things that move together: the protocol specification in [`protocol/`](protocol) and the Node.js reference implementation in [`packages/node/`](packages/node).

## Ways to contribute

- **Report a bug** in the package or an inconsistency in the specification with a [bug report](https://github.com/WhitenWhiten/colp/issues/new?template=bug_report.yml).
- **Propose a protocol change** with a [protocol change proposal](https://github.com/WhitenWhiten/colp/issues/new?template=protocol_change.yml). Please open the issue before writing a large pull request, so the design can be agreed first.
- **Improve documentation**, examples, and diagrams.
- **Report a security vulnerability** privately as described in [SECURITY.md](SECURITY.md). Never in a public issue.

## Development setup

You need Node.js 22 or later, npm, and Python 3 for the example validator.

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

## Pull requests

- Keep each pull request focused on one change, and describe the motivation and the user-visible effect.
- Add or update tests for every behavior change. Bug fixes should come with a test that fails without the fix.
- Run `npm run check` in `packages/node` before asking for review; CI runs the same gates.
- Follow the style of the surrounding code; the package compiles with TypeScript `strict` mode.
- Update [CHANGELOG.md](CHANGELOG.md) under "Unreleased" for user-visible changes.

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).

# Governance

COLP is a young project with a single maintainer. This document describes how decisions are made today and how that will change as more people take part.

## Roles

- **Contributors** are everyone who opens an issue, joins a discussion, reviews a pull request, or sends one.
- **Maintainers** triage issues, review and merge pull requests, cut releases, and handle security reports. They are listed below and in [`.github/CODEOWNERS`](.github/CODEOWNERS).
- The **lead maintainer** makes the final call when maintainers cannot agree.

| Maintainer | Role |
|---|---|
| [@WhitenWhiten](https://github.com/WhitenWhiten) | Lead maintainer |

## How decisions are made

**Package and documentation changes** (bug fixes, internals, docs, tooling) are merged by a maintainer once CI passes and review comments are resolved.

**Protocol changes** follow a public process, because other implementations depend on them:

1. Open a [protocol change proposal](https://github.com/WhitenWhiten/colp/issues/new?template=protocol_change.yml) describing the problem before writing a large pull request.
2. A change to normative behavior, meaning the wire format, the JSON Schema, or any `MUST`, `SHOULD`, or `MAY` statement, stays open for public comment for at least 14 days before it is merged. Editorial fixes that do not change meaning are exempt.
3. The pull request updates the specification, schema, examples, requirement registry, and reference implementation together, as described in [CONTRIBUTING.md](CONTRIBUTING.md).
4. Maintainers aim for consensus in the issue. If there is none, the lead maintainer decides and records the reasoning in the issue.

**Versioning** follows [Specification section 12](protocol/SPECIFICATION.md#colp-section-12): within one version, new data arrives only through namespaced `extensions`; new optional core fields need a new minor version; removing a field or changing a meaning or conflict rule needs a new major version. The specification and the Node.js package are versioned separately.

**Security reports** are handled privately under [SECURITY.md](SECURITY.md) and are exempt from the public comment period.

## Becoming a maintainer

Contributors who make sustained, high-quality contributions, such as reviews, fixes, or specification work, may be invited by the existing maintainers. New maintainers are added to this file and to `CODEOWNERS` in a pull request. A maintainer who steps down or is inactive for a year moves to an emeritus list.

## Changing this document

Changes to this document follow the same process and comment period as normative protocol changes.

# Security Policy

COLP handles private bookmarks, credentials, and AI-driven writes, so we take security reports seriously.

## Reporting a vulnerability

Please **do not** open a public issue for a security problem. Report it privately through GitHub:

1. Go to the repository's [Security tab](https://github.com/WhitenWhiten/colp/security).
2. Choose **Report a vulnerability** and fill in the advisory form.

Include, where you can:

- the affected component (`protocol/` specification or `packages/node`) and version or commit;
- a description of the issue and its impact;
- steps or a proof of concept that reproduce it.

You should receive an acknowledgement within 7 days. We will keep you informed while we investigate, agree on a disclosure date with you, and credit you in the advisory unless you prefer otherwise.

## Scope

In scope:

- flaws in the protocol design that allow unauthorized reads or writes, leak private data into public projections or feeds, or bypass scopes, approval plans, or rate limits;
- vulnerabilities in `@know-n/colp`, such as validation bypasses, injection, prototype pollution, SSRF, or denial of service through unbounded input.

Out of scope:

- vulnerabilities in applications built on the package, unless the package itself is at fault;
- issues that require a compromised host, storage adapter, or identity provider.

## Supported versions

The project is a pre-1.0 draft. Security fixes land on the `main` branch.

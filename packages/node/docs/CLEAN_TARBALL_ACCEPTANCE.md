# Clean tarball acceptance

Keep `npm run pack:check`: its publint, attw, ESM/CJS, JSON Schema and documented
consumer checks remain useful fast gates. The following is an additional release
check, not a replacement or a claim that the existing checks provide no protection.

Prepare a dedicated cache from the trusted repository manifest, then build and
pack a candidate and pass that **existing** artifact to:

```sh
export npm_config_cache="$(mktemp -d)/npm-cache"
node scripts/prepare-clean-consumer-cache.mjs "$npm_config_cache"
node scripts/clean-tarball-consumer.mjs /absolute/path/know-n-colp-0.1.0.tgz
```

The script copies the exact tarball bytes into an isolated temporary consumer,
performs a real npm install with lifecycle scripts disabled, loads every runtime
ESM/CJS entry and the JSON Schema, and installs exact compiler/Node type versions
from the repository lockfile. It then compiles consumers with `strict: true`,
`skipLibCheck: false`, NodeNext resolution and Node-only library declarations.
It never links the checkout's production dependencies or compiler into the
consumer, and removes ambient NODE_PATH/NODE_OPTIONS. It checks that the source
tarball has not changed before returning its SHA-256 and toolchain record.

The installed package's import probes and TypeScript compiler run only through
Docker: the probe container has no network, a read-only root and candidate
bind-mount, UID/GID `65534`, dropped capabilities, no-new-privileges, and CPU,
memory and PID limits. Docker is required; if its CLI or daemon is unavailable,
the check fails closed instead of running the candidate under the host Node.
Candidate installation, dependency extraction, and all npm resolution happen
inside the same constrained Docker boundary as the consumer checks. The
verifier requires a pre-populated npm cache (`npm_config_cache` or
`$HOME/.npm`) and mounts it read-only; npm runs with `--offline`, so an empty
or missing cache fails closed instead of causing a host-network request. The
candidate tar stream is inspected before installation, with fixed expanded-byte
and entry-count ceilings, package identity checks, path/link rejection, and
registry-only dependency specifiers.
Runtime probes use a 512 MiB container with a 256 MiB Node heap; strict
TypeScript compilation uses a 1 GiB container with a 768 MiB heap. Both keep
the same network, filesystem, privilege, CPU and PID restrictions. The package
CI job runs both the isolation regression and the complete tarball verifier.

The cache preparation step resolves only the repository's production dependencies
and locked compiler/type versions, with lifecycle scripts disabled and an isolated
environment. It never reads the candidate. A setup-node cache populated by
`npm ci` alone can lack registry metadata and is insufficient for a fresh offline
consumer. Use a dedicated cache so the Docker copy stays within its 512 MiB
budget, and remove that cache after verification. A missing cache or an
installation failure is a release failure, not a reason to turn skipLibCheck
back on. Run this on the existing local Node/OS release matrix. An unrun
matrix is not successful acceptance. The final release procedure must publish
the same artifact digest; it must not run npm pack again after this check.

# Release the accepted tarball, not a rebuilt directory

The existing release checklist, conformance evidence, coverage gates,
publint/attw, packed examples, and local Node/OS matrix remain required. This
procedure closes artifact identity; it does not replace those safeguards.

A maintainer must decide the protocol compatibility baseline, exact package
version and license. Keep `private:true` and the development version until that
decision is recorded. Missing repository/bugs metadata is reported as a warning,
not equated with npm's private-package publication block. No script chooses a
license or removes private automatically.

From the exact clean, fully evidenced source commit, with dependencies installed:

```sh
node scripts/release-artifact.mjs prepare /outside/source/accepted-release
```

This runs `npm run check` explicitly under the existing ignore-scripts policy,
then creates the release tarball once, installs those exact bytes into a clean
consumer, verifies declarations, and records SHA-256/SHA-512 plus the checked
source revision. The directory must not already exist. Any failed check aborts
preparation without producing an accepted release directory.

For pre-release engineering while private/version/license decisions remain
open, `prepare-candidate` runs the same validation but marks the result
`publishable:false`. A candidate can never be promoted merely by a publish
command; prepare and validate a new artifact after the metadata decision.

Transfer the SAME tarball to each existing local matrix environment (Linux,
Windows, macOS; Node 22 and 24). Run `clean-tarball-consumer.mjs` against it and
retain each JSON result in a matrix directory. These are local execution records,
not cryptographic remote-host attestations; maintainers own their provenance.
Do not build a different tarball on each platform.

`node scripts/release-artifact.mjs verify /outside/source/accepted-release`
verifies artifact identity without publishing. Only after the release ceremony
is approved, the explicit `publish` subcommand accepts the release directory,
matrix directory and exact `package@version` confirmation. It verifies the clean
source, metadata, all matrix artifact digests, then publishes a private temporary
copy of the accepted bytes using npm's tarball input. It never repacks the source.
Normal npm authentication and registry permissions still apply.

This repository change does not execute publication, create a public repository,
claim unrun matrix results, or manufacture conformance evidence. npm lifecycle
hooks are not the release gate; explicit checks and artifact identity are.

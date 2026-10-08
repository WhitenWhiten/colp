# Self-hosted test scope

The extraction keeps runtime tests for the shipped modules. Tests of social,
reports, governance, attachments and delivery are removed with those modules.
Know-N host acceptance scripts, private-extension fixtures and demo seed bundles
are not shipped in this package; their acceptance suites stay in Know-N.

The migration-chain helper is retained because kept migration and sync tests
use it. Edition-specific assertions expect the primary canonical event and
publication purge, without the removed feed/public-activity handler rows.

Production integration coverage includes the real composition for move,
delete, trusted approval, Undo, agent management and owner-bound key issuance.
The anonymous protocol gate is enforced by `deploy/smoke.sh`.

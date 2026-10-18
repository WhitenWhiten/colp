# Replica health installation authority

Health reports, command delivery, and command settlement require both a fresh,
verified `known.sync` credential and `Known-Sync-Replica-Proof`. An account bearer
and a replica ID alone grant no installation authority.

The opaque, server-issued Session ID serves as an installation possession proof.
Session issuance stores its SHA-256 digest separately in
`sync_replica_report_authorities`, bound to the account, replica, device ID,
browser profile, browser generation, credential issuer/client, and account
security epoch. The client retains the proof separately from its live Session,
scoped by server/account/browser/generation/replica. Proofs for pending final
delivery survive account switching, but local revocation or absence of a fresh
matching account credential prevents reading/sending them. Server epoch and
revocation checks still apply when that account signs back in. Proofs never appear in health
JSON or product status. The new header is redacted from logs.

A report verifies the current credential's revocation/epoch and active account,
replica ownership, the proof bindings and current security epoch, and retirement
before any report write, command delivery, or result settlement. Access-token
rotation and Session/lease expiry do not invalidate this separate reporting
capability. Reports neither issue a Session nor change lease, checkpoint, cursor,
last-seen, or replica lifecycle. Account epoch changes, removed accounts, changed
browser generation and retired replicas fail closed. Report-proof rows follow their
account/replica deletion lifecycle and contain only proof digests. The existing
Session store/audit retains Session identifiers under its existing access policy;
these identifiers must now also be treated as possession capabilities.

Existing-replica Session HTTP issuance also checks continuity: either the same
previously admitted credential or an installation proof is required. Otherwise
another account credential could mint a new proof for a known replica. New
replicas can enroll on their first Session under the existing registration
rules. Refreshed credentials use the retained proof.

Compatibility: the expand-only migration derives proof digests from previously
active Sessions; an old extension's retained Session can initialize its local
proof storage without a request. New Sessions register proofs transactionally.
An installation with neither a retained proof nor a retained Session cannot
report by account ownership alone. It must reestablish its installation through
its original credential/session continuity or use a new replica. We intentionally
do not grant authority based on public browser IDs or mutable access-token bytes.
Old binaries do not send this proof and their health requests are rejected;
core sync under an already admitted credential retains compatibility.

The proof is a bearer possession capability. It must be protected like the
installation's credentials. Possession of another installation's bearer proof
as well as valid account authority is outside the distinct-device-credential
isolation guarantee; this does not assert hardware attestation.

# Known Sync retirement extension, version 2

The Manifest mount extension `https://known.example/extensions/sync-retire`
advertises `version: 2`. This is a version of the Known namespaced extension;
COLP 0.2 and the separate Product OpenAPI 1.100 contract are unchanged.

The original contract remains `DELETE` of the advertised static `href`, no
request body, and the required `Authorization`, `Origin`, `Known-Sync-Session`,
and `Idempotency-Key` headers. Only `204` proves the retirement completed.
Requests without the optional proof retain the original credential, Session
liveness, policy revision, and lifecycle checks. A completed receipt may replay
after retirement terminated that Session, with current authorization checked.

Version 2 additionally advertises:

```json
{
  "reauthorization": {
    "proofHeader": "Known-Sync-Replica-Proof",
    "proof": "pinned-session",
    "authority": "current-account-installation"
  }
}
```

After explicit reset confirmation, an extension may send that optional header
with the exact same value as its durable `Known-Sync-Session`. This requests
current account authorization of the same retirement. It is not permission to
mint another old-replica Session, change the target or idempotency key, or resend
queued metadata. The verified current credential can have a different ID from
the original Session's credential. The original token need not remain valid.

The server resolves the current identity to the same active account that owns
the replica, checks current collection membership and credential revocation,
and validates the stored installation proof's device, browser profile,
generation, issuer, client, and account security epoch. Exact Origin, audience,
Session-to-replica binding, collection, and lease identity remain required.
The old Session's expiry/liveness and policy revision are replaced only in this
explicit branch by the current authority checks. Account epoch changes or a
lost installation proof deny reauthorization; fresh login alone cannot invent
that possession proof. Receipt replay repeats these checks too.

The transaction retains the Session → account → credential → collection-replica
gate → replica lock order. It commits retirement, one immutable receipt, and
Session termination together. Replaying after a lost response uses the same
request fingerprint, Session and key; changing authentication does not change
the retirement command identity. `401`, `404`, `409`, network failure, or an
unreadable response is never retirement proof.

Clients must durably retain the original command and unknown upload bytes until
the `204` is observed and recorded. A restart may restore a current credential
from the cookie but must retain the pinned Session and key. A changed login
requires a fresh explicit reset confirmation. Only after confirmed retirement
may a client archive the old queue without forging upload acknowledgements and
create a new binding that requires a complete merge. Unknown native bookmark
outcomes remain a separate blocker and cannot be cleared by server retirement.

The extension records no access token in the durable reset journal. Its pinned
Session is still sensitive installation proof: do not log or export the journal.
The active credential and Session remain in browser session storage; the reset
identity survives browser restarts in local storage. A first reset can use the
existing scoped installation proof even when its original Session has expired.
Only an exact version-2 declaration of the three reauthorization fields enables
the optional proof header. Older or unknown namespace versions remain readable
and retain the original strict retirement call.

The reset preview explains the required network confirmation and that earlier
uploads might already be in the library. Cancel sends no retirement request.
An unconfirmed response leaves the original queue, binding, and command intact.
After a confirmed response, each local archive, binding publication, and fresh
scope registration boundary can resume without a second identity rotation.
The fresh scope has no selected roots and requires the normal complete merge.
Metadata opt-out remains in force throughout; reset never resends the held
metadata or manufactures an upload acknowledgement.

Authentication failure can ask for another sign-in. Authorization denial must
also explain that signing in cannot restore revoked library access or an invalid
installation proof. Such a denial retains the pending request and local work;
it cannot be treated as proof of retirement. Local bookmark use can continue.

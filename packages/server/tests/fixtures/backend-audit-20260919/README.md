# Parent migration fixture

`classification-credits-schema.ts.txt` is the exact helper from `251b163d8`.
That audit parent has the common chain through `202610100700_classification_credits`,
followed by `202610100900_digest_owner_membership_guard` (identical body to current `101200`).
The main parent `64257aeaa` instead ends at `202610101100_classification_credit_financial_locks`.

The fixture builder copies the unchanged historical migration files and helper
directory, restores this one changed helper for the audit parent, and reconstructs
the exact parent names. This avoids depending on git history in shallow CI and
does not silently test an audit database already containing the newer credit guard.

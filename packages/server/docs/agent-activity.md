# Agent activity

Activity is the owner's shared inbox for agent bookmark additions and automation results.
`KNOWN_FEATURE_AGENT_ACTIVITY` defaults to `false`; the self-hosted preset enables it.
Its HTTP routes and bookmark producer do not require automation capture or rules to be enabled.
The worker always registers the durable activity handler so queued events can finish after a flag change.

- `GET /api/v1/me/activity?state=all|unread&limit=20&cursor=…` lists activity, newest first.
- `GET /api/v1/me/activity/summary` returns the unread item count, latest item, and maximum item revision.
- `POST /api/v1/me/activity/read` accepts either `ids` (1–100 unique IDs) or `through` (an activity ID) with optional `throughRevision` (its observed revision).
  Page-driven reads always supply the revision: a changed boundary reads nothing until a fresh read.
  Legacy callers that omit the revision explicitly read through the current version, as with `ids`.

The summary response includes `Known-Activity-Account-Id`, bound to the same authenticated request as its data.
The extension checks it against its connected account and clears activity on authentication loss or mismatch.

All routes require a browser session and return `Cache-Control: private, no-store`.
The read command also requires Origin, CSRF, and Known-Command-Id headers.
Unknown or foreign read IDs have no effect. A repeated command id replays its original result,
even if a newer run outcome has since reopened the item. Reusing it with another payload returns 409;
an expired receipt returns 410 without applying the read again.

Unread agent additions aggregate by owner, verified agent client, and collection for at most 24 hours
from the first inbox delivery. Later deliveries never extend this window. Source occurrence times remain
unchanged, so delayed or out-of-order outbox events can aggregate after a worker outage.
Samples, folder names, agent names, and collection names are read from current server records.
Run completion, partial success, failure, review, and approval attention update one activity item per run.
Cancelled runs and resolved approval requests are removed from the inbox; restarting a run clears its obsolete outcome
unless an approval is still pending. New final outcomes create a fresh notification.
Placement-only runs and manual selection parents do not create activity.

Activity read state is shared across the web and extension. Reading run outputs also clears that run's
activity item in the same transaction; reading activity never advances the run's output watermark.
The worker purges bounded batches hourly: read items older than 90 days, and all items older than 365 days.

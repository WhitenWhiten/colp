# Agent activity

Activity is the owner's shared inbox for agent bookmark additions and automation results.
`KNOWN_FEATURE_AGENT_ACTIVITY` defaults to `false`; the self-hosted preset enables it.
Its HTTP routes and bookmark producer do not require automation capture or rules to be enabled.
The worker always registers the durable activity handler so queued events can finish after a flag change.

- `GET /api/v1/me/activity?state=all|unread&limit=20&cursor=…` lists activity, newest first.
- `GET /api/v1/me/activity/summary` returns the unread item count, latest item, and maximum item revision.
- `POST /api/v1/me/activity/read` accepts either `ids` (1–100 unique IDs) or `through` (an activity ID).

All routes require a browser session and return `Cache-Control: private, no-store`.
The read command also requires Origin, CSRF, and Known-Command-Id headers.
Unknown or foreign read IDs have no effect; repeated reads are harmless.

Unread agent additions aggregate by owner, verified agent client, and collection for at most 24 hours.
Samples, folder names, agent names, and collection names are read from current server records.
Run completion, partial success, failure, review, and approval attention update one activity item per run.
Placement-only runs and manual selection parents do not create activity.

Activity read state is shared across the web and extension. Reading run outputs also clears that run's
activity item in the same transaction; reading activity never advances the run's output watermark.
The worker purges bounded batches hourly: read items older than 90 days, and all items older than 365 days.

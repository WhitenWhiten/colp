# Upstream

Copied from Know-N commit `c34645710eb3d0067ef734cf7a674364df765687` (`Known-Frontend/web`) on 2026-10-07.

The package name stays `known` (`private: true`). Neither 02-plan.md nor the C1 card renames it to `@know-n/colp-web`. License: Apache-2.0.

`VITE_EDITION=self-hosted` (set on the production build) drops the social and cloud routes from the route table and navigation: explore, public profiles (`/u`, `/profile`), follow (`/library/following`), activity (Today), notifications, comments, votes, moderation, reports and digests, plus the other §10 removals (feed, community, credits, ai, classify, admin, share, path, developers, demo). Cloud feature flags are forced off. `/register` reads `GET /api/v1/auth/registration-state` and shows sign-up only when `open` is true (`first-run` owner form, `invite` form, otherwise a closed notice).

Page modules stay in the tree. The copied unit suite runs with the edition unset, so those tests still mount the cloud UI. Agents (C3) and the insecure-transport banner (C4) are not added.

OpenAPI aliases point at `packages/server/generated/openapi` (the full client copied with the server), not a regenerated trimmed client. C2 replaces that client.

`upstream-fixtures/` holds the Know-N files the copied unit tests read by relative path (product evidence notes, the credits golden file, `nginx.conf`, and Known-Extension `popup.css`). They are not part of the self-hosted product.

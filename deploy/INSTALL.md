# COLP Server — install and operate

COLP Server keeps your bookmarks in sync across browsers, lets AI agents
work on your collections under your approval, and lets you share a
collection with a link. It runs on your machine as three containers: the
server, PostgreSQL, and Caddy.

## 1. Prerequisites

- A Linux host, a Mac, or Windows with WSL2, with Docker Engine 24 or later
  and the `docker compose` plugin (`docker compose version` prints 2.x).
- 1 CPU, 1 GB RAM, 2 GB disk for a personal library.
- One of the three network setups in the next section.

## 2. Choose how browsers reach the server

| Setup | Pick when | You need | `.env` values |
|---|---|---|---|
| **Domain with automatic HTTPS** (default) | The server has a public DNS name and ports 80 and 443 reachable from the internet | A domain pointing at the host | `COLP_SERVER_ORIGIN=https://colp.example.net`, profile `tls-auto` |
| **Private HTTPS** | Home network, no domain | Install Caddy's local CA once per browser profile (section 4.1) | `COLP_SERVER_ORIGIN=https://192.168.1.20`, profile `tls-internal` |
| **Plain HTTP** | This machine only, you accept unencrypted traffic | Nothing | `COLP_SERVER_ORIGIN=http://127.0.0.1:8080`, `COLP_INSECURE_HTTP=true`, profile `http` |

Plain HTTP works only on this machine: the origin must be `127.0.0.1`,
`localhost`, or `[::1]`, and the `http` profile publishes its port on
127.0.0.1 only. COLP requires HTTPS for every other address, so the server
refuses to start with a LAN `http://` origin; for a home network use
**Private HTTPS**. On plain HTTP your password, session, and bookmarks are
not encrypted. The server logs a warning on every start, the web UI shows a
banner, and the extension asks you to confirm before it saves the origin.
Hosted AI agents and OAuth clients need HTTPS.

## 3. Install

```sh
git clone https://github.com/WhitenWhiten/colp.git
cd colp/deploy
cp .env.example .env
# edit .env: COLP_SERVER_ORIGIN, POSTGRES_PASSWORD, COLP_SERVER_SECRET (openssl rand -base64 48)
docker compose --profile tls-auto up -d     # or tls-internal, or http
```

Wait until the server is ready (first start runs the database migrations).
The check runs inside the server container, so it works before your browser
trusts a tls-internal certificate:

```sh
until docker compose exec server colp-server ready; do sleep 2; done
```

## 4. First run

Open the server origin in a browser. The first-run page asks for a username,
a password, and the **setup token**, and creates the owner account.
Registration closes after that. The token proves you run the server; until
the owner exists, anyone who reaches the origin could otherwise claim it.
The server prints it on every start while no owner exists:

```sh
docker compose logs server | grep "First run"
docker compose exec server colp-server setup-token     # prints the same token
```

Without a browser (no token needed inside the container):

```sh
docker compose exec server colp-server create-user --username alice
```

### 4.1 Private HTTPS: trust the local CA

```sh
docker compose cp caddy-tls-internal:/data/caddy/pki/authorities/local/root.crt ./colp-local-ca.crt
```
Import `colp-local-ca.crt` as a trusted authority in each browser profile
(Chrome: Settings → Privacy and security → Security → Manage certificates →
Authorities → Import).

## 5. Connect a browser

1. Install the Known extension from the Chrome Web Store.
2. Extension → Options → Account → **Server**: enter your origin. Grant the
   permission for that origin when asked. The server's name appears.
3. Sign in with your username and password.
4. Pick a collection (or create one) and the bookmark folders to sync. Repeat
   on each browser; they converge within a minute.

The web Sync center (`/sync`) lists connected browsers, conflicts, and the
trash.

## 6. Connect an agent

Open **Agents** in the web UI and copy the endpoint.

**Claude Code** (OAuth, HTTPS required):
```sh
claude mcp add --transport http colp "https://colp.example.net/collections/-/mcp-compat"
```
Run a command; the browser opens the server's consent page; approve. The
agent appears in the Agents list.

**Codex and other clients that speak MCP 2026-07-28**: use
`/collections/-/mcp` instead of `/collections/-/mcp-compat`.

**A script with an API key** (HTTPS, or explicitly acknowledged HTTP):
Agents → **Issue key**, copy the credential once into `KEY`. Exchange it for
an access token, then send that token to MCP. This example uses `jq`:

```sh
ACCESS_TOKEN=$(curl -fsS -H "Content-Type: application/json" \
  -d "{\"grant_type\":\"urn:known:params:oauth:grant-type:account-key\",\"credential\":\"$KEY\",\"audience\":\"mcp_strict\",\"scope\":\"mcp:read:public mcp:read:own nodes:read\"}" \
  "$COLP_SERVER_ORIGIN/api/v1/auth/key-token" | jq -er .access_token)
curl -H "Authorization: Bearer $ACCESS_TOKEN" -H "MCP-Protocol-Version: 2026-07-28" \
  -H "MCP-Method: tools/list" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{"tools":{"call":true}},"io.modelcontextprotocol/clientInfo":{"name":"script","version":"1.0"}}}}' \
  "$COLP_SERVER_ORIGIN/collections/-/mcp"
```

The built-in issuer verifies its public keys from the local database, including
API-key signing keys, so it does not need to reach its public origin from inside
Docker. External issuers still use their configured JWKS endpoint.
Hosted OAuth clients still require HTTPS. An API-key script also works on
the plain HTTP profile (`http://127.0.0.1:8080` with `COLP_INSECURE_HTTP=true`).

**Approval policy.** Each agent starts as *manual*: a plan that changes
your collection waits on the Approvals page. Switch an agent to *trusted* to
let reversible plans commit at once with an Undo button. Making a collection
public, deleting a collection, emptying the trash, and purging always wait
for you.

## 7. Share a collection

Open the collection → Visibility → **Unlisted** (link only) or **Public**
(listed on your server's directory). Copy the link and send it. Set it back
to **Private** to stop access.

## 8. Check health and version

```sh
curl -fsS "$COLP_SERVER_ORIGIN/health"      # {"status":"ok","version":{"server":"0.1.0","colp":"0.1.1","protocols":["0.1","0.2"]}}
curl -fsS "$COLP_SERVER_ORIGIN/ready"       # 200 only when the database is reachable and migrations are current
docker compose exec server colp-server ready      # the same check from inside the container
docker compose exec server colp-server --version
```
The web **About** page shows the same.

## 9. Back up

```sh
./backup.sh            # writes colp-backup-<timestamp>.dump in the current directory
```
The file is a PostgreSQL custom-format dump (already compressed). It appears
only when the dump finished, so a failed run leaves no partial file.
Nightly, with cron:
```
0 3 * * * cd /path/to/colp/deploy && ./backup.sh >/dev/null 2>&1
```
Copy the files somewhere else; they contain everything.

## 10. Restore

On a fresh install (section 3 done) or on this machine:

```sh
docker compose stop server
./restore.sh colp-backup-20261007T030000.dump
```
`restore.sh` drops and recreates the database before loading the backup, so
nothing from the current database survives, then starts the stack and waits
until the server is ready. Older `.sql.gz` backups restore the same way.
Sign in with the credentials from the backup. Browsers keep syncing without
re-login when the origin is unchanged.

## 11. Upgrade

```sh
./backup.sh
docker compose pull
docker compose up -d
until docker compose exec server colp-server ready; do sleep 2; done
```
Read the CHANGELOG section for the new version first; "Upgrade notes: none"
means nothing else to do. `compose.yaml` follows the `0.1` tag, so `pull`
brings fixes only; to move to a new minor, set `COLP_IMAGE_TAG` in `.env`.

To be able to go back, pin the exact version you run before upgrading
(`COLP_IMAGE_TAG=0.1.0` in `.env`). An older server cannot run on a database
a newer one migrated, so going back means restoring the backup taken before
the upgrade:

```sh
docker compose stop server
# set COLP_IMAGE_TAG in .env back to the previous version
./restore.sh colp-backup-<timestamp>.dump
```

## 12. Reset a password

```sh
docker compose exec server colp-server reset-password --username alice
```

## 13. Move to another machine

Back up (9), install on the new machine (3), restore (10), then in each
browser change the extension's Server field if the origin changed.

## 14. Take your data out

```sh
docker compose exec server colp-server export --username alice --out /export
docker compose cp server:/export ./export
```
`export/` holds, per collection, `<name>.html` (bookmark file every browser
imports) and `<name>.json` (the full COLP snapshot with notes and tags),
plus `index.json`. The collection page has the same under **Export**.

## 15. Uninstall

```sh
docker compose exec server colp-server export --username alice --out /export && docker compose cp server:/export ./export
./backup.sh                          # optional
docker compose down -v               # removes containers and the database volume
cd .. && rm -rf colp
```
In each browser: extension → Options → Account → **Disconnect server**.
Bookmarks stay where they are. Agents get a connection error on their next
call; nothing keeps working elsewhere.

## 16. Troubleshooting

| Symptom | Log line or check | Fix |
|---|---|---|
| `/ready` stays 503 | `docker compose logs server` shows `migration ... failed` | Run `docker compose exec server colp-server migrate`; if it fails again, open an issue with the line |
| First-run page says the setup token is wrong | | `docker compose exec server colp-server setup-token`; it changes only with `COLP_SERVER_SECRET` |
| Registration says it is closed | An owner already exists | Sign in, or `colp-server reset-password --username <name>` |
| Server exits at start | `COLP_SERVER_SECRET must be at least 32 bytes` | `openssl rand -base64 48` into `.env` |
| Server exits at start | `PRODUCT_ORIGIN must use https in production` | An `http://127.0.0.1` origin also needs `COLP_INSECURE_HTTP=true` |
| Server exits at start | `COLP_SERVER_ORIGIN may use http:// only on 127.0.0.1, localhost, or [::1]` | A LAN address needs HTTPS: `https://192.168.1.20` with the `tls-internal` profile (section 4.1) |
| Server exits at start | `COLP_MULTI_USER=true needs invite codes` | Set `COLP_MULTI_USER=false`; more accounts arrive with invite codes in 0.3.0 |
| Browser shows certificate error (tls-internal) | | Section 4.1 on that profile |
| Extension says "not a COLP server" | `curl $ORIGIN/.well-known/collection-protocol` returns HTML | Caddy profile mismatch; check `docker compose --profile <p> ps` |
| Extension sign-in fails on HTTP | cookie rejected | Confirm `COLP_INSECURE_HTTP=true` on the server and the `http://` origin in the extension |
| Claude Code cannot complete OAuth | redirect blocked | OAuth needs an HTTPS origin (section 2). On `http://127.0.0.1:8080` use an API key script (section 6) |
| Sync shows a conflict | Sync center | Pick a side; nothing is lost |
| Deleted bookmarks by mistake | Sync center → Trash | Restore |
| Agent did something wrong | Approvals → the plan → Undo; or collection → History → Restore | |

## 17. Configuration reference

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `COLP_SERVER_ORIGIN` | yes | | Exact public origin |
| `POSTGRES_PASSWORD` | yes | | Database password; compose builds `DATABASE_URL` from it |
| `COLP_SERVER_SECRET` | yes | | ≥ 32 bytes base64; every key derives from it; changing it signs everyone out |
| `COLP_INSECURE_HTTP` | no | `false` | Allow an `http://` origin on 127.0.0.1, localhost, or [::1] |
| `COLP_ALLOWED_EXTENSION_IDS` | no | store ID | Extension IDs allowed to sign in |
| `COLP_MULTI_USER` | no | `false` | Must stay `false`; invite-only accounts arrive in 0.3.0 |
| `COLP_LOG_LEVEL` | no | `info` | |
| `COLP_IMAGE_TAG` | no | `0.1` | Image tag compose follows; pin an exact version to be able to go back (section 11) |
| `COLP_HTTP_PORT` | no | `8080` | Port the `http` profile publishes on 127.0.0.1 |

Advanced: any `KNOWN_*` variable set in `.env` overrides the derived value.

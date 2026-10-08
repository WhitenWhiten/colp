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

Plain HTTP means your password, session, and bookmarks travel unencrypted on
your network. The server logs a warning on every start, the web UI shows a
banner, and the extension asks you to confirm twice. Hosted AI agents and
OAuth clients require HTTPS; local agents with API keys work over HTTP.

## 3. Install

```sh
git clone https://github.com/WhitenWhiten/colp.git
cd colp/deploy
cp .env.example .env
# edit .env: COLP_SERVER_ORIGIN, POSTGRES_PASSWORD, COLP_SERVER_SECRET (openssl rand -base64 48)
docker compose --profile tls-auto up -d     # or tls-internal, or http
```

Wait until the server is ready (first start runs the database migrations):

```sh
until curl -fsS "$(grep ^COLP_SERVER_ORIGIN .env | cut -d= -f2)/ready"; do sleep 2; done
```

## 4. First run

Open the server origin in a browser. The first-run page asks for a username
and a password and creates the owner account. Registration closes after that.

Without a browser:

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

**A script with an API key** (works over HTTP too): Agents → **Issue key**,
copy it once, then:
```sh
curl -H "Authorization: Bearer $KEY" -H "MCP-Protocol-Version: 2026-07-28" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  "$COLP_SERVER_ORIGIN/collections/-/mcp"
```

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
curl -fsS "$COLP_SERVER_ORIGIN/health"      # {"status":"ok","version":"0.1.0"}
curl -fsS "$COLP_SERVER_ORIGIN/ready"       # 200 only when the database is reachable and migrations are current
docker compose exec server colp-server --version
```
The web **About** page shows the same.

## 9. Back up

```sh
./backup.sh            # writes colp-backup-<timestamp>.sql.gz in deploy/
```
Nightly, with cron:
```
0 3 * * * cd /path/to/colp/deploy && ./backup.sh >/dev/null 2>&1
```
Copy the files somewhere else; they contain everything.

## 10. Restore

On a fresh install (sections 3 and 4 done, but before creating a user), or
on this machine after stopping the server:

```sh
docker compose stop server
./restore.sh colp-backup-20261007T030000.sql.gz
```
Sign in with the credentials from the backup. Browsers keep syncing without
re-login when the origin is unchanged.

## 11. Upgrade

```sh
./backup.sh
docker compose pull
docker compose up -d
curl -fsS "$COLP_SERVER_ORIGIN/ready"
```
Read the CHANGELOG section for the new version first; "Upgrade notes: none"
means nothing else to do. `compose.yaml` follows the `0.1` tag, so `pull`
brings fixes only; to move to a new minor, set `COLP_IMAGE_TAG` in `.env`.
Downgrade is not supported; restore the backup you took before upgrading.

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
| Server exits at start | `COLP_SERVER_SECRET must be at least 32 bytes` | `openssl rand -base64 48` into `.env` |
| Server exits at start | `origin is http:// but COLP_INSECURE_HTTP is not true` | Use HTTPS, or set `COLP_INSECURE_HTTP=true` knowingly |
| Server exits at start | `Publication Annotation origin must be an exact HTTP(S) origin` | A non-loopback `http://` origin is rejected. Use `https://`, or `http://127.0.0.1:8080` with `COLP_INSECURE_HTTP=true` |
| Browser shows certificate error (tls-internal) | | Section 4.1 on that profile |
| Extension says "not a COLP server" | `curl $ORIGIN/.well-known/collection-protocol` returns HTML | Caddy profile mismatch; check `docker compose --profile <p> ps` |
| Extension sign-in fails on HTTP | cookie rejected | Confirm `COLP_INSECURE_HTTP=true` on the server and the `http://` origin in the extension |
| Claude Code cannot complete OAuth | redirect blocked | OAuth needs HTTPS; use an API key over HTTP |
| Sync shows a conflict | Sync center | Pick a side; nothing is lost |
| Deleted bookmarks by mistake | Sync center → Trash | Restore |
| Agent did something wrong | Approvals → the plan → Undo; or collection → History → Restore | |

## 17. Configuration reference

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `COLP_SERVER_ORIGIN` | yes | | Exact public origin |
| `POSTGRES_PASSWORD` | yes | | Database password; compose builds `DATABASE_URL` from it |
| `COLP_SERVER_SECRET` | yes | | ≥ 32 bytes base64; every key derives from it; changing it signs everyone out |
| `COLP_INSECURE_HTTP` | no | `false` | Allow an `http://` origin |
| `COLP_ALLOWED_EXTENSION_IDS` | no | store ID | Extension IDs allowed to sign in |
| `COLP_SMTP_URL` | no | | Enables email password reset |
| `COLP_MULTI_USER` | no | `false` | Invite-only accounts (0.3.0) |
| `COLP_LOG_LEVEL` | no | `info` | |
| `COLP_IMAGE_TAG` | no | `0.1` | Image tag compose follows |

Advanced: any `KNOWN_*` variable set in `.env` overrides the derived value.

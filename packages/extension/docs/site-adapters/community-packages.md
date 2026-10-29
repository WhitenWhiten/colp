# Site adapter packages

A package adds a website to the extension without rebuilding it. It is a full site adapter: the same contract as a bundled adapter (`detectSource`, `start` with `context.emit`, `readItemsPage` and the other readers), for any HTTPS site you choose. Once installed, the site appears in Settings → Site adapters next to the built-in ones. You turn it on, connect the account, choose collections and a folder, save live favorites and import the saved list exactly as you would for a bundled site. The host does everything after bootstrap the same way for both: leases, account fences, pacing, the ledger, folder layout, native bookmark writes, Sync and recovery.

The difference is where the code comes from and where it runs. A bundled adapter is reviewed and shipped inside the extension. A package is a file you select. Its code runs only through `chrome.userScripts`, in a USER_SCRIPT world of its own, and never in the service worker or an extension page.

## Writing a package

A package is built from a folder with three files:

| File | Contents |
| --- | --- |
| `manifest.json` | what the site is: identity, pages, capabilities, collections and item URLs (below) |
| `provenance.json` | `maintainer`, `revision` (`local`, or an immutable 40–64 hex character revision) and an HTTPS `sourceUrl` without credentials, query or fragment. It is shown at review and establishes no trust. |
| `adapter.js` | the body of a function that receives `sdk` and returns the adapter |

Pack it into one installable file, then choose that file under Add-on packages:

```sh
node scripts/pack-site-adapter.mjs path/to/folder shelf.json
```

The worked example is [`tests/fixtures/site-adapters/shelf-package/`](../../tests/fixtures/site-adapters/shelf-package): the fictional Shelf site from [adding a website](adding-a-site.md), written as a package. [`tests/site-adapter-community.test.ts`](../../tests/site-adapter-community.test.ts) runs it through the same `qualifySiteAdapter` checks as a bundled adapter, and [`e2e/mv3-site-adapter-community.spec.ts`](../../e2e/mv3-site-adapter-community.spec.ts) installs it in Chromium and saves a favorite with it.

### `adapter.js`

Write it like a bundled `adapter.ts`, but as a function body that ends with `return { … }`. Everything a bundled adapter imports from the host comes in on `sdk`:

| `sdk` | Bundled equivalent |
| --- | --- |
| `sdk.readPolicy` | `services.readPolicy`: request spacing, timeouts, attempts and response budget |
| `sdk.fail(code, retryAfterMs?, { httpStatus, sourceCode })` | `fail` from `read-errors.ts` |
| `sdk.abortableSleep(ms, signal)` | `abortableSleep` from `read-errors.ts` |
| `sdk.siteDisplayTitle(value)` | `siteDisplayTitle` from `title.ts` |

The adapter receives the same `document`, `signal`, `deadlineAt` and `context.dom` helpers, and the [rules](adding-a-site.md#rules) and [failure mapping](adding-a-site.md#mapping-site-conditions-to-failures) of the bundled guide apply unchanged. The file must be self-contained: no imports, no remote code. It cannot use `chrome.bookmarks`, `chrome.storage` or other extension APIs; the world only has messaging to the host, which the host runtime uses for you.

### `manifest.json`

```json
{
  "apiVersion": "known.site-adapter/v1",
  "adapterId": "community.shelf",
  "version": "1.0.0",
  "label": "Shelf",
  "siteKey": "shelf",
  "identityVersion": 1,
  "matches": ["https://shelf.example/*"],
  "execution": { "mode": "userScript", "entry": "adapter.js", "runAt": "document_start" },
  "capabilities": ["observeFavorites", "enumerateItems"],
  "defaultCollection": { "id": "saved", "title": "Saved" },
  "itemUrl": "https://shelf.example/a/{id}",
  "contentIdScope": "site"
}
```

| Field | Meaning |
| --- | --- |
| `adapterId` | `community.` plus lowercase letters, digits, dots and dashes. It keys the package, its settings and its storage; an install with the same ID is an update. |
| `version` | `major.minor.patch`. A different file needs a different version. |
| `label` | the site's name in Settings, at most 64 characters |
| `siteKey`, `identityVersion` | the identity namespace of the site's items. It cannot be one a bundled site or another installed package already uses. Changing it in an update starts a new connection; never change it to fix a label. |
| `matches` | up to 16 Chrome match patterns on explicit HTTPS hosts (no wildcard host, no port). The first one's origin is the site's origin. Turning the site on asks for access to exactly these. |
| `execution.runAt` | `document_start` or `document_idle` |
| `capabilities` | any of `observeFavorites`, `enumerateItems`, `enumerateCollections`, `resolveItem`, `readMemberships`, declared only when implemented. [Step 1 of the bundled guide](adding-a-site.md#step-1-choose-capabilities) explains which to pick. |
| `defaultCollection` | `{ id, title }` for a site with one list per account. Requires `enumerateItems` and rules out `enumerateCollections`. |
| `itemUrl` | optional, see below |
| `connectOrigins` | optional HTTPS origins the code may `fetch` besides the matched sites, for example an API host |
| `connectionKind`, `readScope`, `contentIdScope`, `collectionSnapshot`, `negativeReadback`, `importResume`, `readPolicy` | as in the bundled [`SiteDefinition` fields](adding-a-site.md#sitedefinition-fields), with the same registry checks |
| `icon` | optional: `{"kind":"favicon"}` or a self-contained `data:image/png`, `jpeg`, `webp` or `x-icon` base64 URL of at most 128 KiB. A remote image URL is refused, so opening Settings never contacts an author-controlled host. |

Unknown fields fail closed. A bundled adapter's site checks are TypeScript functions; a package cannot ship code to the worker, so the host builds them from the manifest instead ([`community-definition.ts`](../../src/site-adapters/community-definition.ts)):

- Account and item IDs are nonblank strings of at most 128 characters without control characters. Collection IDs are the same, or exactly `defaultCollection.id` when there is one. Collections are flat (`parentId: null`).
- With `itemUrl`, an item's ID is the `{id}` part of its canonical URL. `{id}` stands once in the path (`https://shelf.example/a/{id}`) or as one query value (`https://video.example/watch?v={id}`), and IDs use only `A–Z a–z 0–9 . _ ~ -`. Items must then carry `identity: "siteId"` and exactly that URL. The host can also recognize the site's pages when you save one from the popup, and hint confirmation (`context.hint` with `resolveItem` and `readMemberships`) becomes available.
- Without `itemUrl`, an item keeps whatever ID and HTTPS URL the site gives it. That suits sites whose saved items link elsewhere. Popup recognition and hints are unavailable.

The legacy COLP Server cloud archive needs a server-side identity codec, so it stays unavailable to packages. Saving into synced folders uses the generic path, which needs no codec.

## Install, turn on, update, remove

Settings → Site adapters → Add-on packages inspects the selected UTF-8 JSON file as inert data. It shows the authored source, manifest, provenance, sites and capabilities, and SHA-256 over the **exact file bytes**, then requires the page-access risk acknowledgment. There is no npm step, install hook, privileged evaluation, mutable URL updater, signature verifier or trusted-catalog badge. Provenance is unverified metadata; an author cannot declare a package official.

A newly installed package's site starts off and opens on its own page. Turning it on asks for optional `userScripts` and `webNavigation` and for access to the manifest's `matches`. Chrome additionally requires **Allow User Scripts** in Extensions → Know-N → Details; reload the extension after changing it. The site page says when that toggle is missing. The required extension permissions and extension-page CSP are unchanged.

An update is reviewed and acknowledged like an install. The site keeps its settings, connection and folder; the new code runs in a new world with a new credential, and open pages of the site reattach to it. If the update matches new pages, the site asks for that access before it continues. The last three reviewed versions are kept, and rolling back to one is reviewed the same way. Removing a package turns its site off, unregisters its code and takes it out of the Sites list. Bookmarks it created stay.

Packages in the earlier hint-only format (a script that only called `api.reportHint`) stay listed but run nowhere; install an updated package to use the site.

## Isolation and authority

Each package generation has a named USER_SCRIPT world (`colp-user-<installation>-<generation>`), messaging to the host and a CSP of `script-src 'self'; object-src 'none'; connect-src 'self'` plus its matched origins and `connectOrigins`. The host's page runtime (`site-adapter-community.js`, built from [`community-page.ts`](../../src/site-adapters/community-page.ts)) runs first, then a generated wrapper that starts it with the reviewed manifest and this generation's installation credential. The runtime presents that credential at activation and bootstrap. Everything after that uses the ordinary lease and capability of the bundled transport, over `onUserScriptMessage` and `onUserScriptConnect`. A package's page code cannot reach the bundled content-script channel or management, and bundled code cannot bootstrap a package's site.

The worker checks every message against the derived definition, the browser-provided sender, document, origin, frame and route, the current lease, the site's grants and the Allow User Scripts toggle, which it probes by calling the API. A replaced or removed package's credential grants nothing, even if its old world survives. Packages run on Chromium 149+, like bundled adapters.

A credential identifies an installed package, not the truth of its reports. Once you turn the site on, what the package reports becomes bookmarks in the folder you chose; it can make up favorites in that folder. USER_SCRIPT does not make unknown code safe either: installed code can read and alter its sites' pages, make requests with the site's session and expose visible private content. The warning is shown before consent. The world CSP is defense in depth, not a complete data-loss sandbox.

## Limits

The file limit is 512 KiB and authored code 256 KiB. UTF-8 must round-trip exactly; a leading BOM and invalid Unicode are rejected rather than silently changing hashed bytes. At most eight installations, three prior reviewed versions each, and 16 MiB of stored package state are retained. A preview expires after ten minutes. Each site has the same read, lease, queue and page limits as a bundled site ([host limits](adding-a-site.md#why-the-less-obvious-lines-are-there)).

The [official userScripts API reference](https://developer.chrome.com/docs/extensions/reference/api/userScripts) was read on 2026-10-24 (page last updated 2026-09-11). It documents named worlds from Chrome 133, immediate `execute` from 135, the per-extension toggle from 138, user-script message events and clearing registrations on extension update. Portable bookmark backups do not restore user-script credentials or run previously installed code. The exact passing checks belong in [execution evidence](execution-evidence.md).

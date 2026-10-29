# Separately installed packages (SA-09)

The advanced installer in Settings → Site adapters accepts a user-selected UTF-8 JSON file. It inspects inert data, shows authored source, maintainer/revision, SHA-256 over the **exact file bytes**, sites and capabilities, and requires the concrete page-access risk acknowledgment. There is no npm step, install hook, privileged evaluation, mutable URL updater, signature verifier or trusted-catalog badge. Provenance is unverified metadata. An author cannot declare a package official.

Install and every update persist reviewed bytes **disabled** before registration. A separate enable action needs optional `userScripts`, `webNavigation` and the package’s declared site permissions, plus Chrome's Allow User Scripts setting. Reload the extension after changing that browser setting, then reopen Site adapters. Denial or an unavailable API leaves the package disabled and ordinary/bundled features independent. The required extension permissions and extension-page CSP are unchanged.

## Version-one format and limits

Packages may target any explicit HTTPS site and choose their site identity and version. Direct observations, read recipes, MAIN probes, captures and model capabilities are not supported in this format. A compatible built-in reader is required to turn hints into archive work; currently only Bilibili identity v1 has one. Other packages run in inspector mode. Packages may provide their own page observation logic; a hint is not proof that a person performed an action.

```json
{
  "manifest": {
    "apiVersion": "known.site-adapter/v1",
    "adapterId": "community.example",
    "version": "1.0.0",
    "siteKey": "bilibili",
    "identityVersion": 1,
    "matches": ["https://www.bilibili.com/*"],
    "execution": { "mode": "userScript", "entry": "adapter.js", "runAt": "document_start" },
    "capabilities": ["observeFavorites"],
    "icon": { "kind": "data", "dataUrl": "data:image/png;base64,..." }
  },
  "provenance": {
    "maintainer": "Your chosen author (unverified)",
    "revision": "local",
    "sourceUrl": "https://example.com/source"
  },
  "script": "// Self-contained function body with api.signal and api.reportHint(hint).\n// Return a cleanup function when installing listeners.\n"
}
```

`revision` is `local` for authored bytes or an immutable 40–64 character hexadecimal revision. The HTTPS source URL cannot contain credentials, a query or fragment. It establishes no publisher trust. Unknown manifest/package fields fail closed. `icon` is optional: omit it or use `{"kind":"favicon"}` for the supported site's browser favicon. A custom icon is a self-contained `data:image/png`, `data:image/jpeg`, `data:image/webp` or `data:image/x-icon` base64 URL of at most 128 KiB; package manifests cannot name a remote image, so opening Settings never contacts an author-controlled host. If the image cannot be decoded the page falls back to the favicon, then to the site's first letter. The icon is part of the reviewed manifest bytes, so changing it requires review like any other package change. UTF-8 must round-trip exactly; a leading BOM and invalid Unicode are rejected rather than silently changing hashed bytes. The file limit is 512 KiB and authored code 256 KiB. At most eight installations, three prior reviewed versions each, and 16 MiB of stored package state are retained. A preview expires after ten minutes. Each installation has at most 32 active document leases and 16 bootstrap/hint requests per minute, persisted across worker restarts; the ingress admits at most 16 concurrent messages. The shared confirmation scheduler keeps its existing API pace, queue/deadline and byte limits.

## Worlds, source reads and authority

Only `chrome.userScripts` registers/executes downloaded bytes. Each installation generation has a named USER_SCRIPT world, restrictive CSP and separately configured messaging. The authored-byte digest is separate from the generated wrapper. The wrapper keeps its installation credential and document capability out of the DOM/MAIN world and grants only `api.mode`, `api.signal` and `api.reportHint`. It offers no bookmarks, private storage, native IDs, background fetch proxy or model API. Host listeners use `onUserScriptMessage`; user-script ports are rejected and cannot enter bundled/extension-page channels. Actual sender ID/origin, top frame, non-incognito active document, current navigation URL/route, exact registered bytes/world/matches, permission/toggle and generation all remain host-checked. Claimed world IDs grant nothing.

Inspector mode records a bounded latest hint, with zero source queue/native/model work. To permit archive hints, the user separately previews the current verified account, collection IDs/titles, root path, source generations and policy revision, then approves that exact digest. This does not transfer authority from another package or version. The bundled reader must establish fresh positive membership and item identity through its fixed, paced operations. Facts remain `membership.observed`, with community package/generation/scope provenance retained. The same shared ledger/reservations/planned-native executor handles copies, with zero folder/tag model calls.

Grant checks run before reads, before accepting their result, during layout planning and immediately before native dispatch. A scope/account/root/policy change, package disable/remove/update, browser toggle failure or extension-version change stops affected unsent work. Already-issued native results retain their original recovery identity. A surviving old world cannot revive its old capability after replacement; cleanup is best effort and is not the authority fence. SPA invalidates the old lease before explicit reattachment. BFCache pagehide aborts the old wrapper and pageshow obtains a fresh lease. Missing immediate execution support reports `reloadRequired`; no scripting/MAIN fallback exists. Already-open pages attach late and cannot recover earlier interactions.

Updates show code/metadata changes and require another acknowledgment. A changed site match requires review of the updated package and permission for its declared sites before enabling. Replacement and rollback rotate credentials/generations, clear leases/archive grants and keep prior approved bytes for explicit review. Extension updates compare the installed host version before accepting messages or native authority, rotate/re-register approved code, and require archive scope approval again. Browser toggle revocation is checked by actually calling `getScripts`, including when a cached API object still exists.

USER_SCRIPT and inspector mode do not make unknown code safe. Installed code can read/alter authorized pages, make requests using the site's session and expose visible private content, including through page DOM behavior. The warning is shown before consent. The world CSP is defense in depth, not a complete data-loss sandbox.

## Browser evidence and exclusions

The product requires Chromium 149+. The controlled xvfb test measures named-world immediate execution, actual browser-toggle revocation, actual extension-version replacement, private API isolation, fresh scoped archive creation, stale/forged messages, a surviving old world, explicit rollback, SPA and a real BFCache hit. The API/toggle checks run with Developer mode off; the final unpacked-artifact version reload uses Developer mode, as required by the development install. Older Chromium 121–148 is explicitly unsupported; the older branches in acceptance case 16 are not claimed tested. Chrome 154 was used for the separate bundled real-site acceptance, not for executing a community package.

The [official userScripts API reference](https://developer.chrome.com/docs/extensions/reference/api/userScripts) was read on 2026-10-24 (page last updated 2026-09-11). It documents named worlds from Chrome 133, immediate `execute` from 135, the per-extension toggle from 138, independent user-script message events and clearing registrations on extension update. Those API milestones do not qualify older product versions. The exact passing checks, artifact hashes and remaining limits belong in [execution evidence](execution-evidence.md).

No community code was installed into the user's real Bilibili session during acceptance. Test packages, browser profiles and the copied extension artifact are disposable controlled fixtures. Portable bookmark backups do not restore user-script execution credentials or execute previously installed code.

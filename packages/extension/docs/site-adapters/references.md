# Browser capabilities and implementation references

Checked on October 18, 2026. Browser capabilities come from official API documentation and Chromium schemas. External projects provide visible interfaces and source-code references; their existence does not establish platform authorization or verified current compatibility.

The repository baseline is `67ece2543094ae114b1d99abe793437e4d856d89`. The integration table in [README](README.md#integration-boundaries-in-the-current-code) describes code inspected at that baseline; proposed interfaces are not exported production APIs. Chrome is the supported runtime for this proposal. Other Chromium products and Firefox need separate capability/behavior tests. Links to moving branches are research pointers; implementation fixtures must record the inspected commit and browser/site version.

## Network and page capabilities

| Capability | Available scope | Design choice |
| --- | --- | --- |
| ISOLATED content script | Reads/writes page DOM while isolated from page JavaScript variables | Preferred for DOM adapters; isolation does not authenticate page data |
| MAIN script | Shares the page JavaScript environment and its exposure | Use only a minimal bundled probe when necessary |
| Dynamic scripting registration | Selects match patterns, execution time, and world for subsequent document loads | Register per enabled site; use executeScript for bundled code in already-open pages |
| Script unregistration | Prevents future injection without removing executed code | Revoke host capabilities first, then request cleanup |
| activeTab | Temporary access to the current page after user invocation | Use for one-time reads; persistent observation needs revocable site access |
| webNavigation | Document/frame information and history URL changes | Track documents and SPA routes, not business success |
| webRequest | Request lifecycle and limited metadata; response events do not expose arbitrary bodies | Do not use as a generic JSON-response listener |
| declarativeNetRequest | Declarative network rules | Does not extract favorite-operation data |
| Content-script fetch | Subject to page same-origin/CORS rules | Host grants do not automatically make cross-origin page reads available |
| Background fetch | Extension-origin reads to authorized hosts | Expose named, restricted reads rather than an arbitrary URL proxy |
| Background cookies | Authentication remains subject to cookie policies | Do not extract/copy sessions or equate a host grant with login |

Sources: [content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts), [scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting), [temporary access](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab), [webNavigation](https://developer.chrome.com/docs/extensions/reference/api/webNavigation), [webRequest](https://developer.chrome.com/docs/extensions/reference/api/webRequest), [declarativeNetRequest](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest), and [cross-origin requests and proxy boundaries](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests).

## User scripts

Chrome's userScripts API runs user-provided code through USER_SCRIPT worlds with optional dedicated messaging. Registration does not inject retroactively into an already-open document.

| Browser version | Supported design behavior |
| --- | --- |
| Chrome 121–132 | Bundled adapters; community runtime disabled because it needs named worlds |
| Chrome 133–134 | configureWorld/register with worldId; reload an open page to activate a community adapter |
| Chrome 135–137 | Additionally userScripts.execute for immediate attachment; Developer mode required |
| Chrome 138+ | Same execution APIs; the extension's Allow User Scripts toggle replaces Developer mode |

Immediate execution cannot observe earlier requests. Do not substitute scripting.executeScript for userScripts.execute or route community code into MAIN. Treat the version as onboarding guidance and verify API calls, grants, and toggles at activation.

Chrome 138 and later enable this through Allow User Scripts in extension details; earlier versions use Developer mode. Extension updates require restoring script registrations. Actual API success/failure determines availability rather than namespace presence alone. onUserScriptMessage identifies the user-script channel, not automatically the individual installed package.

Sources: [userScripts API](https://developer.chrome.com/docs/extensions/reference/api/userScripts) and [dedicated runtime messaging](https://developer.chrome.com/docs/extensions/reference/api/runtime#event-onUserScriptMessage).

Do not infer Chrome support for userScriptWorldId from another browser's documentation. The [Chrome MessageSender reference](https://developer.chrome.com/docs/extensions/reference/api/runtime#type-MessageSender) does not expose that property; compare the [Chromium runtime schema](https://github.com/chromium/chromium/blob/main/extensions/common/api/runtime.json) when implementing. Distinct worldIds and private bootstrap credentials associate installations; this does not authenticate the reported site facts. Validate isolation and host-to-script commands over onUserScriptConnect ports in Chromium.

MV3 policy allows external data but prohibits using a complex interpreter to turn downloaded configuration into executable remote logic. User Scripts API provides a documented route; other permission, user-data, and store requirements still apply. [MV3 policy](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)

## Messaging and storage

Use bounded JSON and separate adapter input from the host envelope. Browser-provided sender data identifies the document and origin; page-supplied strings cannot replace it. Treat DOM events crossing execution worlds as forgeable input without extension-level authority.

storage.local, sync, and managed are exposed to content scripts by default, while session is not. Access levels apply to an entire area. The project already pins credential session storage to TRUSTED_CONTEXTS; activation must establish the required access level for other private areas too. A content script's web IndexedDB/localStorage belongs to the page context, so keep the source database in the extension service worker and expose only a limited message interface.

Sources: [messaging security](https://developer.chrome.com/docs/extensions/develop/concepts/messaging), [Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage), and [storage contexts](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies).

Optional permission requests originate in a real user action. Site grants are origin-level, not endpoint-level; enforce path restrictions in host code. [Permissions API](https://developer.chrome.com/docs/extensions/reference/api/permissions)

The tabs permission protects sensitive tab properties; many tab operations do not require it, and matching host permission can grant access to a tab's URL/title. Do not add it merely to send a message to a known tab. [Tabs permissions](https://developer.chrome.com/docs/extensions/reference/api/tabs#permissions)

## Background lifecycle

An MV3 worker can terminate. Globals, page timers, and an open port do not guarantee durable task execution. The API documentation describes idle, long-operation, and fetch shutdown conditions and requires resilience to unexpected termination. Use durable observation acknowledgment, page checkpoints, stable commands, and native receipts rather than indefinite keepalive. [Official lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)

History changes and fragment changes have separate webNavigation events; BFCache restoration does not fire DOMContentLoaded again. A port sender's documentLifecycle describes the state when it connected, not a continuously updated authorization check. Revalidate current document state and renew the lease before resuming. [Navigation lifecycle](https://developer.chrome.com/docs/extensions/reference/api/webNavigation), [MessageSender](https://developer.chrome.com/docs/extensions/reference/api/runtime#type-MessageSender).

## Existing implementations

| Project | Verified behavior | Useful reference | Additional requirements here |
| --- | --- | --- | --- |
| Tributary | Provider selectors/hooks receive buttons and context; the core checks selected state and sends URL, title, and excerpt | Site providers, shared messages, lightweight feedback | Multiple collection memberships, durable deduplication, and copy policy |
| Bilibili Favlist Export | The inspected version reads video-card DOM, clicks collections/next-page controls, and generates folder HTML/CSV | DOM import, progress, stopping, and page-version handling | Stable collection identity, incremental relationships, and merging live observations |
| Zotero | target/detectWeb/doWeb separate detection and extraction into standard items | Lightweight detection, extraction interfaces, and site fixtures | Native favorite actions, collection membership, and browser bookmark writes |
| Bilibili Evolved | Feature metadata, URL conditions, entry/reload/unload lifecycle, and independent component distribution | Lifecycle, site adaptation, and component development | MV3 user-script permission boundaries; remote component loading cannot be copied directly |
| Readwise X import | Regular bookmark import and extension-driven historical backfill are separate and share destination settings | Incremental/backfill separation and user configuration | Internals are not public; do not infer request or listener implementation |

Source code and documentation:

- Tributary [provider types](https://github.com/dsuriano/tributary/blob/main/src/scripts/sites/types.ts), [content script](https://github.com/dsuriano/tributary/blob/main/src/scripts/content_script.ts), and [background](https://github.com/dsuriano/tributary/blob/main/src/scripts/background.ts).
- Bilibili Favlist Export [script](https://github.com/AHCorn/Bilibili-Favlist-Export/blob/main/Bilibili-Favlist-Export.user.js).
- Zotero [translator documentation](https://www.zotero.org/support/dev/translators) and [invocation and extraction](https://www.zotero.org/support/dev/translators/coding).
- Bilibili Evolved [component types](https://github.com/the1812/Bilibili-Evolved/blob/master/src/components/types.ts) and [component/plugin development](https://github.com/the1812/Bilibili-Evolved/blob/master/CONTRIBUTING.md).
- Bilibili Evolved [quick-favorite entry](https://github.com/the1812/Bilibili-Evolved/blob/master/registry/lib/components/video/quick-favorite/index.ts) and [collection identity and business-success checks](https://github.com/the1812/Bilibili-Evolved/blob/master/registry/lib/components/video/quick-favorite/QuickFavorite.vue).
- Readwise [X import documentation](https://docs.readwise.io/readwise/docs/importing-highlights/twitter).

## Release and privacy boundaries

Evaluate technical access, platform authorization, store policy, and applicable law separately. Site adapters do not bypass access controls, CAPTCHAs, bans, payment, or geographic restrictions, or promise continued access through IP changes or copied sessions. Favorite collections can reveal private interests and stay local by default. Cloud sync, public sharing, and model data transfer require separate explicit user settings.

Sources: [Chrome user-data requirements](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq) and [MV3 code requirements](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements). The preceding discussion covers platform terms. Reassess Bilibili access against the final implementation; an existing open-source script is not evidence of platform authorization.

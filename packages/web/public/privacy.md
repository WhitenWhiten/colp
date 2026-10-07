# Privacy on Know-N

This policy covers the Know-N website and Chromium browser extension. The extension saves and organizes browser bookmarks locally; Know-N accounts, cloud sync and AI suggestions are optional. This page explains which data stays in your browser and what is sent when you enable those services.

Last updated: September 30, 2026. For privacy questions or data requests, contact [help@know-n.com](mailto:help@know-n.com).

## Browser bookmarks and local storage

Manual saves, automatic save mode, bookmark management, local saving history and HTML import work without a Know-N account, login or cloud collection. Automatic mode handles a save action; it does not record every page you visit. The extension reads the title and URL of the page or link you choose to save, and of tabs you select for a batch save. It does not collect your full browsing history or scrape page bodies for classification.

After you grant bookmark access, the extension can read the browser bookmark tree to display, search, organize, detect duplicates and select folders. It writes titles, URLs, folders and their order into Chrome's native bookmark store. Chrome's own bookmark sync, if you enable it, is governed by your browser and Google settings; a bookmark described as local in Know-N can still be synced by Chrome itself.

The extension uses IndexedDB and Chrome extension storage on this browser profile for settings, selected folders, saving history, bookmark identifiers, sync mappings, pending commands, import previews and recovery progress. Session storage holds temporary context and authentication secrets. These stores are not public collections and are not sent to Know-N merely because you install the extension or save into an unsynced folder.

HTML files chosen in Bookmarks are parsed locally. Their folder names, titles and URLs are cached for preview and recovery, then written to browser bookmarks after confirmation. Importing into a folder you already selected for Know-N sync also makes those new bookmarks eligible for that sync. The separate import workflow under Sync sends the confirmed import to your connected Know-N collection.

## Optional accounts and cloud sync

When you create or sign into a Know-N account, we process your email address, account identifiers, profile fields you provide and authentication records to operate and secure that account. Password authentication uses a stored password hash. If you choose Google or GitHub sign-in, that provider handles authentication and supplies the account identity and profile information you authorize. Authentication email, including verification and recovery messages, is delivered through Alibaba Cloud DirectMail when enabled; it receives the recipient address and message content.

On the website, we also process library content you submit, such as descriptions, notes, tags and attachments, along with searches, reading progress, sharing choices, follows, comments and reports you choose to make. We use those records to provide the corresponding library and community features. Content you post publicly is visible to its public audience; private library content is not made public by creating an account.

The website uses a session cookie to keep you signed in. The extension uses that session for account features and keeps its authentication secrets in extension session storage, with persistent identity and connection metadata stored separately. Signing out revokes local authentication and stops account work on this browser; it is not a request to delete your library.

Cloud sync requires signing in, connecting a collection you own and selecting browser folders. Know-N then receives the authorized bookmark and folder content, identifiers, ordering, changes, descriptions and tags needed to synchronize your library. Sync also uses device, browser-profile, replica and command identifiers to reconcile changes safely. Cloud saving history can include the saved page's title and URL, folder path, collection and bookmark identifiers, timestamps, save source and operation status. Merely having an account or a connected collection does not authorize uploading bookmarks outside your selected sync range. Private-local folders, excluded bookmarks and records kept local are excluded from this reporting.

A new Know-N collection is private. Sync does not publish it. Sharing, publishing and read-only subscriptions use the audience and access rules you choose; recipients can view the content you make available to them. Copies another person has already saved cannot be recalled by changing your collection's visibility.

## Optional AI suggestions

AI classification is separate from saving. With AI disabled, saving does not require a model or an AI provider account. When you enable suggestions, classification processes the bookmark title and URL, available descriptions, candidate folder names and paths, and relevant collection context or tag vocabulary to suggest a destination and tags.

The extension's own-key mode sends that classification input directly to the endpoint you configure. Candidate folder context can include browser folders outside the Know-N sync range. Supported presets are TypeSafe, Cloudflare AI Gateway and Vercel AI Gateway; a gateway can pass the input to its upstream model provider, including TypeSafe. A custom endpoint receives the same necessary input. This mode works without a Know-N account but can involve an external service: "local" describes where configuration and orchestration live, not a promise that an AI model runs on your device. Enabling local AI together with automatic saves allows provider requests for those save actions. The connection test sends a fixed synthetic test instead of your bookmarks.

Your provider API key or gateway token and endpoint configuration are saved in this profile's Chrome extension local storage. The key is sent only to the configured provider endpoint for authentication, never to Know-N's account or sync APIs or Chrome extension sync storage. It survives browser restarts, Know-N sign-out and account switches. Disabling own-key mode releases its host access and stops its use, but retains the saved key. Browser storage is not a separately encrypted password vault. To remove the extension's saved key and data, remove the extension; revoke a token at the provider if you want to invalidate it there too.

Know-N server classification requires a separate request or automatic-classification authorization. It sends the necessary classification input through the service's Cloudflare AI Gateway to the configured model provider, currently supporting TypeSafe. Know-N can retain the classification decision, execution and billing records and feedback needed to show results, resolve retries and manage authorized usage. Classification memory uses eligible corrections and feedback to improve your folder suggestions; you can disable learning and clear that memory in Preferences. Clearing memory does not delete bookmarks, saving history or billing receipts. Know-N does not use extension bookmark data to train general-purpose AI models. A provider's own retention and training practices are governed by its terms; review them before sending sensitive bookmarks. Custom HTTP endpoints are allowed only on local or private-network addresses and do not provide HTTPS transport protection.

## Icons and other recipients

For synced bookmarks, icon capture may request an icon from the saved site's own origin without cookies and upload the icon to Know-N. The shared icon service, when enabled, sends an eligible public hostname to Favicone to retrieve an icon. It does not send the complete bookmark URL to that icon service. Icon objects may be stored through Cloudflare R2. Local HTML import does not fetch external icons.

Know-N's hosting, database and storage services process the data necessary to run the website, library and synchronization. Requests to Know-N and external endpoints expose normal connection information such as the IP address to the receiving service. Know-N uses request metadata, status codes, error records and operational metrics to secure and troubleshoot the service; authentication secrets are redacted from application logs. Support email contains the address and information you choose to send. We do not add advertising trackers to the extension.

## Retention, removal and your controls

Browser bookmarks remain until you delete them through the browser or bookmark manager. Completed local saving records become eligible for cleanup after 90 days; unresolved saves, pending feedback and recovery work can remain longer. An HTML preview is valid for 24 hours and is replaced by a new preview or consumed on import. Expiry does not itself erase a cached preview. Completed or cancelled local imports release their per-item journal and keep a small command receipt so a replay does not import duplicates.

Server saving history removes the title, URL and local folder path from eligible completed records after 180 days, then removes the remaining per-capture facts after 365 days. Records with unresolved work or pending decisions can remain longer. These history limits do not delete the saved bookmarks or other library content. Library data remains until you remove it; deletion can enter Trash or retain recovery and command records rather than immediately erasing every copy.

You can disable AI, revoke optional bookmark, tab or provider-host permissions in Chrome, change the selected sync folders, or sign out to stop the related future activity. Those actions do not erase data already stored locally, in Know-N or at a provider. Signing out preserves native bookmarks, the independent local import journal, retained saving history and your own provider key. Retained account history stays associated with its account rather than becoming another account's history.

Removing the extension removes its extension storage from that browser profile. It does not delete native Chrome bookmarks, server collections, a provider's records or a provider token. Clear or export browser bookmarks through Chrome's bookmark manager as needed. In website Settings you can delete your account after confirming your identity. Account deletion disables the account and removes sign-in credentials; it does not automatically purge all collection content, command receipts, audit records or backups. For access, correction or erasure requests beyond the available controls, email [help@know-n.com](mailto:help@know-n.com). Do not include passwords, API keys or session cookies.

## Limited Use

Know-N complies with the Chrome Web Store User Data Policy and its Limited Use requirements for information obtained through Chrome and Google APIs. We use extension data only to provide and improve the disclosed bookmark saving, organization, import, optional AI and sync features, and to operate them securely. We do not sell it, use it for personalized advertising or credit decisions, or transfer it to advertising platforms, data brokers or information resellers.

Transfers are limited to the services and audiences needed for those features, legal obligations or security and abuse prevention. A transfer in a business acquisition requires your prior explicit consent. Human access to extension user data is limited to your consent to inspect specific data, necessary security investigations, legal obligations, or aggregated anonymized internal operations. These restrictions also cover derived data. See the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/policies#protecting_user_privacy).

## Policy updates

Changes will be published on this page with an updated date. A new extension data use requiring additional consent will be disclosed in the product before it is enabled. Contact [help@know-n.com](mailto:help@know-n.com) with questions about this policy or the controls described here.

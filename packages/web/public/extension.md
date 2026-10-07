# Know-N browser extension

Use the Know-N browser extension to capture the active page and sync selected bookmark folders into collections you own. The current artifact targets Chromium Manifest V3, declares Chrome 121 as its minimum version, and is exercised by the repository's Chromium release evidence. Know-N does not currently publish separate Edge, Firefox, or Safari builds, and this page does not claim availability in any browser extension store.

## What the extension does

The toolbar popup saves the page you are viewing to a collection that you own. You choose the destination collection and can add the page without giving the website general access to your browser. The extension requests access to the active tab for the capture action, while bookmark access is optional and is requested only when you choose a bookmark workflow.

The options page lets you sign in, select bookmark folder boundaries, and import or synchronize those selected folders. Folder, bookmark, and separator changes inside an allowed boundary are recorded locally and queued in durable order before they are sent to Know-N. The extension syncs collections you own; it does not treat collections shared with you as writable replicas. It also does not automatically resolve sync conflicts.

## Browser support

- **Chrome:** the manifest declares Chrome 121 as the minimum version; automated release evidence runs the production artifact in Chromium.
- **Edge:** no separate Edge package or Edge-specific compatibility evidence is currently published. Chromium-based Edge users may evaluate the Chromium artifact under their own browser or organization policy.
- **Firefox:** no Firefox release artifact is currently published.
- **Safari:** no Safari release artifact is currently published.

## Install and connect

1. [Create a Know-N account](/register), or use an account you already control.
2. Obtain a trusted Know-N Chromium release artifact. There is no public store-install promise on this page. If you are evaluating a development build, follow your browser or organization policy for loading an unpacked extension.
3. Open the extension options page and sign in to Know-N. Authentication stays behind the extension's closed message boundary; raw credentials are not passed through popup messages.
4. Open the toolbar popup on a page you want to keep, choose a collection you own, and save the active page.
5. If you want bookmark synchronization, grant the optional bookmark permission and select only the folders that should be in scope. You can later remove that permission or change the selected boundaries.

## Control and recovery

Bookmark access can be revoked without silently expanding the previous boundary when it is granted again. Pending changes remain ordered through temporary disconnects, and server receipts determine whether an operation is complete, deferred, or needs recovery. These safeguards reduce accidental duplication, but they do not replace a user's decision when a real conflict needs resolution.

For the public protocol and machine-readable integration surfaces used by Know-N clients, see [Developers on Know-N](/developers). The extension is one client of those authenticated services; installing it does not publish a collection or change its visibility by itself.

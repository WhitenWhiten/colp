# Browser-local HTML import

Bookmarks → Import an HTML bookmark file works without a Know-N account, collection,
sync session or network. It previews the existing Netscape HTML conversion, then
imports folders, titles and URLs into a new folder under a personal native destination.
Duplicate occurrences and source order are preserved. Separators and unsupported
metadata are skipped; icons are never fetched. Existing selected sync boundaries
continue to govern whether Chrome's resulting bookmark events are uploaded.

The separate `known-local-import` IndexedDB journal belongs to the browser profile.
The reviewed command, every native dependency and a submitted marker are durable
before Chrome create; each native receipt advances progress atomically. Worker
startup and the recovery alarm resume the confirmed prefix. A lost native receipt
requires the user to confirm an existing item with matching parent, title and URL;
it never authorizes an automatic duplicate create. The user can stop an unfinished
import while retaining created bookmarks, including after bookmark permission is
revoked. Completed commands keep a small replay receipt and release item records.

Only the extension's options page can issue this protocol. Personal destination
guards reject managed and read-only subscription folders before creating items.
The separate Sync → Import workflow imports into a connected Know-N collection.

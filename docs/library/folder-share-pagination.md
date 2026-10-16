# Folder share pagination

Folder links expose a live, privacy-filtered subtree. They do not promise a frozen
snapshot across requests. Each page runs in its own repeatable-read transaction,
checks the live share and its ancestors, and filters every candidate against the
current subtree and privacy policy. Revocation or a restricted share target ends
access immediately. A node moved out or made private between pages is omitted.

The shared folder appears first. Descendants follow in immutable node-id order;
public relations follow in immutable relation-id order, with both endpoints
required to be visible inside the share. Node `parentId` and `position` preserve
the display tree and sibling order independently of transport order.

Signed cursors bind slug, page size, relation mode, phase, last id, sequence and a
fixed 15-minute expiry. Writes elsewhere in the library do not invalidate them.
New or newly included ids after the cursor can appear on later pages. Ids before
the cursor, and updates to already returned entities, appear on refresh. Clients
should refresh to obtain a current complete tree during continuous editing.

Database reads use indexed keyset scans and `limit + 1` lookahead, rather than
loading the subtree and slicing it. Membership checks walk candidate ancestors,
with the same 256-level privacy boundary as other public reads. Annotation reads
are limited to the page's node ids and return at most one mark of each type per
node. Relations share the page's entity budget. Invalid signed cursors are
rejected before any folder-share database read.

The PostgreSQL regression traverses 1,202 entities with 37-entity pages, observes
database result sizes, and performs a real Product write outside the share after
every page. The isolation regression includes sibling secrets, private/protected
branches, owner-only marks, cross-subtree relations, and all three viewer contexts
(anonymous, owner and another signed-in account).

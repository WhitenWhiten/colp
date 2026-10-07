/**
 * R15-25: `rel` for links to user-submitted URLs (bookmarks, digest entries).
 * Search engines must not read a curator's link as an editorial endorsement;
 * the no-JS shell already says `nofollow ugc`, and the hydrated DOM must agree.
 */
export const UGC_REL = 'nofollow ugc noopener noreferrer'

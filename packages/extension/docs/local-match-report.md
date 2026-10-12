# Local match-report schema (extension-private)

This report is **local only**. It is not a Wire Operation, not a Pull effect, and not a
`09-problem-registry.md` problem code. UI may show candidates; Sync never auto-merges two
bookmarks that share a URL under different parents.

## Exact raw URL vs advisory normalization

Extension sync identity is mapping / sidecar / `sourceRef`. Unmapped bootstrap pairing
and `duplicate_candidate` grouping compare the **stored URL string exactly** (and, for
pairing, parent + title). They do not use `urlHash`, title-only equality, or backend
`normalizeBookmarkUrl`.

Backend `normalizeBookmarkUrl` (link-health / readable-replica / LibraryHealth) may
lowercase the host, strip a fragment, strip default ports `:80`/`:443`, and strip a
trailing slash when the path is longer than one character. That rewrite is **advisory**
for health checks and duplicate *hints*. It does not rewrite the stored Node URL, does
not change Extension mapping identity, and does not auto-merge. Tracking parameters and
query-key order are not collapsed by that normalizer either; they remain distinct Nodes
on both layers.

A candidate is never a merge plan. Same URL under a different parent, another mount, or
another Collection stays two Nodes until a user records a private `duplicate_of`
relation (P2-03). Cross-mount groups are keyed as `mountId|rawUrl`; a Collection
snapshot is matched in isolation.

<a id="local-match-report"></a>

## Envelope

```json
{
  "kind": "local-match-report",
  "scopeKey": "scope-1",
  "reportDigest": "sha256:…",
  "candidates": [
    {
      "kind": "duplicate_candidate",
      "url": "https://example.com/dup",
      "nodeIds": ["bookmark-a", "bookmark-b"],
      "parents": ["folder-a", "folder-b"]
    }
  ]
}
```

## Candidate kinds

| `kind` | Meaning |
| --- | --- |
| `duplicate_candidate` | Same URL, different parent or identity; keep both or let the user choose |
| `title_near_duplicate` | Advisory only; never an auto-merge Operation |

`nativeId` belongs in mapping/sidecar records, not in this public-facing candidate identity list.

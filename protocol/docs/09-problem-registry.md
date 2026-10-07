# 09. Problem Code Registry

> **In short:** The registry of error codes. Every error is an RFC 9457 Problem Details document with a stable `code`. The table lists each code's HTTP status, what it means, and how a client should recover, and the last section lists the machine-readable recovery fields. Clients act on `status` and `code`, never on the human-readable text.
>
> **Read this if** you return errors or handle them. **Profiles:** all.

<a id="colp-section-1"></a>

## 1. General Format

Error responses use RFC 9457 `application/problem+json` and include a stable ASCII `code`. Clients act on `status`, `code`, and the machine-readable recovery fields; they must not parse the `title` or `detail` text.

```json
{
  "type": "https://collectionprotocol.org/problems/precondition-failed",
  "title": "Precondition failed",
  "status": 412,
  "code": "precondition_failed",
  "detail": "The resource changed after the supplied ETag.",
  "instance": "/collections/c/collection-1",
  "currentRevision": "r_18",
  "currentEtag": "collection-r_18",
  "retryable": true
}
```

`detail` must not echo secrets, complete signed URLs, private notes, internal principals, or other unauthorized data.

<a id="colp-section-2"></a>

## 2. Core Registry

| HTTP | `code` | Meaning | Client recovery |
|---|---|---|---|
| 400 | `invalid_json` | JSON syntax, duplicate members, number range, or unsafe keys do not conform to I-JSON | Fix the document; do not retry automatically |
| 400 | `invalid_query` | The query contains unknown parameters, repeated scalars, empty values, or invalid encoding | Rebuild the request from the endpoint's query `$defs` |
| 400 | `invalid_cursor_scope` | The cursor is used with the wrong principal, endpoint, Collection, filter, or version | Discard the cursor and restart from the corresponding resource |
| 401 | `authentication_required` | The credential is missing, expired, or invalid | Re-authenticate according to `WWW-Authenticate` |
| 406 | `unsupported_version` | The header / Accept version of a read request is not supported | Renegotiate from `supportedVersions` |
| 415 | `unsupported_media_type` | The write media type or its version is not supported | Use the request media type declared by the Manifest |
| 422 | `unsupported_operation` | The operation is valid but the current host has not implemented it | Do not retry; wait for capability negotiation or a host upgrade |
| 403 | `insufficient_scope` | The principal is valid but its scope / object authorization is insufficient | Do not retry; an explicit authorization upgrade may be started |
| 403 | `node_read_only` | A read-only constraint of the Node itself or of an authoritative ancestor rejects this write | Do not retry automatically; wait for the constraint or managed policy to change |
| 403 | `origin_not_allowed` | The MCP / browser origin is not in the allowlist | Stop the requests and check the deployment's origin configuration |
| 403 | `csrf_failed` | A cookie-authenticated write request lacks a valid CSRF proof | Reload a trusted page and obtain a new CSRF token |
| 404 | `resource_not_found` | The resource does not exist, or the concealment policy hides its existence | Do not guess IDs; rediscover from the parent resource |
| 405 | `method_not_allowed` | The endpoint does not support the method | Use `Allow` and the endpoint contract registry |
| 409 | `revision_conflict` | The HTTP precondition was satisfied, but a domain conflict occurred | Read the conflict / current resource and let the user choose |
| 409 | `position_context_stale` | The after / before adjacency has changed | Re-read the parent's children and retry |
| 409 | `snapshot_expired` | The revision pinned during pagination is no longer available | Fetch the Snapshot again from the first page |
| 409 | `idempotency_key_reused` | The same key was sent with a different request digest | Generate a new key; the original request must not be executed |
| 409 | `idempotency_in_progress` | The first request with the same key is still executing | Retry the same request after `Retry-After` |
| 409 | `sequence_gap` | The replica sequence skipped a number | Fill in from `expectedSequence`, or bootstrap |
| 409 | `sequence_blocked` | The expected sequence has a deferred receipt | First unblock and retry the blocked expected sequence |
| 409 | `sequence_reuse` | The same sequence was sent with a different operation | Stop syncing and inspect the local state manually |
| 409 | `op_id_reused` | The same op ID was sent with a different operation | Stop syncing and inspect the local idempotency state |
| 409 | `dependency_failed` | An operation this one depends on in the batch did not succeed | Fix or resubmit the dependency, then retry |
| 409 | `folder_not_empty` | A non-empty folder was deleted without explicit recursion | Let the user cancel the non-recursive delete or confirm the subtree deletion |
| 410 | `feed_cursor_expired` | The Feed history has been compacted | Follow the Snapshot link and rebuild the public state |
| 410 | `sync_cursor_expired` | The Sync log has been compacted | Download the authoritative Sync Snapshot and bootstrap |
| 410 | `stale_replica` | The replica exceeded its lease / tombstone window | Discard the old baseline and complete an authoritative bootstrap before pushing |
| 410 | `replica_retired` | The replica was explicitly retired | Create a new replica; the old queue must not be reused |
| 410 | `resource_purged` | The tombstone and prior representation have been purged | Not recoverable; creating a new object requires a new ID |
| 412 | `precondition_failed` | `If-Match` does not hold | Read the current ETag / revision, then redo the user's operation |
| 413 | `payload_too_large` | The body, batch, depth, or attachment exceeds a limit | Shrink the request; do not split it to bypass the total cost limit |
| 422 | `invalid_document` | JSON shape, format, or semantic graph validation failed | Fix the document; use `errors[]` to locate the JSON Pointer |
| 428 | `precondition_required` | A required `If-Match` is missing | Read the resource and retry with its ETag |
| 429 | `rate_limited` | A bucket / cost budget is exhausted | Honor `Retry-After`; do not split requests to bypass it |
| 500 | `internal_error` | Unclassified server failure | Retry retryable operations cautiously with the same idempotency key |
| 503 | `service_unavailable` | Temporary maintenance, or a dependency or capacity is unavailable | Honor `Retry-After` and back off exponentially |

Internal Node guard denials map to HTTP problems as follows:

- A candidate parent that is not a root/folder, an ordinary Node producing `parentId=null`, a broken root invariant, or a candidate graph that forms a cycle uses `422 invalid_document`, with a stable path/keyword in `errors[]`.
- Parent ancestry, subtree, resolution depth, or member budget exceeding the deployment's hard limit uses `413 payload_too_large`.
- A request that targets a resource that does not exist or is hidden by the concealment policy uses `404 resource_not_found`.
- Ancestry in authoritative storage that cannot be resolved, corrupted constraints, or a transaction that cannot establish a consistent snapshot uses `500 internal_error`, or `503 service_unavailable` for a recoverable dependency failure. Helper denials such as `node_ancestry_unresolved` and `invalid_node_constraints` are not core problem codes and cannot be put on the wire directly.

<a id="colp-section-3"></a>

## 3. Recovery Fields

Errors provide, as needed:

- `currentRevision`
- `currentEtag`
- `expectedSequence`
- `supportedVersions`
- `retryAfterSeconds`
- `snapshotUrl`
- `conflictId`
- `errors[]`, each item containing `path`, `keyword`, and `message`
- `links`, for example `current`, `snapshot`, `authorization`

Extension error codes use an HTTPS namespace URI and must not occupy an unregistered short ASCII core code.

---

[← 08 Write API](08-write-api.md) · [All documents](../README.md#documents) · [Glossary](../GLOSSARY.md) · [10 Implementation contract →](10-implementation-contract.md)

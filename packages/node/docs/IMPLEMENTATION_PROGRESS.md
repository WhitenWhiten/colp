# Implementation Progress

| Requirement | Status | Evidence tests | Acceptance attempts | Commit subject | Protocol Correction |
|---|---|---:|---:|---|---|
| `CORE-0001` | Accepted | 6 | 2 | `feat(colp): satisfy CORE-0001 two-stage wire validation` | No |
| `CORE-0002` | Accepted | 37 | 2 | `feat(colp): satisfy CORE-0002 wire format assertions` | No |
| `CORE-0003` | Accepted | 8 | 2 | `fix(colp): satisfy CORE-0003 complete snapshot root invariant` | No |
| `CORE-0004` | Accepted | 19 | 3 | `fix(colp): satisfy CORE-0004 global snapshot identity invariant` | No |
| `CORE-0005` | Accepted | 15 | 2 | `feat(colp): satisfy CORE-0005 snapshot graph invariants` | No |
| `CORE-0006` | Accepted | 29 | 2 | `feat(colp): satisfy CORE-0006 sibling position contract` | No |
| `CORE-0007` | Accepted | 23 | 4 | `fix(colp): satisfy CORE-0007 collection-scoped references` | No |
| `CORE-0008` | Accepted | 30 | 2 | `fix(colp): satisfy CORE-0008 strict extension namespaces` | No |
| `CORE-0009` | Accepted | 44 | 3 | `fix(colp): satisfy CORE-0009 executable bookmark URL safety` | No |
| `CORE-0010` | Accepted | 45 | 2 | `fix(protocol): satisfy CORE-0010 and correct snapshot metadata contract` | Yes |
| `CORE-0011` | Accepted | 36 | 1 | `fix(protocol): satisfy CORE-0011 and correct HTTPS namespace authority` | Yes |
| `CORE-0012` | Accepted | 14 | 1 | `feat(colp): satisfy CORE-0012 unknown extension preservation` | No |
| `CORE-0013` | Accepted | 11 | 1 | `feat(colp): satisfy CORE-0013 exact-version extensibility` | No |
| `CORE-0014` | Accepted | 16 | 1 | `feat(colp): satisfy CORE-0014 UUIDv7 object IDs` | No |
| `CORE-0015` | Accepted | 67 | 1 | `feat(colp): satisfy CORE-0015 wire ID syntax` | No |
| `CORE-0016` | Accepted | 31 | 1 | `feat(colp): satisfy CORE-0016 durable server ID reservations` | No |
| `CORE-0017` | Accepted | 53 | 1 | `fix(protocol): satisfy CORE-0017 and correct canonical URI grammar` | Yes |
| `CORE-0018` | Accepted | 38 | 1 | `feat(colp): satisfy CORE-0018 canonical UTC writes` | No |
| `CORE-0019` | Accepted | 49 | 1 | `feat(colp): satisfy CORE-0019 optional canonical URL storage` | No |
| `CORE-0020` | Accepted | 39 | 1 | `fix(protocol): satisfy CORE-0020 and correct URL hash semantics` | Yes |
| `CORE-0021` | Accepted | 35 | 1 | `feat(colp): satisfy CORE-0021 exact sensitive URL preservation` | No |
| `CORE-0022` | Accepted | 178 | 1 | `feat(colp): satisfy CORE-0022 profile conformance claims` | No |
| `CORE-0023` | Accepted | 159 | 1 | `feat(colp): prohibit unverified Profile claims` | No |
| `CORE-0024` | Accepted | 22 | 1 | `feat(colp): satisfy CORE-0024 asserted format then semantics` | No |
| `CORE-0025` | Accepted | 86 | 1 | `feat(colp): satisfy CORE-0025 opaque position ordering` | No |
| `CORE-0026` | Accepted | 45 | 2 | `feat(colp): satisfy CORE-0026 client sibling anchors` | No |
| `CORE-0027` | Accepted | 35 | 1 | `fix(protocol): satisfy CORE-0027 and correct snapshot index schema` | Yes |
| `CORE-0028` | Accepted | 66 | 1 | `feat(colp): satisfy CORE-0028 managed bookmarks read-only default` | No |
| `CORE-0029` | Accepted | 50 | 1 | `fix(protocol): satisfy CORE-0029 and correct profile ID derivation` | Yes |
| `CORE-0030` | Accepted | 76 | 1 | `feat(colp): satisfy CORE-0030 AI content provenance` | No |
| `CORE-0031` | Accepted | 832 | 1 | `test(colp): satisfy CORE-0031 strict unknown top-level fields` | No |
| `CORE-0032` | Accepted | 102 | 1 | `feat(colp): satisfy CORE-0032 forward data in extensions` | No |
| `CORE-0033` | Accepted | 37 | 1 | `feat(colp): satisfy CORE-0033 Sync extension roundtrip` | No |
| `CORE-0034` | Accepted | 21 | 1 | `feat(colp): satisfy CORE-0034 adapter loss warnings` | No |
| `CORE-0035` | Accepted | 35 | 1 | `feat(colp): satisfy CORE-0035 pre-write two-stage validation` | No |
| `CORE-0036` | Accepted | 52 | 1 | `feat(colp): satisfy CORE-0036 server parent cycle prevention` | No |
| `PUBLISH-0006` | Accepted | 5 | 1 | `feat(colp): enforce publisher If-Match preconditions` | No |
| `CORE-0037` | Accepted | 51 | 1 | `feat(colp): satisfy CORE-0037 profile delivery order` | No |
| `CORE-0038` | Accepted | 15 | 1 | `feat(colp): satisfy CORE-0038 URL hash wire envelope` | No |
| `CORE-0039` | Accepted | 26 | 1 | `feat(colp): satisfy CORE-0039 canonical padded Base64` | No |
| `CORE-0040` | Accepted | 37 | 1 | `feat(colp): satisfy CORE-0040 exact UTF-8 URL hash input` | No |
| `CORE-0041` | Accepted | 31 | 1 | `feat(colp): satisfy CORE-0041 preserved URL hash matching` | No |
| `CORE-0042` | Accepted | 15 | 1 | `feat(colp): satisfy CORE-0042 URL hash candidate prefilter` | No |
| `CORE-0043` | Accepted | 10 | 1 | `feat(colp): satisfy CORE-0043 URL hash is not object identity` | No |
| `CORE-0044` | Accepted | 28 | 1 | `feat(colp): satisfy CORE-0044 URL hash never becomes object ID` | No |
| `CORE-0045` | Accepted | 39 | 1 | `feat(colp): satisfy CORE-0045 persisted random profile IDs` | No |
| `CORE-0046` | Accepted | 53 | 1 | `feat(colp): satisfy CORE-0046 deterministic HMAC framing` | No |
| `CORE-0047` | Accepted | 57 | 1 | `feat(colp): satisfy CORE-0047 keep HMAC keys server-only` | No |

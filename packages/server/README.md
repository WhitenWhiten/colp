COLP Server (`@know-n/colp-server`) is the self-hosted bookmark server in this package. Install and run it by following [deploy/INSTALL.md](../../deploy/INSTALL.md).


Initial browser synchronization supports non-atomic Push batches of up to 50 operations.
`SYNC_MAX_BATCH_OPERATIONS` defaults to `50` (range `1..50`); set it to `1` to disable batching.
The Manifest advertises the configured limit and Sessions negotiate it with the client.
Apply migrations before starting the updated server; `sync_push_request_bindings` retains
whole-request idempotency while each operation keeps its own transaction and Sequence receipt.

For multi-operation requests, individual receipt bindings use each `opId` as the
operation's idempotency key. The outer `Idempotency-Key` binds the complete ordered
array. If a non-atomic batch fails midway, earlier commits remain durable and the
client can recover them by sending singleton requests with the original operation
bytes and `Idempotency-Key: <opId>`. Multi-operation atomic batches are rejected.

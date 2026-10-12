import assert from 'node:assert/strict';
import { it } from 'vitest';
import { createMetadataSyncPolicyStore, metadataPolicyKey } from '../src/metadata-sync-policy.js';

const scope = { serverOrigin: 'https://known.example', accountId: 'a', collectionId: 'c' };
function fixture() {
  const data: Record<string, unknown> = {};
  const storage = { async get(key: string) { return { [key]: data[key] }; },
    async set(values: Record<string, unknown>) { Object.assign(data, values); } };
  return { data, storage, policy: createMetadataSyncPolicyStore(storage) };
}

it('denies dispatch when opt-out arrives after the storage read but before send', async () => {
  const { policy, storage, data } = fixture();
  await policy.write(scope, true);
  let release!: (values: Record<string, unknown>) => void;
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  storage.get = () => { began(); return new Promise(resolve => { release = resolve; }); };
  let sent = false;
  const dispatch = policy.dispatch(scope, async () => { sent = true; });
  await started;
  release({ [metadataPolicyKey(scope)]: data[metadataPolicyKey(scope)] });
  const disabled = new Promise<void>((resolve, reject) => {
    queueMicrotask(() => { void policy.write(scope, false).then(resolve, reject); });
  });
  await assert.rejects(dispatch, /metadata_sync_disabled/u);
  await disabled;
  assert.equal(sent, false);
});

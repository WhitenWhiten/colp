import { createSyncConfirmations, type PersonalSyncCommand, type ConfirmationBasis } from './personal-sync-commands.js';
import { personalSyncKey, type PersonalSyncIdentity, type createPersonalSyncPolicyStore } from './personal-sync-policy.js';

export interface LifecycleFacts { readonly digest: string; readonly queued: number; readonly attached: boolean }
export interface PersonalSyncLifecyclePorts {
  readonly policy: ReturnType<typeof createPersonalSyncPolicyStore>;
  identity(): Promise<PersonalSyncIdentity & { collectionId: string }>;
  generation(): Promise<number>;
  assertCurrent(generation: number): Promise<void>;
  facts(): Promise<LifecycleFacts>;
  available(identity: PersonalSyncIdentity & { collectionId: string }): Promise<'available' | 'unavailable' | 'unknown'>;
  disconnect(identity: PersonalSyncIdentity & { collectionId: string }, generation: number): Promise<void>;
  /** Invoke publish inside the adapter's local mutation lane, never around HTTP or lane acquisition. */
  reconnect(identity: PersonalSyncIdentity & { collectionId: string }, generation: number,
    publish: (effect: () => Promise<void>) => Promise<void>): Promise<void>;
  wake(): void;
}
export function createPersonalSyncLifecycle(ports: PersonalSyncLifecyclePorts) {
  const confirmations = createSyncConfirmations();
  async function snapshot() {
    const generation = await ports.generation(), identity = await ports.identity();
    const policy = await ports.policy.read(identity), facts = await ports.facts();
    await ports.assertCurrent(generation);
    const basis: ConfirmationBasis = { accountKey: personalSyncKey(identity), generation,
      revision: policy.revision, collectionId: identity.collectionId, digest: facts.digest };
    return { identity, policy, facts, basis };
  }
  return Object.freeze({ async handle(command: PersonalSyncCommand) {
    if (command.kind === 'known.personalSync.status') {
      const generation = await ports.generation(), identity = await ports.identity();
      const policy = await ports.policy.read(identity);
      await ports.assertCurrent(generation);
      return { ok: true as const, policy, collectionId: identity.collectionId };
    }
    if (command.kind === 'known.personalSync.change' && command.action === 'pause') {
      const generation = await ports.generation(), identity = await ports.identity();
      await ports.policy.write(identity, 'paused', 'user', command.revision);
      await ports.assertCurrent(generation);
      return { ok: true as const };
    }
    const { identity, policy, facts, basis } = await snapshot();
    if (command.kind === 'known.personalSync.preview') {
      return { ok: true as const, token: confirmations.issue(command.action, basis), revision: policy.revision,
        queued: facts.queued, collectionId: identity.collectionId };
    }
    if (command.revision !== policy.revision) throw new Error('personal_sync_preview_stale');
    if (command.action === 'pause') throw new Error('request_invalid');
    confirmations.consume(command.token!, command.action, basis);
    if (command.action === 'resume' && policy.mode === 'disconnected' && facts.attached) {
      throw new Error('personal_sync_disconnect_incomplete');
    }
    // Close admission before waiting for old work to settle. Failures stay off.
    const stopped = await ports.policy.write(identity, command.action === 'disconnect' ? 'disconnected' : 'paused', 'user', policy.revision);
    await ports.assertCurrent(basis.generation);
    if (command.action === 'disconnect') {
      await ports.disconnect(identity, basis.generation);
      await ports.assertCurrent(basis.generation);
      return { ok: true as const };
    }
    const available = await ports.available(identity);
    await ports.assertCurrent(basis.generation);
    if (available !== 'available') {
      if (available === 'unavailable') await ports.policy.write(identity, 'target-unavailable', 'target-unavailable', stopped.revision);
      throw new Error(available === 'unavailable' ? 'personal_sync_target_unavailable' : 'personal_sync_target_unverified');
    }
    await ports.policy.withRevision(identity, stopped.revision, async () => { await ports.assertCurrent(basis.generation); });
    await ports.reconnect(identity, basis.generation,
      effect => ports.policy.withRevision(identity, stopped.revision, effect));
    await ports.assertCurrent(basis.generation);
    await ports.policy.write(identity, 'enabled', 'user', stopped.revision);
    await ports.assertCurrent(basis.generation);
    ports.wake();
    return { ok: true as const };
  } });
}

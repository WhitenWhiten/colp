import { expect, test, vi } from 'vitest';
import { inspectionBindingReads, resolveBindings, type BindingReadPort } from '../../../src/modules/automation/index.js';
import type { RuleDefinition } from '@know-n/colp/automation';
import definition from '../../../../node/tests/fixtures/automation/m1-placement.json' with { type: 'json' };

test('an inspection shares folder reads without sharing authority across identities, servers or later passes', async () => {
  let revision = '1';
  const readFolder = vi.fn<BindingReadPort['readFolder']>(async (actor, folder) => actor.accountId === 'owner' && folder.serverUuid === 'server'
    ? { status: 'valid', snapshot: { folder, title: 'Folder', revision, policyRevision: '1', ancestors: [] } }
    : { status: 'blocked', code: 'permissionRevoked', message: 'Denied' });
  const reads: BindingReadPort = { readFolder, readCollection: async () => null };
  const owner = { accountId: 'owner', subjectId: 'subject' }, folder = { serverUuid: 'server', collectionId: 'c', nodeId: 'n' };
  const pass = inspectionBindingReads(reads);
  await pass.readFolder(owner, folder); await pass.readFolder(owner, { ...folder });
  expect(readFolder).toHaveBeenCalledTimes(1);
  expect((await pass.readFolder({ ...owner, accountId: 'foreign' }, folder)).status).toBe('blocked');
  expect((await pass.readFolder(owner, { ...folder, serverUuid: 'other' })).status).toBe('blocked');
  await pass.readFolder({ ...owner, subjectId: 'other-subject' }, folder);
  expect(readFolder).toHaveBeenCalledTimes(4);
  revision = '2';
  expect(await inspectionBindingReads(reads).readFolder(owner, folder)).toMatchObject({ snapshot: { revision: '2' } });
});

test('rules sharing a folder still apply their own ancestor constraints', async () => {
  const folder = { serverUuid: 'server', collectionId: 'c', nodeId: 'n' };
  const reads = inspectionBindingReads({ readCollection: async () => null, readFolder: async (_actor, ref) => ({
    status: 'valid', snapshot: { folder: ref, title: ref.nodeId, revision: '1', policyRevision: '1', ancestors: [] },
  }) });
  const rule = { ...definition, scope: { collectionId: 'c' } } as RuleDefinition;
  const binding = { kind: 'folder' as const, folder, followIdentity: true as const, onUnavailable: 'block' as const, notifyOn: [] };
  const actor = { accountId: 'owner', subjectId: 'subject' };
  expect((await resolveBindings(reads, actor, rule, { academicRoot: binding })).academicRoot?.status).toBe('valid');
  expect((await resolveBindings(reads, actor, rule, { academicRoot: { ...binding, allowedAncestor: { ...folder, nodeId: 'unrelated' } } })).academicRoot?.status).toBe('blocked');
});

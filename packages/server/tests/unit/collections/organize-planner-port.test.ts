import assert from 'node:assert/strict';
import { test } from 'vitest';
import type {
  OrganizePlanner,
  OrganizePlannerInput,
  OrganizePlannerOutput,
} from '../../../src/modules/collections/application/organize-planner.js';

test('OrganizePlanner.plan returns Promise<OrganizePlannerOutput>', async () => {
  const planner: OrganizePlanner = {
    id: 'heuristic.v1.port_shape',
    plan(_input: OrganizePlannerInput): Promise<OrganizePlannerOutput> {
      return Promise.resolve({
        plannerId: this.id,
        truncated: false,
        actions: [],
      });
    },
  };

  const pending = planner.plan({
    rootId: 'root',
    folders: [],
    bookmarks: [],
    inboxFolderIds: [],
  });
  assert.equal(pending instanceof Promise, true);
  const output: OrganizePlannerOutput = await pending;
  assert.equal(output.plannerId, 'heuristic.v1.port_shape');
  assert.equal(output.truncated, false);
  assert.deepEqual(output.actions, []);
});

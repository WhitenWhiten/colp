import { expect, test } from 'vitest';
import { planAutomationTagUpdate } from '../../../src/infrastructure/automation/tag-effect.js';

interface MemoryNode {
  tags: unknown;
  payload_json: Record<string, unknown> | null;
  parent_id: string;
}

/** In-memory canonical tag write: a provided tags array replaces the column; parent placement is left alone. */
function createMemoryTagPort(tags: unknown, payload_json: Record<string, unknown> | null) {
  const node: MemoryNode = { tags, payload_json, parent_id: 'root' };
  return {
    node,
    commit(fields: { tags?: readonly string[] }) {
      if (fields.tags === undefined) return;
      node.tags = [...fields.tags];
    },
    undo(previousTags: readonly string[]) {
      this.commit({ tags: previousTags });
    },
  };
}

function submit(tags: unknown, payload_json: Record<string, unknown> | null, additions: readonly string[]) {
  const port = createMemoryTagPort(tags, payload_json);
  const planned = planAutomationTagUpdate(port.node, additions);
  expect(planned, 'column tags must be readable before a tag effect commits').toBeDefined();
  port.commit({ tags: planned!.tags });
  return { port, planned: planned! };
}

test('null payload keeps column tags after commit and does not undo them to empty', () => {
  const { port, planned } = submit(['literature', 'saved'], null, ['research']);
  expect(planned.previousTags).toEqual(['literature', 'saved']);
  expect(port.node.tags).toEqual(['literature', 'saved', 'research']);
  expect(port.node.parent_id).toBe('root');
  port.undo(planned.previousTags);
  expect(port.node.tags).toEqual(['literature', 'saved']);
  expect(port.node.payload_json).toBeNull();
});

test('missing, null, empty, or non-array payload tags do not replace column tags', () => {
  const payloads: Record<string, unknown>[] = [
    { title: 'Paper' },
    { tags: null },
    { tags: 'literature' },
    { tags: ['literature', 1] },
    { tags: [] },
  ];
  for (const payload_json of payloads) {
    const { port, planned } = submit(['literature'], payload_json, ['research']);
    expect(planned).toEqual({ previousTags: ['literature'], tags: ['literature', 'research'] });
    expect(port.node.tags).toEqual(['literature', 'research']);
    port.undo(planned.previousTags);
    expect(port.node.tags).toEqual(['literature']);
    expect(port.node.parent_id).toBe('root');
  }
});

test('an empty tag column still merges the new tag and undo restores that empty snapshot', () => {
  for (const tags of [null, []]) {
    const { port, planned } = submit(tags, null, ['research']);
    expect(planned.previousTags).toEqual([]);
    expect(port.node.tags).toEqual(['research']);
    port.undo(planned.previousTags);
    expect(port.node.tags).toEqual([]);
  }
});

test('a non-array tag column is not snapshotted as empty and is not committed', () => {
  const port = createMemoryTagPort({ unexpected: true }, null);
  expect(planAutomationTagUpdate(port.node, ['research'])).toBeUndefined();
  expect(port.node.tags).toEqual({ unexpected: true });
  expect(port.node.parent_id).toBe('root');
});

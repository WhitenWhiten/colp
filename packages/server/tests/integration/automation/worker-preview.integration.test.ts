import { afterEach, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { sql } from 'kysely';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { automationPollingFixture } from '../../support/automation-polling-fixture.js';
import { createCollectionNode } from '../../../src/modules/collections/index.js';

describeWithPostgres('worker preview and intake agreement', () => {
  let f: Awaited<ReturnType<typeof automationPollingFixture>>;
  afterEach(async () => { await f?.close(); });
  test('preview counts the enrichment run for explicitly selected placement', async () => {
    f = await automationPollingFixture('review_preview');
    const event = JSON.parse(readFileSync('../../docs/automation/design/examples/event-facts.json', 'utf8'));
    Object.assign(event, { collectionId: 'collection', nodeId: 'selected-paper', intakeDisposition: 'userSelected' });
    Object.assign(event.bookmark, { nodeId: 'selected-paper', parent: { serverUuid: 'server', collectionId: 'collection', nodeId: 'root' }, ancestors: [{ serverUuid: 'server', collectionId: 'collection', nodeId: 'root' }] });
    const preview = await f.ownerPost('/rules/preview', { rule: f.ruleInput, mode: 'supplied', events: [event] });
    expect(preview.statusCode, preview.body).toBe(200);
    const created = await f.canonical.execute(ports => createCollectionNode(ports, { actor: { principalId: f.owner.accountId, subjectId: f.owner.subjectId, principalType: 'account' }, command: f.command(), collectionId: 'collection',
      parentId: 'root', intakeDisposition: 'userSelected', nodeId: 'selected-paper', afterId: null, beforeId: null,
      node: { kind: 'bookmark', title: event.bookmark.title, url: 'https://arxiv.org/abs/example-placeholder', description: null, tags: [], visibility: 'inherit' } }));
    expect(created.kind).toBe('created'); await f.inspect();
    const actual = (await sql`SELECT r.id FROM automation_runs r JOIN automation_jobs j ON j.run_id=r.id WHERE r.explanation_json->>'nodeId'='selected-paper' AND j.state='ready'`.execute(f.db)).rows;
    expect(actual).toHaveLength(1);
    expect(preview.json().plannedRunCount).toBe(actual.length);
    expect(preview.json().decisions[0].pendingTasks).toEqual(['summary.generate']);
  });
});

import { createWorkerTransport, createFileJournal, runPollingCycle } from '../../../../examples/worker-script/claim-and-summarize.mjs';
import * as summaryAdapter from '../../../../examples/worker-script/deterministic-summary.mjs';

if (!process.send) throw new Error('IPC test process required');
process.once('message', async ({ origin, token, targetId, journalPath, three, interruptProvider }) => {
  const adapter = {
    supports: task => three ? ['classify.refine','tags.generate','summary.generate'].includes(task.type) : summaryAdapter.supports(task),
    async generate(args) {
      process.send({ type: 'provider-called', task: args.task.type });
      if (interruptProvider) await new Promise(() => {});
      if (!three || args.task.type === 'summary.generate') return summaryAdapter.generate(args);
      const evidence = args.inputs.map(input => ({ kind: 'source',reference: input.sourceEventId,observedAt: new Date().toISOString() }));
      return { output: args.task.type === 'tags.generate'
        ? { kind: 'tags',mergeMode: 'unionPreserveUser',add: [{ key: 'research',label: 'Research',evidence }] }
        : { kind: 'placement',decision: 'move',destination: { ...args.allowedFolders[0],nodeId: 'topic' },reason: 'Deterministic live subtree fixture',evidence } };
    },
  };
  try {
    const results = await runPollingCycle({ request: createWorkerTransport({ baseUrl: origin,accessToken: async () => token }),targetId,adapter,journal: createFileJournal(journalPath) });
    process.send({ type: 'completed',results });
  } catch { process.send({ type: 'failed' }); process.exitCode=1; }
  finally { process.disconnect(); }
});

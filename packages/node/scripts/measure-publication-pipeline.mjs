/** Local-only scale/pipeline measurements; never an Actions or npm run check gate. */
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { requireLocalPerformanceEnvironment, summarizeDurations, samePerformanceEnvironment } from './lib/local-performance.mjs';

requireLocalPerformanceEnvironment();
const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), '..');
const scenarios = ['plan', 'get', 'head', 'not-modified', 'receive', 'assemble-pages'];
const sizes = [100, 1_000, 10_000];
const environment = { platform: process.platform, arch: process.arch,
  node: process.version, nodeMajor: process.versions.node.split('.')[0], cpu: cpus()[0]?.model ?? 'unknown' };

async function worker(scenario, size, samples) {
  if (!scenarios.includes(scenario) || !sizes.includes(size) || !Number.isSafeInteger(samples) || samples < 1 || samples > 1000) {
    throw new Error('Invalid measurement worker parameters.');
  }
  const server = await import('../dist/server/index.js');
  const semantic = await import('../dist/semantic/index.js');
  const schema = await import('../dist/schema/index.js');
  const snapshot = JSON.parse(await readFile(resolve(root, 'fixtures/protocol/examples/collection-snapshot.json'), 'utf8'));
  const rootNode = snapshot.nodes.find(node => node.kind === 'root');
  snapshot.nodes = [rootNode]; snapshot.annotations = []; snapshot.attachments = [];
  snapshot.relations = []; snapshot.tombstones = []; delete snapshot.contentDigest;
  for (let index = 0; index < size; index++) snapshot.nodes.push({
    id: 'bench-folder-' + index, collectionId: snapshot.collection.id, kind: 'folder',
    parentId: rootNode.id, position: index.toString(36), title: 'Folder ' + index,
    createdAt: snapshot.generatedAt, updatedAt: snapshot.generatedAt, revision: snapshot.revision, extensions: {},
  });
  const input = { classification: 'static', query: {}, snapshot };
  const plan = server.planPublicationSnapshotDelivery(input);
  if (plan.delivery !== 'single-page') throw new Error('Measurement requires a valid static plan.');
  const source = JSON.stringify(snapshot);
  const validators = schema.createValidatorRegistry();
  const pageCount = Math.ceil(snapshot.nodes.length / 1000);
  const pages = Array.from({ length: pageCount }, (_, index) => ({
    ...snapshot, nodes: snapshot.nodes.slice(index * 1000, (index + 1) * 1000),
    page: { sequence: index + 1, hasMore: index + 1 < pageCount,
      nextCursor: index + 1 < pageCount ? 'bench-cursor-' + (index + 2) : null },
  }));
  const run = async () => {
    if (scenario === 'plan') return server.planPublicationSnapshotDelivery(input);
    if (scenario === 'assemble-pages') {
      const result = semantic.assembleSnapshotPages(pages, { publicationExtensionMode: 'consumer' });
      if (!result.valid) throw new Error('Invalid benchmark page assembly');
      return result;
    }
    if (scenario === 'receive') {
      const parsed = schema.parseIJson(source, { maxMembers: 1_000_000 });
      if (!validators.validate('snapshot', parsed).valid
        || !semantic.validateSnapshotSemantics(parsed, { publicationExtensionMode: 'consumer' }).valid) {
        throw new Error('Invalid benchmark receive representation');
      }
      return parsed;
    }
    const response = server.createPublicationSnapshotSinglePageResponse(plan, {
      method: scenario === 'head' ? 'HEAD' : 'GET', status: scenario === 'not-modified' ? 304 : 200,
    });
    if (scenario === 'get') return response.arrayBuffer();
    if (response.body !== null) throw new Error('HEAD/304 must have no body');
    return response;
  };
  for (let warm = 0; warm < 3; warm++) await run();
  globalThis.gc?.();
  const memoryBefore = process.memoryUsage();
  const durations = [];
  let sampledPeakHeapBytes = memoryBefore.heapUsed;
  let sampledPeakRssBytes = memoryBefore.rss;
  for (let sample = 0; sample < samples; sample++) {
    const start = performance.now();
    await run();
    durations.push(performance.now() - start);
    const memory = process.memoryUsage();
    sampledPeakHeapBytes = Math.max(sampledPeakHeapBytes, memory.heapUsed);
    sampledPeakRssBytes = Math.max(sampledPeakRssBytes, memory.rss);
  }
  return { scenario, folders: size, utf8Bytes: Buffer.byteLength(source), pageCount,
    ...summarizeDurations(durations), sampledPeakHeapBytes, sampledPeakRssBytes,
    processPeakRssKiB: process.resourceUsage().maxRSS,
    memoryNote: 'Sampled heap/RSS are lower bounds; process peak also includes startup, fixtures and warmup.' };
}

const args = process.argv.slice(2);
if (args[0] === '--worker') {
  process.stdout.write(JSON.stringify(await worker(args[1], Number(args[2]), Number(args[3]))));
} else {
  let output = resolve(root, 'reports/publication-pipeline.json');
  let baseline;
  let samples = 10;
  for (let index = 0; index < args.length; index += 2) {
    if (args[index + 1] === undefined) throw new Error('Missing measurement option value');
    if (args[index] === '--output') output = resolve(args[index + 1]);
    else if (args[index] === '--compare') baseline = JSON.parse(await readFile(resolve(args[index + 1]), 'utf8'));
    else if (args[index] === '--samples') samples = Number(args[index + 1]);
    else throw new Error('Unknown measurement option: ' + args[index]);
  }
  if (!Number.isSafeInteger(samples) || samples < 1 || samples > 1000) throw new Error('samples must be between 1 and 1000');
  if (baseline !== undefined && !samePerformanceEnvironment(environment, baseline.environment)) {
    throw new Error('Do not compare performance across OS, architecture, CPU or Node-major environments.');
  }
  const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).length !== 0;
  const results = [];
  for (const scenario of scenarios) for (const size of sizes) {
    const result = JSON.parse(execFileSync(process.execPath,
      ['--expose-gc', script, '--worker', scenario, String(size), String(samples)],
      { cwd: root, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }));
    const previous = baseline?.results?.find(entry => entry.scenario === scenario && entry.folders === size);
    if (previous?.p95Ms > 0) result.p95RatioToBaseline = result.p95Ms / previous.p95Ms;
    results.push(result);
    console.log(scenario, size, 'folders:', result.p95Ms.toFixed(2), 'ms p95');
  }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify({ formatVersion: 1, environment, sourceRevision, dirty,
    measuredAt: new Date().toISOString(), results }, null, 2) + '\n');
  console.log('Local report:', output, '(measurements only; no cross-host absolute performance gate)');
}

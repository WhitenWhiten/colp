import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createBookmarkClassificationProvider,
  createCloudflareUpstream,
  type ClassificationUpstream,
} from '../../../src/infrastructure/collections/classification-provider-factory.js';
import type {
  ClassificationCallResult,
  ClassificationContext,
  ClassificationExecutionContext,
  ClassificationStage,
} from '../../../src/modules/collections/index.js';

/** Recursive walk: a guard that only reads the top level stops working the moment one is added. */
async function applicationSources(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await applicationSources(path));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
}

export interface BoundarySource { readonly name: string; readonly text: string }
export interface BoundaryViolation { readonly file: string; readonly literal: string; readonly line: number }

// Vendor identity, upstream domains and wire/credential names are forbidden
// everywhere in the application layer, whatever the file is called.
const FORBIDDEN_EVERYWHERE = [
  'cloudflare_jev', 'jev-1.13.0', 'typesafe', 'cloudflare.com', 'vercel.sh',
  'BOOKMARK_CLASSIFICATION_CF_', 'CF_ACCESS_KEY', 'CF_GATEWAY_ID', 'cf-aig-',
];
// Wire and credential details are only forbidden on the classification surface
// itself, because unrelated application modules legitimately mention other
// providers, headers and credentials.
const FORBIDDEN_ON_CLASSIFICATION_SURFACE = ['/ai/run', '/v1/systemone', 'accesskey', 'bearer '];
/** Any absolute URL in the application layer is a configuration leak by default. */
const ABSOLUTE_URL = /https?:\/\//iu;
const ALLOWED_URL_HOST = 'favicone.com';

const isClassificationSurface = (name: string) => name.includes('classification') || name.includes('capture');

/**
 * The guard is a function so a meta-test can prove it fires: an enumerated
 * allowlist that silently stops matching is worse than no guard.
 */
export function findBoundaryViolations(sources: readonly BoundarySource[]): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  for (const source of sources) {
    const literals = isClassificationSurface(source.name)
      ? [...FORBIDDEN_EVERYWHERE, ...FORBIDDEN_ON_CLASSIFICATION_SURFACE]
      : FORBIDDEN_EVERYWHERE;
    const lines = source.text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const lower = line.toLowerCase();
      for (const literal of literals) {
        if (lower.includes(literal.toLowerCase())) violations.push({ file: source.name, literal, line: i + 1 });
      }
      if (ABSOLUTE_URL.test(line) && !line.includes(ALLOWED_URL_HOST)) {
        violations.push({ file: source.name, literal: 'absolute URL', line: i + 1 });
      }
    }
  }
  return violations;
}

describe('classification architectural boundary tests', () => {
  it('modules/collections/application contains zero vendor names, upstream URLs, or credentials', async () => {
    const appDir = resolve(import.meta.dirname, '../../../src/modules/collections/application');
    const files = await applicationSources(appDir);

    expect(files.length).toBeGreaterThan(50);

    const sources: BoundarySource[] = [];
    for (const path of files) {
      sources.push({ name: relative(appDir, path).split('\\').join('/'), text: await readFile(path, 'utf8') });
    }

    expect(findBoundaryViolations(sources)).toEqual([]);
  });

  it('the guard itself catches a new endpoint, vendor host or credential in any file name', () => {
    // The one legitimate absolute URL in the layer (an unrelated favicon service).
    const allowed: BoundarySource[] = [
      { name: 'classification-clean.ts', text: "export const clean = true;\n" },
      { name: 'favicon-batch-job.ts', text: "const url = 'https://favicone.com/{hostname}';\n" },
    ];
    expect(findBoundaryViolations(allowed)).toEqual([]);

    const mutants: BoundarySource[] = [
      // A vendor host in a file the old prefix heuristic ignored.
      { name: 'ports.ts', text: "const host = 'gateway.ai.cloudflare.com';\n" },
      // A wire header outside any classification-named file.
      { name: 'ports.ts', text: "headers['cf-aig-gateway-id'] = 'gw';\n" },
      // A credential read in a file that contains but does not start with 'classification'.
      { name: 'run-classification-execution.ts', text: "const key = env.CF_ACCESS_KEY;\n" },
      { name: 'run-classification-execution.ts', text: "headers['Authorization'] = 'Bearer sk-live-123';\n" },
      // A brand-new upstream the frozen literal list never knew.
      { name: 'classification-new-upstream.ts', text: "const url = 'https://api.openai.com/v1/chat';\n" },
      { name: 'capture-new-upstream.ts', text: "const path = '/v1/systemone';\n" },
    ];
    const found = findBoundaryViolations(mutants);
    for (const mutant of mutants) {
      expect(found.some((violation) => violation.file === mutant.name && violation.line === 1),
        `guard missed ${mutant.text.trim()}`).toBe(true);
    }
  });

  it('upstream descriptor is the sole provider/transport configuration injection point', async () => {
    const customUpstream: ClassificationUpstream = {
      id: 'custom_provider',
      wire: 'cloudflare_ai_run_v1',
      endpoint: 'https://gateway.example.com/custom/run',
      model: 'custom-model-2026',
      credential: { accessKey: 'sk-test-token', gatewayId: 'gw-primary', required: true },
      requestTimeoutMs: 10_000,
      byokOnly: true,
      capability: { l1Options: 33, descendantOptions: 65, noulQuestions: 16, inputBytes: 32768 },
    };

    let observedUrl = '';
    let observedBody: Record<string, unknown> = {};
    let observedHeaders: Record<string, string> = {};

    const transport: typeof fetch = async (url, init) => {
      observedUrl = String(url);
      observedBody = JSON.parse(String(init?.body));
      observedHeaders = Object.fromEntries(Object.entries(init?.headers as Record<string, string> ?? {}));
      const request = JSON.parse(String(init?.body));
      const answers = Object.fromEntries(Object.entries((request.input?.questions ?? {}) as Record<string, { type: string; criteria: Record<string, string> }>).map(([key, value]) => {
        const options = Object.keys(value.criteria);
        return [key, value.type === 'noul' ? { noul: 0.9 } : { choice: options[0], confidence: 1, probabilities: Object.fromEntries(options.map((id, index) => [id, index === 0 ? 1 : 0])) }];
      }));
      return Response.json({
        model: 'custom-model-2026',
        answers,
        usage: { input_tokens: 5, output_tokens: 1 },
      });
    };

    const provider = createBookmarkClassificationProvider(customUpstream);
    expect(provider.id).toBe('custom_provider');
    expect(provider.model).toBe('custom-model-2026');

    // Provider delegate transport injection
    const cfProvider = (await import('../../../src/infrastructure/collections/classification-provider-cloudflare-jev.js'))
      .createCloudflareJevClassificationProvider(customUpstream, transport);

    const { buildClassificationCandidates } = await import('../../../src/modules/collections/application/classification-candidates.js');
    const bookmark = { url: 'https://example.org', title: 'Example', description: 'Desc' };
    const candidates = buildClassificationCandidates({
      bookmark,
      folders: [{ id: 'f1', parentId: null, title: 'Alpha folder', description: 'Alpha folder' }],
      tagUsage: [],
      existingTags: [],
      requested: { folder: true, tags: false },
    });

    const context = {
      bookmark,
      requested: { folder: true, tags: false },
      candidates,
      collection: { title: 'Lib', summary: null },
      snapshot: { node: null, settings: { maxAutoTags: 3 } },
    };

    const execution = {
      executionId: 'exec-1',
      deadlineAt: new Date(Date.now() + 10000).toISOString(),
      signal: new AbortController().signal,
      calls: { run: async (_stage: ClassificationStage, _chunk: number, _body: unknown, send: () => Promise<ClassificationCallResult>) => send() },
    };

    // A hand-built minimal context: this test exercises the transport, not context loading.
    await cfProvider.classify(context as unknown as ClassificationContext, execution as unknown as ClassificationExecutionContext);

    expect(observedUrl).toBe('https://gateway.example.com/custom/run');
    expect(observedBody.model).toBe('custom-model-2026');
    expect(observedHeaders['Authorization']).toBe('Bearer sk-test-token');
    expect(observedHeaders['cf-aig-gateway-id']).toBe('gw-primary');
  });
});

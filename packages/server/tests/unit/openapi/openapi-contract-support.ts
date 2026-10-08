import assert from 'node:assert/strict';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';

export const backendRoot = resolve(import.meta.dirname, '../../..');
export const sourcePath = join(backendRoot, 'openapi/product-v1.yaml');
export const generatedBundlePath = join(backendRoot, 'generated/openapi/product-v1.bundle.yaml');
export const generatedRoutesPath = join(backendRoot, 'generated/openapi/product-v1.routes.json');

export type UnknownRecord = Record<string, unknown>;
export type Operation = UnknownRecord & {
  operationId?: string;
  parameters?: Array<{ $ref?: string }>;
  responses?: Record<string, UnknownRecord>;
  security?: Array<Record<string, unknown>>;
};
export type OpenApiDocument = UnknownRecord & {
  info: { version: string };
  paths: Record<string, Record<string, Operation>>;
  components: {
    headers: Record<string, UnknownRecord>;
    parameters: Record<string, UnknownRecord>;
    responses: Record<string, UnknownRecord>;
    schemas: Record<string, UnknownRecord>;
    securitySchemes: Record<string, UnknownRecord>;
  };
};

const httpMethods = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace']);

export function readDocument(path = sourcePath): OpenApiDocument {
  return parse(readFileSync(path, 'utf8')) as OpenApiDocument;
}

/** Current Product info.version as emitted by `openapi:generate` / `openapi:drift`. */
export function generatedProductOpenApiVersion(): string {
  return readDocument(generatedBundlePath).info.version;
}

export function currentBreakingBaselinePath(): string {
  return `openapi/baselines/product-v1.${generatedProductOpenApiVersion()}.yaml`;
}

export function assertProductOpenApiVersionMatchesGenerated(
  document: OpenApiDocument = readDocument(),
): string {
  const generated = generatedProductOpenApiVersion();
  assert.equal(
    document.info.version,
    generated,
    'source info.version must match the openapi:drift generated bundle, not a handwritten pin',
  );
  return generated;
}

export function operations(
  document: OpenApiDocument,
): Array<{ path: string; method: string; operation: Operation }> {
  return Object.entries(document.paths).flatMap(([path, pathItem]) =>
    Object.entries(pathItem)
      .filter(([method]) => httpMethods.has(method))
      .map(([method, operation]) => ({ path, method, operation })),
  );
}

export function parameterRefs(operation: Operation): Set<string> {
  return new Set((operation.parameters ?? []).map((parameter) => parameter.$ref).filter(Boolean) as string[]);
}

export function resolveLocalRef(document: UnknownRecord, ref: string): unknown {
  assert.match(ref, /^#\//, `external reference is not allowed in the source contract: ${ref}`);
  return ref
    .slice(2)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce<unknown>((current, segment) => {
      assert.ok(current && typeof current === 'object' && segment in current, `unresolved reference: ${ref}`);
      return (current as UnknownRecord)[segment];
    }, document);
}

export function collectRefs(value: unknown, refs: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, refs);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key === '$ref' && typeof child === 'string') refs.push(child);
      else collectRefs(child, refs);
    }
  }
  return refs;
}

export function runNodeScript(script: string, args: string[]) {
  return spawnSync(process.execPath, [join(backendRoot, script), ...args], {
    cwd: backendRoot,
    encoding: 'utf8',
    timeout: 10_000,
  });
}

export function createGeneratorFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'known-openapi-generator-test-'));
  try {
    mkdirSync(join(root, 'openapi'), { recursive: true });
    mkdirSync(join(root, 'generated'), { recursive: true });
    cpSync(join(backendRoot, 'scripts'), join(root, 'scripts'), { recursive: true });
    cpSync(sourcePath, join(root, 'openapi/product-v1.yaml'));
    cpSync(join(backendRoot, 'generated/openapi'), join(root, 'generated/openapi'), { recursive: true });
    symlinkSync(
      join(backendRoot, 'node_modules'),
      join(root, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    return root;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export function runGeneratorFixture(root: string, args: string[]) {
  return spawnSync(process.execPath, [join(root, 'scripts/generate-openapi.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

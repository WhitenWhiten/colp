import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';

export async function readDocument(file) {
  const source = await readFile(file, 'utf8');
  return path.extname(file).toLowerCase() === '.json' ? JSON.parse(source) : parse(source);
}

export function resolveLocalRef(document, ref) {
  if (!ref.startsWith('#/')) {
    throw new Error(`Only local OpenAPI references are allowed: ${ref}`);
  }

  return ref
    .slice(2)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce((value, segment) => value?.[segment], document);
}

export function expandLocalRefs(document, value, activeRefs = new Set()) {
  if (Array.isArray(value)) {
    return value.map((item) => expandLocalRefs(document, item, activeRefs));
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (typeof value.$ref === 'string') {
    if (activeRefs.has(value.$ref)) {
      return { $ref: value.$ref };
    }
    const target = resolveLocalRef(document, value.$ref);
    if (target === undefined) {
      throw new Error(`Unresolved OpenAPI reference: ${value.$ref}`);
    }
    const nextRefs = new Set(activeRefs).add(value.$ref);
    return expandLocalRefs(document, { ...target, ...value, $ref: undefined }, nextRefs);
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, expandLocalRefs(document, item, activeRefs)]),
  );
}

export function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

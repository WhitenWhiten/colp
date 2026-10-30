import { expect, test, vi } from 'vitest';
import { resolvePageContent } from '../src/site-adapters/content-resolver.js';
import { bilibiliDefinition } from '../src/site-adapters/bilibili/definition.js';

test('ordinary pages do not open a broken unrelated installation', async () => {
  const resolve = vi.fn(async () => { throw Error('schemaIncompatible'); });
  await expect(resolvePageContent([{ definition: bilibiliDefinition, resolve }], 'https://example.org/article', 1)).resolves.toBeNull();
  expect(resolve).not.toHaveBeenCalled();
});

test('another matching installation can resolve without touching an unrelated broken site', async () => {
  const broken = vi.fn(async () => { throw Error('schemaIncompatible'); });
  const resolve = vi.fn(async () => 'article');
  const definition = { ...bilibiliDefinition, siteKey: 'articles', origin: 'https://example.org', matches: ['https://example.org/*'] };
  await expect(resolvePageContent([{ definition: bilibiliDefinition, resolve: broken }, { definition, resolve }], 'https://example.org/article', 1))
    .resolves.toEqual({ siteKey: 'articles', identityVersion: 1, itemId: 'article' });
  expect(broken).not.toHaveBeenCalled();
});

test('a matching site failure retains managed-copy protection', async () => {
  await expect(resolvePageContent([{ definition: bilibiliDefinition, resolve: async () => { throw Error('schemaIncompatible'); } }],
    'https://www.bilibili.com/video/BV1xx', 1)).rejects.toThrow('schemaIncompatible');
});

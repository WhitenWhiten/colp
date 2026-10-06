/** Local links in shipped Markdown must resolve inside the installed tarball. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';

export async function verifyPackedDocLinks({ installedPackage, files }) {
  const packedPaths = new Set(files.map((file) => file.path));
  for (const document of packedPaths) {
    if (!document.endsWith('.md')) continue;
    const source = await readFile(resolve(installedPackage, document), 'utf8');
    for (const match of source.matchAll(/\[[^\]\n]*\]\(([^)\s]+)(?:\s+["'][^)]*)?\)/gu)) {
      const target = match[1];
      if (/^[a-z][a-z0-9+.-]*:/iu.test(target) || target.startsWith('#')) continue;
      const local = decodeURIComponent(target.split(/[?#]/u)[0]);
      const destination = relative(installedPackage,
        resolve(installedPackage, dirname(document), local)).split(sep).join('/');
      assert.ok(packedPaths.has(destination),
        'Broken packaged documentation link: ' + document + ' -> ' + target);
    }
  }
}

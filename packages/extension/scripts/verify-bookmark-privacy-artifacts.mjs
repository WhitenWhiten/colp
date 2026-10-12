import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const roots = process.argv.slice(2).map((value) => resolve(value));
assert.ok(roots.length > 0, 'expected network, trace, screenshot or storage artifact directory');
const forbidden = ['PRIVATE-LOCAL-SENTINEL', 'UNSELECTED-SENTINEL', 'native-sensitive-id',
  'PROFILE-A-PRIVATE-SENTINEL', 'PROFILE-B-PRIVATE-SENTINEL',
  'PROFILE-A-UNSELECTED-SENTINEL', 'PROFILE-B-UNSELECTED-SENTINEL',
  'PRIVATE-QUEUE-SENTINEL', 'UNSELECTED-QUEUE-SENTINEL',
  'P3-31-ACCESS-TOKEN-SENTINEL', 'P3-31-SESSION-ID-SENTINEL', 'P3-31-NATIVE-ID-SENTINEL',
  'https://sentinel.invalid/private', 'https://sentinel.invalid/unselected',
  'https://sentinel.invalid/profile-a-private', 'https://sentinel.invalid/profile-b-private',
  'https://sentinel.invalid/profile-a-unselected', 'https://sentinel.invalid/profile-b-unselected',
  'https://sentinel.invalid/private-queue', 'https://sentinel.invalid/unselected-queue'];
let files = 0;
for (const root of roots) {
  assert.equal((await stat(root)).isDirectory(), true, `artifact root is not a directory: ${root}`);
  for (const file of await walk(root)) {
    files += 1; const content = await readFile(file);
    for (const marker of forbidden) assert.equal(content.includes(Buffer.from(marker)), false,
      `${relative(root, file)} contains private bookmark artifact marker`);
  }
}
assert.ok(files > 0, 'artifact scan is fail closed when no files were produced');
process.stdout.write(`${JSON.stringify({ schemaVersion: 1, artifactPrivacy: 'passed', files })}\n`);

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path)); else files.push(path);
  }
  return files;
}

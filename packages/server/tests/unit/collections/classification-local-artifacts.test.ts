import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {expect,test} from 'vitest';
test('backend policy changes cannot silently leave the browser policy artifact behind',async()=>{
  const {stdout}=await promisify(execFile)(process.execPath,[fileURLToPath(new URL('../../../scripts/generate-classification-local.mjs',import.meta.url)),'--check']);
  expect(stdout).toContain('browser-safe artifacts verified');
});

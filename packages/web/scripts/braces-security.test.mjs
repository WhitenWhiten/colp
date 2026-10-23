import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(new URL('../package.json', import.meta.url));
const braces = require('braces');

test('the installed override preserves normal lint globs and bounds every recursive entry point', () => {
  assert.equal(require('braces/package.json').version, '3.0.4-colp.1');
  assert.deepEqual(braces.expand('src/**/*.{css,scss}'), ['src/**/*.css', 'src/**/*.scss']);
  assert.deepEqual(braces.expand('file-{1..3}.css'), ['file-1.css', 'file-2.css', 'file-3.css']);
  for (const [open, close] of [['{', '}'], ['(', ')']]) {
    const shallow = open.repeat(100) + 'a' + close.repeat(100);
    const deep = open.repeat(101) + 'a' + close.repeat(101);
    for (const method of ['parse', 'compile', 'expand', 'stringify']) {
      assert.doesNotThrow(() => braces[method](shallow));
      assert.throws(() => braces[method](deep), /exceeds max depth/);
    }
  }
  let ast = { type: 'text', value: 'a' };
  for (let depth = 0; depth < 101; depth++) ast = { type: 'brace', nodes: [ast] };
  for (const method of ['compile', 'expand', 'stringify']) assert.throws(() => braces[method]({ type: 'root', nodes: [ast] }), /exceeds max depth/);
  const cyclic = { type: 'paren', nodes: [{ type: 'text', value: 'a' }] }; cyclic.parent = cyclic;
  assert.throws(() => braces.expand(cyclic), /parent chain contains a cycle/);
});

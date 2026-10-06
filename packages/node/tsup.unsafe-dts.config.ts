import { defineConfig } from 'tsup';

/** Keep composition-free and test-only declarations out of the production declaration graph. */
export default defineConfig({
  entry: { 'sync/unsafe': 'src/sync/unsafe.ts', 'testing/index': 'src/testing/index.ts' },
  clean: false,
  dts: { only: true },
  format: ['esm', 'cjs'],
});

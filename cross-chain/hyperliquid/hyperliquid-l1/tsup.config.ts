import { defineConfig } from 'tsup';

export default defineConfig([
  // Main build
  {
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    clean: true,
    sourcemap: true,
    minify: true,
    target: 'node16',
  },
]); 
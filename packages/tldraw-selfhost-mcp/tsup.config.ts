import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  format: ['cjs'],
  platform: 'node',
  target: 'node18',
  bundle: true,
  minify: false,
  sourcemap: false,
  clean: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
})

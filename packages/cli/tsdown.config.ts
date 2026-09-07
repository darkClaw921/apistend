import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { cli: 'src/cli.ts', index: 'src/index.ts' },
  format: ['esm', 'cjs'],
  target: 'node20',
  dts: true,
  sourcemap: true,
  // Читаемый стектрейс в баг-репорте ценнее сорока сэкономленных килобайт.
  minify: false,
  clean: true,
  outputOptions: {
    banner: (chunk) => (chunk.fileName.startsWith('cli') ? '#!/usr/bin/env node' : ''),
  },
})

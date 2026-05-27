import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const { version } = JSON.parse(readFileSync('package.json', 'utf-8'));

export default defineConfig({
  entry: [
    'src/index.mts',
    'src/cli/tftpd.mts',
    'src/cli/dhcpd.mts',
    'src/cli/bootpd.mts',
    'src/cli/pxed.mts',
  ],
  format: ['esm'],
  outDir: 'dist',
  clean: true,
  dts: true,
  splitting: false,
  sourcemap: true,
  minify: false,
  define: {
    PKG_VERSION: JSON.stringify(version),
  },
  outExtension() { return { js: '.mjs' }; },
});

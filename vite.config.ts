import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  root: 'web',
  build: { outDir: '../dist', emptyOutDir: true, target: 'es2022' },
  define: { __APP_VERSION__: JSON.stringify(version) },
});

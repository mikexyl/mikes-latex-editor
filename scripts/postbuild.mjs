// After `vite build`: copy the pdf.js worker into dist/, so a production build (the desktop app)
// doesn't need pdfjs-dist at runtime.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = createRequire(import.meta.url).resolve('pdfjs-dist/build/pdf.worker.min.mjs');
fs.mkdirSync(path.join(root, 'dist', 'vendor'), { recursive: true });
fs.copyFileSync(src, path.join(root, 'dist', 'vendor', 'pdf.worker.min.mjs'));

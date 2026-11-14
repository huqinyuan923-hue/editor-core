/**
 * 基准执行器:esbuild 打包 src/bench.ts(纯 JS 可直接跑),输出 .tmp 后 import。
 */
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, '.tmp', 'bench.bundle.mjs');
mkdirSync(join(ROOT, '.tmp'), { recursive: true });

await build({
  entryPoints: [join(ROOT, 'src/bench.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  outfile: OUT,
  logLevel: 'warning',
});

await import(pathToFileURL(OUT).href);

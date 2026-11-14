/**
 * Web 单文件构建:esbuild 打包 src/web/main.ts,内联进 web/index.html 模板,
 * 产出 dist/index.html(单文件,零运行时依赖)。
 */
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const result = await build({
  entryPoints: [join(ROOT, 'src/web/main.ts')],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2022',
  write: false,
  logLevel: 'info',
});
const js = result.outputFiles[0].text;
const tpl = readFileSync(join(ROOT, 'web/index.html'), 'utf8');
// 用函数形式替换,避免 js 里的 $ 字符串被当作替换模式
const html = tpl.replace('/*__BUNDLE__*/', () => js);
mkdirSync(join(ROOT, 'dist'), { recursive: true });
writeFileSync(join(ROOT, 'dist/index.html'), html, 'utf8');
console.log(`dist/index.html 生成:${(html.length / 1024).toFixed(1)} KB`);

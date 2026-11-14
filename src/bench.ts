/**
 * 性能基准(验收清单):1MB 10 万次编辑 < 2s;10MB 打开 < 300ms。
 * 由 scripts/bench.mjs 用 esbuild 打包后执行,结果进 REPORT.md。
 */
import { Doc, Editor } from './index';

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildText(targetLen: number, seed: number): string {
  const rnd = mulberry32(seed);
  const unit = 'const alpha = beta.gamma(42); // 注释\nfunction delta(epsilon) {\n  return [1, 2, 3].map((z) => z * 2);\n}\n';
  let text = '';
  while (text.length < targetLen) {
    if (rnd() < 0.5) text += unit;
    else text += `let v${Math.floor(rnd() * 1e6)} = "${Math.floor(rnd() * 1e6)}";\n`;
  }
  return text.slice(0, targetLen);
}

function bench(): void {
  const rnd = mulberry32(0xbeef);
  const text1 = buildText(1024 * 1024, 1);
  let t0 = performance.now();
  const doc = new Doc(text1);
  const open1MB = performance.now() - t0;
  const ops: ('ins' | 'del')[] = [];
  for (let i = 0; i < 100; i++) ops.push(rnd() < 0.5 ? 'ins' : 'del');
  t0 = performance.now();
  for (let i = 0; i < 100000; i++) {
    const op = ops[i % 100]!;
    const at = Math.floor(rnd() * doc.length);
    if (op === 'ins') doc.insert(at, 'x');
    else doc.del(at, Math.min(1 + Math.floor(rnd() * 12), doc.length - at));
  }
  const editsMs = performance.now() - t0;

  const ed = new Editor(text1, { mergeTimeoutMs: Infinity });
  ed.setSelections([{ anchor: 0, active: 0 }]);
  t0 = performance.now();
  for (let i = 0; i < 100000; i++) {
    const at = Math.floor(rnd() * (ed.doc.length + 1));
    ed.setSelections([{ anchor: at, active: at }]);
    if (rnd() < 0.55) ed.type('x');
    else ed.backspace();
  }
  const editorMs = performance.now() - t0;

  const text10 = buildText(10 * 1024 * 1024, 2);
  t0 = performance.now();
  const doc10 = new Doc(text10);
  const open10MB = performance.now() - t0;
  t0 = performance.now();
  const line0 = doc10.getLine(0).length;
  const lineReadMs = performance.now() - t0;
  t0 = performance.now();
  let probe = 0;
  for (let i = 0; i < 10000; i++) probe += doc10.getLine(Math.floor(rnd() * doc10.lineCount())).length;
  const getLine10kMs = performance.now() - t0;
  if (probe < 0) console.log(probe); // 防优化
  if (line0 < 0) console.log(line0);

  const row = (name: string, ms: number, budget: string): string =>
    `${name.padEnd(36)} ${ms.toFixed(0).padStart(6)} ms   (预算 ${budget})`;
  console.log(row('1MB 打开(初始分片)', open1MB, '-'));
  console.log(row('1MB 10万次 Doc 编辑', editsMs, '< 2000'));
  console.log(row('1MB 10万次 Editor 编辑(含undo)', editorMs, '-'));
  console.log(row('10MB 打开', open10MB, '< 300'));
  console.log(row('10MB getLine 首行', lineReadMs, '-'));
  console.log(row('10MB getLine x 1万', getLine10kMs, '-'));

  const ok = editsMs < 2000 && open10MB < 300;
  console.log(ok ? '\n✅ 性能达标' : '\n❌ 未达标');
  if (!ok) process.exitCode = 1;
}

bench();

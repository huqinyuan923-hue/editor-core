import { describe, expect, it } from 'vitest';
import { Doc, Editor } from '../src/index';

/** 性能门槛(验收清单):1MB 10 万次编辑 < 2s;10MB 打开 < 300ms */
function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildText(targetLen: number): string {
  const rnd = mulberry32(1);
  const unit = 'const alpha = beta.gamma(42); // 注释\nfunction delta(epsilon) {\n  return [1, 2, 3].map((z) => z * 2);\n}\n';
  let text = '';
  while (text.length < targetLen) {
    if (rnd() < 0.5) text += unit;
    else text += `let v${Math.floor(rnd() * 1e6)} = "${Math.floor(rnd() * 1e6)}";\n`;
  }
  return text.slice(0, targetLen);
}

describe('性能基准', () => {
  it('1MB 文档 10 万次编辑 < 2s', () => {
    const rnd = mulberry32(0xbeef);
    const doc = new Doc(buildText(1024 * 1024));
    const t0 = performance.now();
    for (let i = 0; i < 100000; i++) {
      const at = Math.floor(rnd() * doc.length);
      if (rnd() < 0.5) doc.insert(at, 'x');
      else doc.del(at, Math.min(1 + Math.floor(rnd() * 12), doc.length - at));
    }
    const ms = performance.now() - t0;
    expect(ms, `10 万次编辑耗时 ${ms.toFixed(0)}ms`).toBeLessThan(2000);
  }, 60_000);

  it('打开 10MB 文档 < 300ms', () => {
    const t0 = performance.now();
    const doc = new Doc(buildText(10 * 1024 * 1024));
    const ms = performance.now() - t0;
    expect(doc.length).toBe(10 * 1024 * 1024);
    expect(ms, `10MB 打开耗时 ${ms.toFixed(0)}ms`).toBeLessThan(300);
  }, 60_000);

  it('Editor 层 10 万次多光标编辑 < 6s(含 undo 合并栈)', () => {
    const rnd = mulberry32(0xbeef);
    const ed = new Editor(buildText(1024 * 1024), { mergeTimeoutMs: Infinity });
    const t0 = performance.now();
    for (let i = 0; i < 100000; i++) {
      const at = Math.floor(rnd() * (ed.doc.length + 1));
      ed.setSelections([{ anchor: at, active: at }]);
      if (rnd() < 0.55) ed.type('x');
      else ed.backspace();
    }
    const ms = performance.now() - t0;
    expect(ms, `Editor 层耗时 ${ms.toFixed(0)}ms`).toBeLessThan(6000);
  }, 120_000);
});

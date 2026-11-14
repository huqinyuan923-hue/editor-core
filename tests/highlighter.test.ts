import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Highlighter } from '../src/highlighter';

/** 取第 n 行第 i 个 token 的 kind(辅助断言) */
function kinds(h: Highlighter, n: number): string[] {
  return h.line(n).tokens.map((t) => t.kind);
}

describe('Highlighter 分词', () => {
  it('关键字/标识符/数字/标点', () => {
    const h = new Highlighter('js');
    h.setText('const x = 42;');
    expect(kinds(h, 0)).toEqual(['keyword', 'whitespace', 'identifier', 'whitespace', 'punct', 'whitespace', 'number', 'punct']);
  });

  it('字符串(含转义)与除号歧义', () => {
    const h = new Highlighter('js');
    h.setText(`const s = "a\\"b";\nconst d = a / b / c;`);
    expect(kinds(h, 0)).toContain('string');
    // 标识符后的 / 是除号:punct(= / / ; 共 4 个)
    const k = kinds(h, 1);
    expect(k.filter((x) => x === 'punct').length).toBe(4);
    expect(k).not.toContain('regex');
  });

  it('正则字面量(关键字后/运算符后)', () => {
    const h = new Highlighter('js');
    h.setText('return /ab[cd]/gi.test(x);');
    expect(kinds(h, 0)).toContain('regex');
    const h2 = new Highlighter('js');
    h2.setText('const re = /x+/;');
    expect(kinds(h2, 0)).toContain('regex');
  });

  it('行注释与跨行块注释', () => {
    const h = new Highlighter('js');
    h.setText('a; // 注释\nb;\n/* 跨行\n仍然注释 */c;');
    expect(kinds(h, 0)).toContain('comment');
    expect(kinds(h, 1)).toEqual(['identifier', 'punct']);
    expect(kinds(h, 2)).toEqual(['comment']);
    expect(kinds(h, 3)).toEqual(['comment', 'identifier', 'punct']);
  });

  it('模板串与 ${} 插值嵌套', () => {
    const h = new Highlighter('js');
    h.setText('const t = `a${x + `b${y}`}c`;');
    const k = kinds(h, 0);
    expect(k).toContain('template');
    expect(k).toContain('identifier');
    // 跨行模板
    const h2 = new Highlighter('js');
    h2.setText('const u = `第一行\n第二行${z}`;');
    expect(kinds(h2, 1)).toContain('template');
    expect(kinds(h2, 1)).toContain('identifier');
  });

  it('十六进制/指数数字', () => {
    const h = new Highlighter('js');
    h.setText('0xFF 1.5e-3 .5 123n');
    const k = kinds(h, 0);
    expect(k.filter((x) => x === 'number').length).toBe(4);
  });
});

describe('Highlighter 增量一致性(验收 #4)', () => {
  it('随机单行编辑 ≥1 万次后:整文重算 = 增量结果', () => {
    const SEED_LINES = [
      '// 编辑器示例',
      'const editor = {',
      '  cursors: [],',
      '  type(ch) {',
      '    // 插入字符',
      '    this.buf += ch; // 累加',
      '  },',
      '  re: /a+[bc]?/g,',
      '  tpl: `x${1 + 2}y`,',
      '};',
      '/* 块注释',
      '   跨行 */ const done = true;',
      'const n = 0xFF + 1.5e-3;',
    ];
    let editCount = 0;
    fc.assert(
      fc.property(
        fc.array(fc.nat({ max: 50 }), { minLength: 60, maxLength: 90 }),
        fc.string({ maxLength: 24 }),
        (opSeq, snippet) => {
          const h = new Highlighter('js');
          h.setText(SEED_LINES.join('\n'));
          for (const op of opSeq) {
            const n = op % h.lineCount();
            const line = h.line(n).text;
            // 随机变异:拼接片段 / 截断 / 拼接 JS 片段
            const mode = (op >> 3) % 3;
            let next: string;
            if (mode === 0) next = line + snippet;
            else if (mode === 1) next = snippet + line.slice(snippet.length % Math.max(1, line.length));
            else next = line.slice(0, Math.max(0, line.length - (op % 7))) + (op % 2 ? ' */' : '`');
            h.editLine(n, next);
            editCount++;
          }
          // 增量结果必须与整文重算逐行逐 token 一致
          const full = h.highlightAll();
          for (let n = 0; n < h.lineCount(); n++) {
            expect(h.line(n).text).toBe(full[n]!.text);
            expect(h.line(n).tokens).toEqual(full[n]!.tokens);
          }
        },
      ),
      { numRuns: 150 },
    );
    expect(editCount).toBeGreaterThanOrEqual(10000);
  }, 120_000);

  it('跨行状态(块注释/模板)编辑后级联收敛', () => {
    const h = new Highlighter('js');
    h.setText('const a = 1;\n/* 开启\n注释中\n结束 */ const b = 2;');
    expect(kinds(h, 3)[0]).toBe('comment');
    // 撤掉块注释开启行:第 2、3 行级联重算,不再处于注释态
    h.editLine(1, 'const open = 1;');
    expect(kinds(h, 2)[0]).not.toBe('comment');
    expect(kinds(h, 3)[0]).not.toBe('comment');
    // 改回:第 3 行恢复为注释开头
    h.editLine(1, '/* 开启');
    expect(kinds(h, 3)[0]).toBe('comment');
    // 模板串跨行状态同理
    const h2 = new Highlighter('js');
    h2.setText('const t = `abc\ndef${x}ghi`;');
    expect(kinds(h2, 1)).toContain('template');
    h2.editLine(0, 'const t = 1; // 模板没了');
    expect(kinds(h2, 1)[0]).toBe('identifier'); // 不再从模板文本态开始(行尾反引号新开模板属正常)
    h2.editLine(0, 'const t = `abc');
    expect(kinds(h2, 1)).toContain('template');
  });
});

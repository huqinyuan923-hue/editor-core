import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Doc } from '../src/doc';

/**
 * M2 属性测试:随机操作序列驱动 Doc 与朴素字符串参照,校验:
 * ① getText === 参照字符串拼接
 * ② 行号无空洞:lineCount/逐行读取/lines() 与参照一致
 * ③ 相同操作日志重放到新 Doc 结果一致 + 树聚合完整
 */

type Op =
  | { t: 'ins'; at: number; text: string }
  | { t: 'del'; at: number; n: number };

const arbOp = fc.oneof(
  fc.record({ t: fc.constant('ins') as fc.Arbitrary<'ins'>, at: fc.nat({ max: 5000 }), text: fc.string({ maxLength: 12 }) }),
  fc.record({ t: fc.constant('del') as fc.Arbitrary<'del'>, at: fc.nat({ max: 5000 }), n: fc.nat({ max: 40 }) }),
);

function applyRef(model: string, op: Op): string {
  if (op.t === 'ins') {
    const at = Math.min(op.at, model.length);
    return model.slice(0, at) + op.text + model.slice(at);
  }
  const at = Math.min(op.at, model.length);
  return model.slice(0, at) + model.slice(at + op.n);
}

function applyDoc(d: Doc, op: Op): void {
  if (op.t === 'ins') d.insert(op.at, op.text);
  else d.del(op.at, op.n);
}

describe('Doc 属性:字符串参照差分', () => {
  it('随机插删序列:getText 恒等于参照拼接', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 300 }),
        fc.array(arbOp, { minLength: 1, maxLength: 120 }),
        (init, ops) => {
          const d = new Doc(init);
          let model = init;
          for (const op of ops) {
            applyDoc(d, op);
            model = applyRef(model, op);
            expect(d.getText()).toBe(model);
            expect(d.length).toBe(model.length);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('行号无空洞:lineCount/逐行/lines() 与参照行集一致', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 300 }),
        fc.array(arbOp, { minLength: 1, maxLength: 120 }),
        (init, ops) => {
          const d = new Doc(init);
          let model = init;
          for (const op of ops) {
            applyDoc(d, op);
            model = applyRef(model, op);
          }
          const refLines = model.split('\n');
          expect(d.lineCount()).toBe(refLines.length);
          expect([...d.lines()]).toEqual(refLines);
          // 逐行独立读取与 lines() 一致(行号无空洞、无错位)
          for (let n = 0; n < refLines.length; n++) {
            expect(d.getLine(n)).toBe(refLines[n]);
          }
          // 行拼接还原全文
          let rebuilt = '';
          for (let n = 0; n < d.lineCount(); n++) {
            rebuilt += d.getLine(n);
            if (n < d.lineCount() - 1) rebuilt += '\n';
          }
          expect(rebuilt).toBe(model);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('重放一致性 + 树聚合完整(validate 定期校验)', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 200 }),
        fc.array(arbOp, { minLength: 1, maxLength: 100 }),
        (init, ops) => {
          const d1 = new Doc(init);
          const d2 = new Doc(init);
          let model = init;
          ops.forEach((op, i) => {
            applyDoc(d1, op);
            applyDoc(d2, op);
            model = applyRef(model, op);
            if (i % 7 === 0) d1.validate();
          });
          d1.validate();
          d2.validate();
          expect(d1.getText()).toBe(model);
          expect(d2.getText()).toBe(model);
          expect(d1.getText()).toBe(d2.getText());
        },
      ),
      { numRuns: 200 },
    );
  });
});

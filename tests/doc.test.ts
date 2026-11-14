import { describe, expect, it } from 'vitest';
import { Doc } from '../src/doc';

describe('Doc 基础', () => {
  it('空文档', () => {
    const d = new Doc('');
    expect(d.length).toBe(0);
    expect(d.getText()).toBe('');
    expect(d.lineCount()).toBe(1);
    expect(d.getLine(0)).toBe('');
  });

  it('构造与 getText 往返', () => {
    const text = 'hello\nworld\nfoo';
    expect(new Doc(text).getText()).toBe(text);
  });

  it('头部/中部/尾部插入', () => {
    const d = new Doc('abcdef');
    d.insert(0, 'XY');   // 头部
    expect(d.getText()).toBe('XYabcdef');
    d.insert(4, 'Z');    // 中部(XYab|cdef,原坐标语义)
    expect(d.getText()).toBe('XYabZcdef');
    d.insert(d.length, '!'); // 尾部
    expect(d.getText()).toBe('XYabZcdef!');
  });

  it('空文档插入', () => {
    const d = new Doc('');
    d.insert(0, 'abc');
    expect(d.getText()).toBe('abc');
    d.insert(1, 'X');
    expect(d.getText()).toBe('aXbc');
  });

  it('删除:头部/尾部/中部/跨片/整删', () => {
    const d = new Doc('0123456789');
    d.del(0, 2); // 头部
    expect(d.getText()).toBe('23456789');
    d.del(d.length - 2, 5); // 尾部越界截断
    expect(d.getText()).toBe('234567');
    d.del(2, 2); // 中部
    expect(d.getText()).toBe('2367');
    d.del(0, d.length); // 整删
    expect(d.getText()).toBe('');
    expect(d.lineCount()).toBe(1);
  });

  it('删除区间横跨多片(反复插入制造碎片)', () => {
    const d = new Doc('');
    for (let i = 0; i < 50; i++) d.insert(d.length, String(i % 10));
    expect(d.length).toBe(50);
    d.del(10, 20); // 中间挖掉 20 个字符
    expect(d.length).toBe(30);
    let expectText = '';
    for (let i = 0; i < 50; i++) if (i < 10 || i >= 30) expectText += String(i % 10);
    expect(d.getText()).toBe(expectText);
  });

  it('insert/del 越界钳制与空操作', () => {
    const d = new Doc('abc');
    d.insert(-5, 'X');
    expect(d.getText()).toBe('Xabc');
    d.insert(100, 'Y');
    expect(d.getText()).toBe('XabcY');
    d.del(-3, 2);
    expect(d.getText()).toBe('bcY');
    d.del(0, 0);
    d.del(0, -1);
    expect(d.getText()).toBe('bcY');
    d.insert(1, '');
    expect(d.getText()).toBe('bcY');
  });
});

describe('Doc 行模型', () => {
  it('换行计数与逐行读取', () => {
    const d = new Doc('hello\nworld\n');
    expect(d.lineCount()).toBe(3);
    expect(d.getLine(0)).toBe('hello');
    expect(d.getLine(1)).toBe('world');
    expect(d.getLine(2)).toBe('');
  });

  it('单行长文本与行内定位', () => {
    const d = new Doc('x'.repeat(10000) + '\nabc');
    expect(d.lineCount()).toBe(2);
    expect(d.getLine(0)).toBe('x'.repeat(10000));
    expect(d.getLine(1)).toBe('abc');
  });

  it('getLine 越界抛 RangeError', () => {
    const d = new Doc('a\nb');
    expect(() => d.getLine(-1)).toThrow(RangeError);
    expect(() => d.getLine(2)).toThrow(RangeError);
  });

  it('lines() 迭代器与行拼接一致', () => {
    const text = 'one\ntwo\n\nfour';
    const d = new Doc(text);
    expect([...d.lines()].join('\n')).toBe(text);
  });

  it('offsetToLineCol', () => {
    const d = new Doc('ab\ncdef\n');
    expect(d.offsetToLineCol(0)).toEqual({ line: 0, col: 0 });
    expect(d.offsetToLineCol(2)).toEqual({ line: 0, col: 2 }); // '\n' 位置属于第 0 行行尾
    expect(d.offsetToLineCol(3)).toEqual({ line: 1, col: 0 });
    expect(d.offsetToLineCol(8)).toEqual({ line: 2, col: 0 });
  });

  it('lineStartOffset/lineEndOffset', () => {
    const d = new Doc('ab\ncdef\n');
    expect(d.lineStartOffset(0)).toBe(0);
    expect(d.lineEndOffset(0)).toBe(2);
    expect(d.lineStartOffset(1)).toBe(3);
    expect(d.lineEndOffset(1)).toBe(7);
    expect(d.lineStartOffset(2)).toBe(8);
    expect(d.lineEndOffset(2)).toBe(8);
  });

  it('行号无空洞:编辑后行读取仍与内容一致', () => {
    const d = new Doc('aaa\nbbb\nccc\nddd');
    d.insert(3, 'XX\n');   // aaaXX\n\nbbb...
    expect(d.getText()).toBe('aaaXX\n\nbbb\nccc\nddd');
    expect(d.lineCount()).toBe(5);
    expect(d.getLine(1)).toBe('');
    expect(d.getLine(2)).toBe('bbb');
    d.del(3, 7); // 挖掉 "XX\n\nbbb"
    expect(d.getText()).toBe('aaa\nccc\nddd');
    expect(d.lineCount()).toBe(3);
    expect(d.getLine(0)).toBe('aaa');
    expect(d.getLine(1)).toBe('ccc');
    expect(d.getLine(2)).toBe('ddd');
  });
});

describe('Doc 树完整性(validate)', () => {
  it('手工操作后聚合仍一致', () => {
    const d = new Doc('the quick brown fox\njumps over\nthe lazy dog');
    let model = 'the quick brown fox\njumps over\nthe lazy dog';
    d.insert(10, 'VERY ');
    model = model.slice(0, 10) + 'VERY ' + model.slice(10);
    expect(d.getText()).toBe(model);
    d.del(0, 4);
    model = model.slice(4);
    expect(d.getText()).toBe(model);
    d.insert(d.length, '\nnew line\n');
    model += '\nnew line\n';
    expect(d.getText()).toBe(model);
    d.del(20, 30);
    model = model.slice(0, 20) + model.slice(50);
    expect(d.getText()).toBe(model);
    d.insert(0, 'A\nB\n');
    model = 'A\nB\n' + model;
    d.validate();
    expect(d.getText()).toBe(model);
  });

  it('碎片化压力后 validate 通过', () => {
    // 种子化 LCG 保证可复现(数据生成用,非加密用途);乘法用 imul 防 2^53 精度丢失
    let s = 0x2545f491;
    const rnd = (): number => {
      s = (Math.imul(s, 1103515245) + 12345) | 0;
      return ((s >>> 16) & 0x7fff) / 32768;
    };
    const d = new Doc('0123456789'.repeat(50));
    for (let i = 0; i < 200; i++) {
      const at = Math.floor(rnd() * (d.length + 1));
      d.insert(at, 'ab');
      d.del(Math.floor(rnd() * d.length), 3);
    }
    d.validate();
  });
});

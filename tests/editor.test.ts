import { describe, expect, it } from 'vitest';
import { Editor } from '../src/editor';

/** 构造单光标编辑器,光标定位到 pos */
function ed1(text: string, pos = 0, opts?: { mergeTimeoutMs?: number }): Editor {
  const ed = new Editor(text, opts);
  ed.setSelections([{ anchor: pos, active: pos }]);
  return ed;
}

describe('undo 合并规则(专项 ≥15 条)', () => {
  it('1. 连续字符输入合并为一个事务', () => {
    const ed = ed1('');
    ed.type('a'); ed.type('b'); ed.type('c');
    expect(ed.undoDepth).toBe(1);
    expect(ed.doc.getText()).toBe('abc');
    ed.undo();
    expect(ed.doc.getText()).toBe('');
    expect(ed.canUndo()).toBe(false);
  });

  it('2. 换行断开合并:type 换行后各自独立', () => {
    const ed = ed1('');
    ed.type('ab'); ed.type('\n'); ed.type('c');
    expect(ed.undoDepth).toBe(3);
    ed.undo(); // 撤销 'c'
    expect(ed.doc.getText()).toBe('ab\n');
    ed.undo(); // 撤销 '\n'
    expect(ed.doc.getText()).toBe('ab');
    ed.undo(); // 撤销 'ab'
    expect(ed.doc.getText()).toBe('');
  });

  it('3. 光标移动断开合并', () => {
    const ed = ed1('xxxx');
    ed.setSelections([{ anchor: 0, active: 0 }]);
    ed.type('ab');
    ed.setSelections([{ anchor: 4, active: 4 }]);
    ed.type('cd');
    expect(ed.undoDepth).toBe(2);
    expect(ed.doc.getText()).toBe('abxxcdxx');
    ed.undo();
    expect(ed.doc.getText()).toBe('abxxxx');
  });

  it('4. insert() 原语恒独立,且其后输入不再合并', () => {
    const ed = ed1('');
    ed.type('a');
    ed.insert('X'); // 原语插入:独立事务
    ed.type('b');
    expect(ed.undoDepth).toBe(3);
    ed.undo();
    expect(ed.doc.getText()).toBe('aX');
    ed.undo();
    expect(ed.doc.getText()).toBe('a');
  });

  it('5. 输入与删除类型切换断开', () => {
    const ed = ed1('hello');
    ed.setSelections([{ anchor: 5, active: 5 }]);
    ed.type('!!');
    ed.backspace();
    expect(ed.undoDepth).toBe(2);
    ed.undo();
    expect(ed.doc.getText()).toBe('hello!!');
  });

  it('6. 连续退格合并为一个事务', () => {
    const ed = ed1('abcde');
    ed.setSelections([{ anchor: 5, active: 5 }]);
    ed.backspace(); ed.backspace(); ed.backspace();
    expect(ed.undoDepth).toBe(1);
    expect(ed.doc.getText()).toBe('ab');
    ed.undo();
    expect(ed.doc.getText()).toBe('abcde');
    expect(ed.cursors).toEqual([{ anchor: 5, active: 5 }]);
  });

  it('7. 退格后输入:类型切换各自独立', () => {
    const ed = ed1('abcd');
    ed.setSelections([{ anchor: 4, active: 4 }]);
    ed.backspace(); ed.backspace(); // 删 'cd'
    ed.type('XY');
    expect(ed.undoDepth).toBe(2);
    expect(ed.doc.getText()).toBe('abXY');
    ed.undo();
    expect(ed.doc.getText()).toBe('ab');
    ed.undo();
    expect(ed.doc.getText()).toBe('abcd');
  });

  it('8. markCheckpoint 断开合并', () => {
    const ed = ed1('');
    ed.type('ab');
    ed.markCheckpoint();
    ed.type('cd');
    expect(ed.undoDepth).toBe(2);
    ed.undo();
    expect(ed.doc.getText()).toBe('ab');
    ed.redo();
    expect(ed.doc.getText()).toBe('abcd');
  });

  it('9. undo 后新输入不与撤销前合并,且 redo 被截断', () => {
    const ed = ed1('');
    ed.type('ab');
    ed.undo();
    ed.type('c');
    expect(ed.undoDepth).toBe(1);
    expect(ed.canRedo()).toBe(false);
    expect(ed.doc.getText()).toBe('c');
    ed.undo();
    expect(ed.doc.getText()).toBe('');
  });

  it('10. mergeTimeoutMs=0:严格超时断开(确定性)', () => {
    const ed = ed1('', 2, { mergeTimeoutMs: 0 });
    ed.type('a'); ed.type('b');
    expect(ed.undoDepth).toBe(2);
  });

  it('11. mergeTimeoutMs=Infinity:永不因时间断开', () => {
    const ed = ed1('', 0, { mergeTimeoutMs: Infinity });
    ed.type('a'); ed.type('b'); ed.type('c');
    expect(ed.undoDepth).toBe(1);
  });

  it('12. 默认超时(1000ms)内合并', () => {
    const ed = ed1('');
    ed.type('a'); ed.type('b');
    expect(ed.undoDepth).toBe(1);
  });

  it('13. 一次 type 含换行:独立且后继不合并', () => {
    const ed = ed1('');
    ed.type('a\nb');
    ed.type('c');
    expect(ed.undoDepth).toBe(2);
    ed.undo();
    expect(ed.doc.getText()).toBe('a\nb');
    ed.undo();
    expect(ed.doc.getText()).toBe('');
  });

  it('14. 多光标输入不参与合并', () => {
    const ed = ed1('----');
    ed.setSelections([{ anchor: 2, active: 2 }, { anchor: 4, active: 4 }]);
    ed.type('x'); ed.type('y');
    expect(ed.undoDepth).toBe(2);
    ed.undo();
    ed.undo();
    expect(ed.doc.getText()).toBe('----');
  });

  it('15. 选择区替换(type 过选择)不合并', () => {
    const ed = ed1('hello world');
    ed.setSelections([{ anchor: 0, active: 5 }]);
    ed.type('HOWDY');
    ed.type('!');
    expect(ed.undoDepth).toBe(2);
    ed.undo();
    expect(ed.doc.getText()).toBe('HOWDY world');
    ed.undo();
    expect(ed.doc.getText()).toBe('hello world');
  });

  it('16. 退格连续性被光标移动打断', () => {
    const ed = ed1('abcdef');
    ed.setSelections([{ anchor: 3, active: 3 }]);
    ed.backspace();
    ed.setSelections([{ anchor: 1, active: 1 }]);
    ed.backspace();
    expect(ed.undoDepth).toBe(2);
  });

  it('17. undo/redo 互逆且 redo 到头停止', () => {
    const ed = ed1('');
    ed.type('ab');
    ed.backspace();
    expect(ed.doc.getText()).toBe('a');
    ed.undo();
    expect(ed.doc.getText()).toBe('ab');
    ed.redo();
    expect(ed.doc.getText()).toBe('a');
    expect(ed.canRedo()).toBe(false);
    ed.redo(); // 空转
    expect(ed.doc.getText()).toBe('a');
  });

  it('18. 列 0 退格空转:不产生事务', () => {
    const ed = ed1('abc');
    ed.backspace();
    expect(ed.undoDepth).toBe(0);
    expect(ed.canUndo()).toBe(false);
    expect(ed.doc.getText()).toBe('abc');
  });

  it('19. 跨类型混合序列的事务边界(输入/删除/输入)', () => {
    const ed = ed1('');
    ed.type('ab');
    ed.backspace();
    ed.type('c');
    expect(ed.undoDepth).toBe(3);
    ed.undo();
    expect(ed.doc.getText()).toBe('a');
    ed.undo();
    expect(ed.doc.getText()).toBe('ab');
    ed.undo();
    expect(ed.doc.getText()).toBe('');
  });

  it('20. 合并事务一次 undo 撤销全部连续输入', () => {
    const ed = ed1('');
    for (let i = 0; i < 26; i++) ed.type(String.fromCharCode(97 + i));
    expect(ed.undoDepth).toBe(1);
    ed.undo();
    expect(ed.doc.getText()).toBe('');
    expect(ed.cursors).toEqual([{ anchor: 0, active: 0 }]);
  });
});

describe('多光标不变量', () => {
  it('anchor > active 自动翻转(anchor <= active 恒成立)', () => {
    const ed = ed1('hello');
    ed.setSelections([{ anchor: 4, active: 1 }]);
    expect(ed.cursors).toEqual([{ anchor: 1, active: 4 }]);
  });

  it('同位置光标去重', () => {
    const ed = ed1('hello');
    ed.setSelections([{ anchor: 2, active: 2 }, { anchor: 2, active: 2 }, { anchor: 3, active: 3 }]);
    expect(ed.cursors).toEqual([{ anchor: 2, active: 2 }, { anchor: 3, active: 3 }]);
  });

  it('真重叠选择区合并;端点相接不合并', () => {
    const ed = ed1('hello world');
    ed.setSelections([{ anchor: 1, active: 5 }, { anchor: 3, active: 7 }]);
    expect(ed.cursors).toEqual([{ anchor: 1, active: 7 }]);
    ed.setSelections([{ anchor: 1, active: 3 }, { anchor: 3, active: 5 }]);
    expect(ed.cursors).toEqual([{ anchor: 1, active: 3 }, { anchor: 3, active: 5 }]);
  });

  it('空输入回落为单光标', () => {
    const ed = ed1('hello');
    ed.setSelections([]);
    expect(ed.cursors).toEqual([{ anchor: 0, active: 0 }]);
  });

  it('双光标同插:后序光标偏移自动修正', () => {
    const ed = ed1('abcdef');
    ed.setSelections([{ anchor: 2, active: 2 }, { anchor: 5, active: 5 }]);
    ed.insert('X');
    // 原坐标语义:光标2 的 X 落在 2,光标5 的 X 被前一次插入推到 6
    expect(ed.doc.getText()).toBe('abXcdeXf');
    expect(ed.cursors).toEqual([{ anchor: 3, active: 3 }, { anchor: 7, active: 7 }]);
  });

  it('双光标相邻同插:降序应用,位置各自落在插入文本后', () => {
    const ed = ed1('abcd');
    ed.setSelections([{ anchor: 2, active: 2 }, { anchor: 3, active: 3 }]);
    ed.insert('x');
    expect(ed.doc.getText()).toBe('abxcxd');
    expect(ed.cursors).toEqual([{ anchor: 3, active: 3 }, { anchor: 5, active: 5 }]);
  });

  it('双光标退格:删除区间互不相交', () => {
    const ed = ed1('abcdefg');
    ed.setSelections([{ anchor: 3, active: 3 }, { anchor: 7, active: 7 }]);
    ed.backspace();
    expect(ed.doc.getText()).toBe('abdef');
    expect(ed.cursors).toEqual([{ anchor: 2, active: 2 }, { anchor: 5, active: 5 }]);
  });

  it('列 0 光标退格空转,另一光标正常编辑', () => {
    const ed = ed1('abc');
    ed.setSelections([{ anchor: 0, active: 0 }, { anchor: 3, active: 3 }]);
    ed.backspace();
    expect(ed.doc.getText()).toBe('ab');
    expect(ed.cursors).toEqual([{ anchor: 0, active: 0 }, { anchor: 2, active: 2 }]);
  });

  it('同偏移的普通光标与选择区光标共存编辑(含 undo/redo 往返)', () => {
    const ed = ed1('abcdef');
    ed.setSelections([{ anchor: 2, active: 2 }, { anchor: 2, active: 5 }]);
    ed.type('Q'); // 选择区替换 + 普通插入,两变更同偏移
    expect(ed.doc.getText()).toBe('abQQf');
    expect(ed.cursors).toEqual([{ anchor: 3, active: 3 }, { anchor: 4, active: 4 }]);
    ed.undo();
    expect(ed.doc.getText()).toBe('abcdef');
    ed.redo();
    expect(ed.doc.getText()).toBe('abQQf');
    expect(ed.cursors).toEqual([{ anchor: 3, active: 3 }, { anchor: 4, active: 4 }]);
  });

  it('带选择区的双光标同插(替换)', () => {
    const ed = ed1('one two');
    ed.setSelections([{ anchor: 0, active: 3 }, { anchor: 4, active: 7 }]);
    ed.type('1');
    expect(ed.doc.getText()).toBe('1 1');
    expect(ed.cursors).toEqual([{ anchor: 1, active: 1 }, { anchor: 3, active: 3 }]);
  });

  it('多光标编辑的 undo 一次回滚全部光标变更', () => {
    const ed = ed1('----');
    ed.setSelections([{ anchor: 2, active: 2 }, { anchor: 4, active: 4 }]);
    ed.insert('Q');
    expect(ed.doc.getText()).toBe('--Q--Q');
    expect(ed.cursors).toEqual([{ anchor: 3, active: 3 }, { anchor: 6, active: 6 }]);
    ed.undo();
    expect(ed.doc.getText()).toBe('----');
    expect(ed.cursors).toEqual([{ anchor: 2, active: 2 }, { anchor: 4, active: 4 }]);
    ed.redo();
    expect(ed.doc.getText()).toBe('--Q--Q');
    expect(ed.cursors).toEqual([{ anchor: 3, active: 3 }, { anchor: 6, active: 6 }]);
  });
});

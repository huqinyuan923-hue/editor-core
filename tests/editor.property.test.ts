import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Editor } from '../src/editor';
import type { Sel } from '../src/editor';

/**
 * 验收 #1/#2/#3:朴素字符串参照模型差分。
 *
 * 参照模型与被测 Editor 机制完全不同:
 * - 文本 = 直接字符串拼接;
 * - undo = "每个事务后的完整状态快照"恢复(Editor 是变更反演重放);
 * - 合并规则按同一份规格(连续输入合并/换行·超时·类型切换·checkpoint 断开)独立实现。
 *
 * 每一步之后逐字段对照:getText / cursors / canUndo / canRedo / undoDepth / redoDepth。
 * 全文件累计随机步数 ≥ 100000(文件尾有断言)。
 */

// ---------- 参照模型 ----------

interface RSel { anchor: number; active: number }
interface RChange { o: number; d: number; del: string; ins: string }
interface RSnap { text: string; cursors: RSel[] }

interface RTxn {
  kind: 'insert' | 'delete';
  mergeable: boolean;
  changes: RChange[];
  single: boolean; // 单光标单变更(可合并前提)
  t: number;
  before: RSnap; // 事务前完整快照(setSelections 不建事务,故必须在编辑时点抓取)
  after: RSnap;  // 事务后完整快照
}

class RefEditor {
  text: string;
  cursors: RSel[];
  stack: RTxn[] = [];
  ptr = 0;
  forceBreak = false;
  timeout: number;
  lastT = 0;

  constructor(text: string, timeout: number) {
    this.text = text;
    this.cursors = [{ anchor: 0, active: 0 }];
    this.timeout = timeout;
  }

  private cloneCursors(): RSel[] {
    return this.cursors.map((c) => ({ ...c }));
  }
  private snap(): RSnap {
    return { text: this.text, cursors: this.cloneCursors() };
  }

  setSelections(sels: { anchor: number; active: number }[]): void {
    const norm = sels.map((s) => ({
      anchor: Math.min(s.anchor, s.active),
      active: Math.max(s.anchor, s.active),
    }));
    norm.sort((a, b) => a.anchor - b.anchor || a.active - b.active);
    const merged: RSel[] = [];
    for (const s of norm) {
      const last = merged[merged.length - 1];
      if (last && s.anchor < last.active) {
        last.active = Math.max(last.active, s.active);
      } else if (!last || last.anchor !== s.anchor || last.active !== s.active) {
        merged.push({ ...s });
      }
    }
    this.cursors = merged.length > 0 ? merged : [{ anchor: 0, active: 0 }];
  }

  insert(text: string): void {
    this.editAll('insert', false, text);
  }
  type(text: string): void {
    if (text.length === 0) return;
    this.editAll('insert', true, text);
  }
  backspace(): void {
    const before = this.cloneCursors();
    const raw: { owner: number; c: RChange }[] = [];
    this.cursors.forEach((c, i) => {
      if (c.anchor < c.active) {
        raw.push({ owner: i, c: { o: c.anchor, d: c.active - c.anchor, del: '', ins: '' } });
      } else if (c.active > 0) {
        raw.push({ owner: i, c: { o: c.active - 1, d: 1, del: '', ins: '' } });
      }
    });
    this.commit('delete', true, before, raw);
  }
  markCheckpoint(): void {
    this.forceBreak = true;
  }

  private editAll(kind: 'insert' | 'delete', mergeable: boolean, text: string): void {
    const before = this.cloneCursors();
    const raw = this.cursors.map((c, i) => ({
      owner: i,
      c: { o: c.anchor, d: c.active - c.anchor, del: '', ins: text } as RChange,
    }));
    this.commit(kind, mergeable, before, raw);
  }

  private commit(
    kind: 'insert' | 'delete',
    mergeable: boolean,
    before: RSel[],
    raw: { owner: number; c: RChange }[],
  ): void {
    if (raw.length === 0) return;
    const textBefore = this.text;
    const snapBefore = this.snap();
    raw.sort((a, b) => a.c.o - b.c.o);
    // 合并真重叠的变更(与 Editor 同一规格)
    const changes: RChange[] = [];
    const ownerMerged: number[] = [];
    raw.forEach((e) => {
      const last = changes[changes.length - 1];
      if (last && e.c.o < last.o + last.d) {
        last.ins += e.c.ins;
        last.d = Math.max(last.o + last.d, e.c.o + e.c.d) - last.o;
        ownerMerged.push(changes.length - 1);
      } else {
        changes.push({ o: e.c.o, d: e.c.d, del: '', ins: e.c.ins });
        ownerMerged.push(changes.length - 1);
      }
    });
    for (let i = changes.length - 1; i >= 0; i--) {
      const c = changes[i]!;
      c.del = this.text.slice(c.o, c.o + c.d);
      this.text = this.text.slice(0, c.o) + c.ins + this.text.slice(c.o + c.d);
    }
    const posts: number[] = [];
    let shift = 0;
    for (const c of changes) {
      posts.push(c.o + c.ins.length + shift);
      shift += c.ins.length - c.d;
    }
    const after: RSel[] = new Array(before.length);
    raw.forEach((e, ri) => {
      const p = posts[ownerMerged[ri]!]!;
      after[e.owner] = { anchor: p, active: p };
    });
    for (let i = 0; i < before.length; i++) {
      if (after[i] === undefined) {
        const b = before[i]!;
        const sh = (e: number): number => {
          let s = 0;
          for (const c of changes) if (c.o + c.d <= e) s += c.ins.length - c.d;
          return s;
        };
        after[i] = { anchor: b.anchor + sh(b.anchor), active: b.active + sh(b.active) };
      }
    }
    for (const s of after) {
      if (s.anchor > s.active) {
        const t = s.anchor;
        s.anchor = s.active;
        s.active = t;
      }
    }
    after.sort((x, y) => x.active - y.active || x.anchor - y.anchor);
    const dedup: RSel[] = [];
    for (const s of after) {
      const last = dedup[dedup.length - 1];
      if (!last || last.anchor !== s.anchor || last.active !== s.active) {
        dedup.push({ ...s });
      }
    }
    this.cursors = dedup.length > 0 ? dedup : [{ anchor: 0, active: 0 }];
    this.record(kind, mergeable, changes, before.length === 1, snapBefore, this.snap());
  }

  private record(
    kind: 'insert' | 'delete',
    mergeable: boolean,
    changes: RChange[],
    beforeSingle: boolean,
    snapBefore: RSnap,
    snapAfter: RSnap,
  ): void {
    const now = Date.now();
    const top = this.ptr > 0 ? this.stack[this.ptr - 1]! : null;
    const single = changes.length === 1 && beforeSingle;
    const canMerge =
      !this.forceBreak &&
      mergeable &&
      top !== null &&
      top.mergeable &&
      top.kind === kind &&
      top.single &&
      single &&
      now - top.t < this.timeout;
    if (canMerge && kind === 'insert') {
      const c = changes[0]!;
      const tc = top.changes[0]!;
      if (c.d === 0 && tc.d === 0 && !c.ins.includes('\n') && !tc.ins.includes('\n') &&
          c.o === tc.o + tc.ins.length) {
        tc.ins += c.ins;
        top.after = snapAfter;
        this.lastT = now;
        this.forceBreak = false;
        return;
      }
    }
    if (canMerge && kind === 'delete') {
      const c = changes[0]!;
      const tc = top.changes[0]!;
      if (c.ins === '' && c.d === 1 && tc.ins === '' && c.o + c.d === tc.o) {
        tc.o = c.o;
        tc.d += c.d;
        tc.del = c.del + tc.del;
        top.after = snapAfter;
        this.lastT = now;
        this.forceBreak = false;
        return;
      }
    }
    this.stack = this.stack.slice(0, this.ptr);
    this.stack.push({ kind, mergeable, changes, single, t: now, before: snapBefore, after: snapAfter });
    this.ptr = this.stack.length;
    this.lastT = now;
    this.forceBreak = false;
  }

  undo(): void {
    if (this.ptr === 0) return;
    this.ptr--;
    const s = this.stack[this.ptr]!.before;
    this.text = s.text;
    this.cursors = s.cursors.map((c) => ({ ...c }));
    this.forceBreak = true;
  }

  redo(): void {
    if (this.ptr >= this.stack.length) return;
    const s = this.stack[this.ptr]!.after;
    this.text = s.text;
    this.cursors = s.cursors.map((c) => ({ ...c }));
    this.ptr++;
    this.forceBreak = true;
  }

  canUndo(): boolean {
    return this.ptr > 0;
  }
  canRedo(): boolean {
    return this.ptr < this.stack.length;
  }
}

// ---------- 命令生成与执行 ----------

type Cmd =
  | { t: 'sel'; pairs: [number, number][] }
  | { t: 'type'; text: string }
  | { t: 'insert'; text: string }
  | { t: 'bs' }
  | { t: 'undo' }
  | { t: 'redo' }
  | { t: 'cp' };

const counter = { steps: 0 };

const arbCmd: fc.Arbitrary<Cmd> = fc.oneof(
  fc.record({
    t: fc.constant<'sel'>('sel'),
    pairs: fc.array(fc.tuple(fc.nat({ max: 400 }), fc.nat({ max: 400 })), { minLength: 1, maxLength: 4 }),
  }),
  fc.record({ t: fc.constant<'type'>('type'), text: fc.string({ maxLength: 8 }) }),
  fc.record({ t: fc.constant<'insert'>('insert'), text: fc.string({ maxLength: 8 }) }),
  fc.constant<Cmd>({ t: 'bs' }),
  fc.constant<Cmd>({ t: 'undo' }),
  fc.constant<Cmd>({ t: 'redo' }),
  fc.constant<Cmd>({ t: 'cp' }),
);

const arbCmds = (min: number, max: number): fc.Arbitrary<Cmd[]> =>
  fc.array(arbCmd, { minLength: min, maxLength: max });

function cmp(ed: Editor, ref: RefEditor, ctx: string): void {
  const et = ed.doc.getText();
  if (et !== ref.text) {
    throw new Error(`[${ctx}] 文本不一致\n editor: ${JSON.stringify(et)}\n ref   : ${JSON.stringify(ref.text)}`);
  }
  const ec = ed.cursors.map((c) => ({ anchor: c.anchor, active: c.active }));
  if (JSON.stringify(ec) !== JSON.stringify(ref.cursors)) {
    throw new Error(`[${ctx}] 光标不一致\n editor: ${JSON.stringify(ec)}\n ref   : ${JSON.stringify(ref.cursors)}\n text  : ${JSON.stringify(et)}`);
  }
  if (ed.canUndo() !== ref.canUndo() || ed.canRedo() !== ref.canRedo()) {
    throw new Error(`[${ctx}] canUndo/canRedo 不一致 editor=(${ed.canUndo()},${ed.canRedo()}) ref=(${ref.canUndo()},${ref.canRedo()})`);
  }
  if (ed.undoDepth !== ref.ptr || ed.redoDepth !== ref.stack.length - ref.ptr) {
    throw new Error(`[${ctx}] undo 栈深不一致 editor=(${ed.undoDepth},${ed.redoDepth}) ref=(${ref.ptr},${ref.stack.length - ref.ptr})`);
  }
}

function runCmd(ed: Editor, ref: RefEditor, cmd: Cmd): void {
  switch (cmd.t) {
    case 'sel': {
      const sels: Sel[] = cmd.pairs.map(([a, b]) => ({
        anchor: Math.min(a, ref.text.length),
        active: Math.min(b, ref.text.length),
      }));
      ed.setSelections(sels);
      ref.setSelections(sels);
      break;
    }
    case 'type': ed.type(cmd.text); ref.type(cmd.text); break;
    case 'insert': ed.insert(cmd.text); ref.insert(cmd.text); break;
    case 'bs': ed.backspace(); ref.backspace(); break;
    case 'undo': ed.undo(); ref.undo(); break;
    case 'redo': ed.redo(); ref.redo(); break;
    case 'cp': ed.markCheckpoint(); ref.markCheckpoint(); break;
  }
  counter.steps++;
}

const INIT = 'the quick brown fox\njumps over\nthe lazy dog';

// ---------- 属性 ----------

describe('Editor 差分(朴素字符串参照,≥10 万步)', () => {
  it('全命令差分:含 undo/redo/checkpoint 的混合随机序列', () => {
    fc.assert(
      fc.property(arbCmds(80, 180), (cmds) => {
        const ed = new Editor(INIT, { mergeTimeoutMs: Infinity });
        const ref = new RefEditor(INIT, Infinity);
        cmp(ed, ref, '初始');
        for (const cmd of cmds) {
          runCmd(ed, ref, cmd);
          cmp(ed, ref, `step#${counter.steps}@${cmd.t}`);
        }
      }),
      { numRuns: 350 },
    );
  }, 300_000);

  it('无 undo 差分:深编辑序列压住文档碎片化', () => {
    fc.assert(
      fc.property(arbCmds(120, 250), (cmds) => {
        const ed = new Editor(INIT, { mergeTimeoutMs: Infinity });
        const ref = new RefEditor(INIT, Infinity);
        for (const cmd of cmds) {
          if (cmd.t === 'undo' || cmd.t === 'redo') continue;
          runCmd(ed, ref, cmd);
          cmp(ed, ref, `plain#${counter.steps}@${cmd.t}`);
        }
      }),
      { numRuns: 300 },
    );
  }, 300_000);

  it('undo 回放至空 = 初始态;redo 全量 = 编辑终态(验收 #2)', () => {
    fc.assert(
      fc.property(arbCmds(150, 250), (cmds) => {
        const ed = new Editor(INIT, { mergeTimeoutMs: Infinity });
        const ref = new RefEditor(INIT, Infinity);
        for (const cmd of cmds) {
          if (cmd.t === 'undo' || cmd.t === 'redo') continue;
          runCmd(ed, ref, cmd);
          cmp(ed, ref, `replay#${counter.steps}@${cmd.t}`);
        }
        const finalText = ed.doc.getText();
        // undo 回放至空:文本 = 初始;光标 = 第一次编辑前的状态(含此前的 setSelections)
        while (ed.canUndo()) { ed.undo(); ref.undo(); cmp(ed, ref, `undoall#${counter.steps}`); }
        expect(ed.doc.getText()).toBe(INIT);
        expect(ref.text).toBe(INIT);
        // redo 全量:文本 = 编辑终态(最后一次编辑后的纯 setSelections 不属于任何事务,
        // redo 恢复到的是最后事务的 after 快照——cmp 逐步保证了两侧一致)
        while (ed.canRedo()) { ed.redo(); ref.redo(); cmp(ed, ref, `redoall#${counter.steps}`); }
        expect(ed.doc.getText()).toBe(finalText);
        expect(ref.text).toBe(finalText);
      }),
      { numRuns: 230 },
    );
  }, 300_000);

  it('累计随机步数 ≥ 100000', () => {
    console.log(`差分总步数: ${counter.steps}`);
    expect(counter.steps).toBeGreaterThanOrEqual(100000);
  });
});

/**
 * 编辑器:Doc + 多光标集合 + 编辑原语 + undo/redo 合并栈。
 *
 * 多光标模型(规范化不变量):
 * - 每个光标 { anchor, active },恒满足 anchor <= active(setSelections 自动翻转);
 * - 光标按 (anchor, active) 升序存放,同一位置的光标去重;
 * - setSelections 会合并"真重叠"的选择区(next.anchor < cur.active),
 *   端点相接(如选择区 [1,3) 与光标 3)不合并,保持两个独立光标。
 *
 * 编辑语义(对标 VS Code):
 * - 所有光标同插/同删,各光标的变更在"编辑前坐标"中互不相交(重叠已被 setSelections 排除);
 * - 变更按偏移降序应用到 Doc,因此先处理靠后的光标不影响靠前的偏移;
 * - 编辑后光标位置 = o + ins - d + (其前方所有变更的净位移),再按位置去重;
 * - 纯插入/删除的类型切换、换行、超时、checkpoint 均断开 undo 合并(见 type/backspace)。
 *
 * undo 记录:每个事务 = 变更列表(前坐标 { o, 删除文本, 插入文本 }) + 前后光标快照。
 * undo 按偏移降序"删掉插入文本、还回删除文本";redo 正向重放。
 */

import { Doc } from './doc';

export interface Sel {
  anchor: number;
  active: number;
}

/** 单个变更(编辑前坐标):删除 [o, o+d) 并插入 ins;del 为被删原文(undo 用) */
interface Change {
  o: number;
  d: number;
  del: string;
  ins: string;
}

/** 对 Doc 的单个原始操作(应用序);undo/redo 以操作序列为单位回放 */
interface DocOp {
  o: number;
  /** 非空 = 本次是删除该文本(undo 时原样插回) */
  del: string | null;
  /** 非空 = 本次是插入该文本(undo 时按长度删掉) */
  ins: string | null;
}

/** 一个 undo 事务 */
interface Txn {
  kind: 'insert' | 'delete';
  changes: Change[];
  ops: DocOp[]; // 按 Doc 应用顺序记录(del 在前,ins 在后;变更按偏移降序)
  before: Sel[];
  after: Sel[];
  mergeable: boolean; // 是否允许与后续同类事务合并(insert() 原语恒为 false)
  t: number;          // 事务时间戳(超时断开合并)
}

function eqSels(a: Sel[], b: Sel[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.anchor !== b[i]!.anchor || a[i]!.active !== b[i]!.active) return false;
  }
  return true;
}

export class Editor {
  readonly doc: Doc;
  cursors: Sel[];
  /** 连续输入合并的超时(毫秒);Infinity 表示永不因时间断开 */
  mergeTimeoutMs: number;

  private stack: Txn[] = [];
  private ptr = 0;          // 下一个 redo 的事务下标(= 可 undo 数量)
  private stackLen = 0;     // 有效栈长(压栈原地覆写,惰性丢弃 redo 分支,避免整栈复制)
  private forceBreak = false; // checkpoint/undo/redo 后断开合并

  constructor(text: string, opts?: { mergeTimeoutMs?: number }) {
    this.doc = new Doc(text);
    this.mergeTimeoutMs = opts?.mergeTimeoutMs ?? 1000;
    this.cursors = [{ anchor: 0, active: 0 }];
  }

  // ---------- 光标管理 ----------

  /** 设置光标/选择区:规范化(anchor<=active)、排序、真重叠合并、去重;空输入回落为单个光标 */
  setSelections(sels: Sel[]): void {
    const norm = sels.map((s) => ({
      anchor: Math.min(s.anchor, s.active),
      active: Math.max(s.anchor, s.active),
    }));
    norm.sort((a, b) => a.anchor - b.anchor || a.active - b.active);
    const merged: Sel[] = [];
    for (const s of norm) {
      const last = merged[merged.length - 1];
      // 真重叠(下一选择起点严格落在当前选择区间内)才并区;端点相接不并
      if (last && s.anchor < last.active) {
        last.active = Math.max(last.active, s.active);
      } else if (!last || last.anchor !== s.anchor || last.active !== s.active) {
        merged.push({ ...s });
      }
    }
    this.cursors = merged.length > 0 ? merged : [{ anchor: 0, active: 0 }];
  }

  // ---------- 编辑原语 ----------

  /** 所有光标插入(带选择区则替换):独立事务,不参与合并 */
  insert(text: string): void {
    this.applyEdit('insert', false, text);
  }

  /** 打字输入:触发 undo 合并规则(连续字符合并;含换行断开;类型切换断开) */
  type(text: string): void {
    if (text.length === 0) return;
    // 含换行的输入自身可并入前序,但不可被后续合并(换行向断开)
    this.applyEdit('insert', !text.includes('\n'), text);
  }

  /** 退格:有选择区删选择区;否则删光标前一字符(列 0 的光标不动) */
  backspace(): void {
    const before = this.cursors.map((c) => ({ ...c }));
    const raw: { owner: number; c: Change }[] = [];
    for (let i = 0; i < this.cursors.length; i++) {
      const c = this.cursors[i]!;
      if (c.anchor < c.active) {
        raw.push({ owner: i, c: { o: c.anchor, d: c.active - c.anchor, del: '', ins: '' } });
      } else if (c.active > 0) {
        raw.push({ owner: i, c: { o: c.active - 1, d: 1, del: '', ins: '' } });
      }
    }
    this.commit('delete', true, before, raw);
  }

  /** 内部:所有光标插入同一文本(type/insert 共用) */
  private applyEdit(kind: 'insert', mergeable: boolean, text: string): void {
    const before = this.cursors.map((c) => ({ ...c }));
    const raw: { owner: number; c: Change }[] = this.cursors.map((c, i) => ({
      owner: i,
      c: { o: c.anchor, d: c.active - c.anchor, del: '', ins: text },
    }));
    this.commit(kind, mergeable, before, raw);
  }

  // ---------- 变更落盘 + 事务记录 ----------

  private commit(
    kind: 'insert' | 'delete',
    mergeable: boolean,
    before: Sel[],
    raw: { owner: number; c: Change }[],
  ): void {
    if (raw.length === 0) return; // backspace 全部空转
    raw.sort((a, b) => a.c.o - b.c.o); // 稳定排序
    // 合并真重叠的变更(例:退格光标恰在他人选择区末尾时,其删除区间会越入选择区)。
    // 端点相接不合并;被合并的插入文本按偏移升序拼接。
    const changes: Change[] = [];
    const ownerMerged: number[] = []; // raw 下标 → 合并后变更下标
    raw.forEach((e, ri) => {
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
    // 抓取被删原文(前坐标,合并后区间),再按偏移降序应用;同时记录原始操作序列
    for (const c of changes) {
      if (c.d > 0) c.del = this.doc.getRange(c.o, c.d);
    }
    const ops: DocOp[] = [];
    for (let i = changes.length - 1; i >= 0; i--) {
      const c = changes[i]!;
      if (c.d > 0) {
        this.doc.del(c.o, c.d);
        ops.push({ o: c.o, del: c.del, ins: null });
      }
      if (c.ins.length > 0) {
        this.doc.insert(c.o, c.ins);
        ops.push({ o: c.o, del: null, ins: c.ins });
      }
    }
    // 编辑后光标位置 = o + ins + 前方变更净位移(升序累加,与最终坐标一致):
    // 纯插入落在插入文本末尾,删除落在删除点,替换落在替换文本末尾——统一为 o+ins。
    const posts: number[] = [];
    let shift = 0;
    for (const c of changes) {
      posts.push(c.o + c.ins.length + shift);
      shift += c.ins.length - c.d;
    }
    const after: Sel[] = new Array(before.length);
    raw.forEach((e, ri) => {
      const p = posts[ownerMerged[ri]!]!;
      after[e.owner] = { anchor: p, active: p };
    });
    // 未参与变更的光标(backspace 在列 0 空转):两端按净位移平移
    for (let i = 0; i < before.length; i++) {
      if (after[i] === undefined) {
        const b = before[i]!;
        after[i] = {
          anchor: b.anchor + this.shiftOf(changes, b.anchor),
          active: b.active + this.shiftOf(changes, b.active),
        };
      }
    }
    // 规范化(anchor<=active)、排序、按位置去重
    for (const s of after) {
      if (s.anchor > s.active) {
        const t = s.anchor;
        s.anchor = s.active;
        s.active = t;
      }
    }
    after.sort((x, y) => x.active - y.active || x.anchor - y.anchor);
    const dedup: Sel[] = [];
    for (const s of after) {
      const last = dedup[dedup.length - 1];
      if (!last || last.anchor !== s.anchor || last.active !== s.active) {
        dedup.push({ anchor: s.anchor, active: s.active });
      }
    }
    this.cursors = dedup.length > 0 ? dedup : [{ anchor: 0, active: 0 }];

    this.record(kind, mergeable, before, changes, ops, this.cursors.map((c) => ({ ...c })));
  }

  /** 偏移 e 前方(区间终点 <= e)的净位移 */
  private shiftOf(changes: Change[], e: number): number {
    let s = 0;
    for (const c of changes) {
      if (c.o + c.d <= e) s += c.ins.length - c.d;
    }
    return s;
  }

  // ---------- undo/redo ----------

  private record(
    kind: 'insert' | 'delete',
    mergeable: boolean,
    before: Sel[],
    changes: Change[],
    ops: DocOp[],
    after: Sel[],
  ): void {
    const now = Date.now();
    const top = this.ptr > 0 ? this.stack[this.ptr - 1]! : null;
    const canMerge =
      !this.forceBreak &&
      mergeable &&
      top !== null &&
      top.mergeable &&
      top.kind === kind &&
      before.length === 1 &&
      top.before.length === 1 &&
      changes.length === 1 &&
      top.changes.length === 1 &&
      now - top.t < this.mergeTimeoutMs; // 严格小于:timeout=0 时同毫秒也不合并
    if (canMerge && kind === 'insert') {
      const c = changes[0]!;
      const tc = top.changes[0]!;
      // 连续追加:本次插入点必须正好在先前插入文本末尾(不含换行才可合并,
      // 而合并链上的文本由 type() 构造保证无换行,故无需重复扫描累积串)
      if (c.d === 0 && tc.d === 0 && !c.ins.includes('\n') &&
          c.o === tc.o + tc.ins.length) {
        tc.ins += c.ins;
        top.ops.push(...ops);
        top.after = after;
        top.t = now;
        this.forceBreak = false;
        return;
      }
    }
    if (canMerge && kind === 'delete') {
      const c = changes[0]!;
      const tc = top.changes[0]!;
      // 连续退格:本次删除区间紧贴先前删除区间左侧(单字符、无插入)
      if (c.ins === '' && c.d === 1 && tc.ins === '' && c.o + c.d === tc.o) {
        tc.o = c.o;
        tc.d += c.d;
        tc.del = c.del + tc.del;
        top.ops.push(...ops);
        top.after = after;
        top.t = now;
        this.forceBreak = false;
        return;
      }
    }
    // 不合并:原地覆写压入新事务,惰性丢弃 redo 分支
    this.stack[this.ptr] = { kind, changes, ops, before, after, mergeable, t: now };
    this.ptr++;
    this.stackLen = this.ptr;
    this.forceBreak = false;
  }

  /** undo 合并断点:下一个编辑事务强制独立 */
  markCheckpoint(): void {
    this.forceBreak = true;
  }

  /**
   * undo:按原始操作序列的严格逆序回放。
   * 逆序回放时文本恰好回到每个操作刚执行完的状态,故操作偏移原样有效;
   * 多光标变更间的相互位移由此天然正确。
   */
  undo(): void {
    if (this.ptr === 0) return;
    const txn = this.stack[this.ptr - 1]!;
    for (let i = txn.ops.length - 1; i >= 0; i--) {
      const op = txn.ops[i]!;
      if (op.ins !== null) this.doc.del(op.o, op.ins.length);
      if (op.del !== null) this.doc.insert(op.o, op.del);
    }
    this.cursors = txn.before.map((c) => ({ ...c }));
    this.ptr--;
    this.forceBreak = true;
  }

  /** redo:按原操作序列正向重放(undo 已精确恢复到编辑前状态,偏移依然有效) */
  redo(): void {
    if (this.ptr >= this.stackLen) return;
    const txn = this.stack[this.ptr]!;
    for (const op of txn.ops) {
      if (op.del !== null) this.doc.del(op.o, op.del.length);
      if (op.ins !== null) this.doc.insert(op.o, op.ins);
    }
    this.cursors = txn.after.map((c) => ({ ...c }));
    this.ptr++;
    this.forceBreak = true;
  }

  canUndo(): boolean {
    return this.ptr > 0;
  }
  canRedo(): boolean {
    return this.ptr < this.stackLen;
  }

  /** 测试/诊断:undo 栈事务数与 redo 剩余数(逐字段对照用) */
  get undoDepth(): number {
    return this.ptr;
  }
  get redoDepth(): number {
    return this.stackLen - this.ptr;
  }
}

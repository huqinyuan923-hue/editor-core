/**
 * Vim 模态层:normal / insert / visual 三模式,动词-数量-名词组合。
 *
 * 实现策略:
 * - 每次 feedKey 前同步一份文本快照(txt/lines/starts),词移动(motion)全部在
 *   快照平面上计算,得到目标偏移后再通过 Editor 原语(setSelections/type/backspace/
 *   insert/undo)落盘——undo 集成因此免费获得。
 * - 词移动严格按 vim 语义:word=[A-Za-z0-9_],punct=其余非空白,空白含换行;
 *   空行按一个"词"停驻(w/b 会在空行行首停下);跨行的 exclusive 动作遵循
 *   vim :h exclusive 规则(终点在下列行首 → 回退到上一行行尾并改 inclusive,
 *   起点在行首非空白前 → 升级为行级删除)。
 * - normal 光标"坐在字符上"(列 <= len-1),insert 光标可停在行尾(len)。
 * - 行为基准:本机 vim -u NONE 实测 golden(tests/fixtures/vim-golden.json)。
 */

import { Editor } from './editor';

type Mode = 'normal' | 'insert' | 'visual';

type CharCls = 'word' | 'punct' | 'space';

const MAX_COUNT = 100000;

export class VimLayer {
  mode: Mode = 'normal';
  private ed: Editor;

  // 文本快照(每次 feedKey / 每次编辑后刷新)
  private txt = '';
  private lines: string[] = [];
  private starts: number[] = [];

  // 待定状态
  private count = 0;            // 运算符前的计数
  private opCount = 0;          // 运算符自身的计数(2d3w 的 2)
  private mCount = 0;           // 运算符后、名词前的计数(2d3w 的 3)
  private pendingOp: 'd' | 'y' | null = null;
  private pendingG = false;     // 等待 gg 的第二个 g
  private pendingRCount = 0;    // >0 表示等待 r 的替换字符
  private visualAnchor = 0;
  private desiredCol: number | null = null; // j/k 的目标列记忆
  // u 的光标记忆:事务下标 → vim 语义的变更起点(u 后光标落在变更起点)
  private undoCursors = new Map<number, number>();

  /** 匿名寄存器(单个) */
  register: { text: string; linewise: boolean } = { text: '', linewise: false };

  constructor(ed: Editor) {
    this.ed = ed;
    this.sync();
  }

  /** UI 状态行用:当前待定序列(如 "3d"/"r"/"g") */
  get pending(): string {
    if (this.pendingRCount > 0) return 'r';
    if (this.pendingG) return 'g';
    if (this.pendingOp) {
      return `${this.opCount > 1 ? this.opCount : ''}${this.pendingOp}${this.mCount > 1 ? this.mCount : ''}`;
    }
    return this.count > 1 ? String(this.count) : '';
  }

  // ---------- 快照 ----------

  private sync(): void {
    this.txt = this.ed.doc.getText();
    this.lines = this.txt.split('\n');
    this.starts = [];
    let acc = 0;
    for (const ln of this.lines) {
      this.starts.push(acc);
      acc += ln.length + 1;
    }
  }

  private lineCount(): number {
    return this.lines.length;
  }
  private lineStart(l: number): number {
    return this.starts[l]!;
  }
  private lineLen(l: number): number {
    return this.lines[l]!.length;
  }
  private lineEnd(l: number): number {
    return this.starts[l]! + this.lines[l]!.length;
  }
  private toLineCol(p: number): { line: number; col: number } {
    // 二分找 p 所在行
    let lo = 0, hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= p) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo, col: p - this.starts[lo]! };
  }
  private pos(): number {
    return this.ed.cursors[0]!.active;
  }
  private setCursor(p: number): void {
    this.ed.setSelections([{ anchor: p, active: p }]);
  }
  /** 编辑落盘后记录"该事务撤销后光标应回到的位置" */
  private noteUndoCursor(pos: number): void {
    this.undoCursors.set(this.ed.undoDepth - 1, pos);
  }

  /** normal/visual 光标:坐在字符上(列 0..len-1;空行列 0) */
  private clampNormal(p: number): number {
    const { line, col } = this.toLineCol(p);
    const len = this.lineLen(line);
    const c = len === 0 ? 0 : Math.min(col, len - 1);
    return this.lineStart(line) + c;
  }
  /** insert 光标:可停在行尾(列 0..len) */
  private clampInsert(p: number): number {
    const { line, col } = this.toLineCol(p);
    return this.lineStart(line) + Math.min(col, this.lineLen(line));
  }

  private cls(c: string): CharCls {
    if (c === '\n' || c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') return 'space';
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_') return 'word';
    return 'punct';
  }
  private isLineStart(p: number): boolean {
    return p === 0 || this.txt[p - 1] === '\n';
  }
  private firstNonBlank(l: number): number {
    const ln = this.lines[l]!;
    for (let i = 0; i < ln.length; i++) {
      if (this.cls(ln[i]!) !== 'space') return this.lineStart(l) + i;
    }
    return this.lineStart(l); // 空白行:列 0
  }

  // ---------- 词移动(快照平面) ----------

  /** 跳过空白;若落点是空行行首则停在那里(vim:空行算一个词) */
  private skipBlankStopEmpty(p: number): number {
    const n = this.txt.length;
    while (p < n) {
      const c = this.txt[p]!;
      if (this.cls(c) !== 'space') return p;
      if (c === '\n' && this.isLineStart(p)) return p; // 空行行首
      p++;
    }
    return n;
  }

  /** w 一步 */
  private stepW(p: number): number {
    const n = this.txt.length;
    if (p >= n) return n;
    // 当前在空行:前进到下一行(空行本身作为一个词被消费)
    if (this.txt[p] === '\n' && this.isLineStart(p)) {
      return this.skipBlankStopEmpty(p + 1);
    }
    const k = this.cls(this.txt[p]!);
    if (k !== 'space') {
      while (p < n && this.cls(this.txt[p]!) === k) p++;
    }
    return this.skipBlankStopEmpty(p);
  }

  /** b 一步(向前) */
  private stepB(p: number): number {
    if (p <= 0) return 0;
    let q = p - 1;
    while (q >= 0 && this.cls(this.txt[q]!) === 'space') {
      // 空行行首(q 指向其 '\n' 且 q 为行首):停在空行
      if (this.txt[q] === '\n' && this.isLineStart(q)) return q;
      q--;
    }
    if (q < 0) return 0;
    const k = this.cls(this.txt[q]!);
    while (q > 0 && this.cls(this.txt[q - 1]!) === k) q--;
    return q;
  }

  /** e 一步(落在词尾字符上,inclusive) */
  private stepE(p: number): number {
    const n = this.txt.length;
    if (p >= n) return Math.max(0, n - 1);
    let k = this.cls(this.txt[p]!);
    if (k === 'space') {
      // 跳过空白(不因空行停驻:e 直接找下一个词尾)
      let q = p;
      while (q < n && this.cls(this.txt[q]!) === 'space') q++;
      if (q >= n) return Math.max(0, n - 1);
      k = this.cls(this.txt[q]!);
      // 找该词 run 的末尾
      let e = q;
      while (e + 1 < n && this.cls(this.txt[e + 1]!) === k) e++;
      return e;
    }
    // 非空白:若已在 run 末尾(下一字符类别不同)→ 前进到下一个词尾;否则本 run 末尾
    let e = p;
    while (e + 1 < n && this.cls(this.txt[e + 1]!) === k) e++;
    if (e > p) return e;
    // 已在 run 末尾:跳空白找下一个词
    let q = e + 1;
    while (q < n && this.cls(this.txt[q]!) === 'space') q++;
    if (q >= n) return e;
    const k2 = this.cls(this.txt[q]!);
    let e2 = q;
    while (e2 + 1 < n && this.cls(this.txt[e2 + 1]!) === k2) e2++;
    return e2;
  }

  /** 计数重复执行单步移动 */
  private moveRepeat(start: number, count: number, step: (p: number) => number): number {
    let p = start;
    for (let i = 0; i < count; i++) {
      const q = step.call(this, p);
      if (q === p) break; // 到边界不再前进
      p = q;
    }
    return p;
  }

  // ---------- feedKey 主入口 ----------

  feedKey(k: string): void {
    // 归一化特殊键
    let key = k;
    if (k === '\x1b') key = 'Esc';
    else if (k === '\n' || k === '\r') key = 'Enter';
    else if (k === '\b' || k === '\x7f') key = 'Backspace';
    if (key.length > 1 && key !== 'Esc' && key !== 'Enter' && key !== 'Backspace') {
      for (const ch of key) this.feedKey(ch); // 容错:多字符输入拆开喂
      return;
    }
    this.sync();
    if (this.mode === 'insert') this.normal_insertKey(key);
    else if (this.mode === 'visual') this.visualKey(key);
    else this.normalKey(key);
  }

  // ---------- insert 模式 ----------

  private normal_insertKey(key: string): void {
    if (key === 'Esc') {
      this.mode = 'normal';
      // 退出插入:光标退到刚插入的最后一个字符上(列 0 除外)
      const p = this.pos();
      const { col } = this.toLineCol(p);
      this.setCursor(this.clampNormal(col > 0 ? p - 1 : p));
      return;
    }
    if (key === 'Backspace') { this.ed.backspace(); this.sync(); return; }
    if (key === 'Enter') { this.ed.type('\n'); this.sync(); return; }
    this.ed.type(key);
    this.sync();
  }

  // ---------- normal 模式 ----------

  private normalKey(key: string): void {
    // 等待 r 的替换字符
    if (this.pendingRCount > 0) {
      const cnt = this.pendingRCount;
      this.pendingRCount = 0;
      if (key === 'Esc') return;
      if (key === 'Enter') return; // r+回车不在支持范围,取消
      this.doReplace(cnt, key);
      return;
    }
    // 等待 gg 的第二个 g
    if (this.pendingG) {
      this.pendingG = false;
      if (key === 'g') {
        const line = Math.min(Math.max(1, this.opCount || 1), this.lineCount()) - 1;
        this.opCount = 0;
        this.count = 0;
        this.desiredCol = null;
        this.setCursor(this.clampNormal(this.firstNonBlank(line)));
        return;
      }
      this.count = 0;
      return; // 未支持的 g 命令:取消
    }
    // 运算符待定:d/y + [count] 名词
    if (this.pendingOp) {
      if (key >= '1' && key <= '9' || (key === '0' && this.mCount > 0)) {
        this.mCount = this.mCount * 10 + Number(key);
        return;
      }
      const op = this.pendingOp;
      const total = this.opCount * (this.mCount || 1);
      this.pendingOp = null;
      this.opCount = 0;
      this.mCount = 0;
      const c0 = this.count;
      this.count = 0;
      if (key === op) {
        // dd / yy:行级,行数 = opCount * (mCount || 1)(3dd 的 3 已在 opCount)
        this.doLinewise(op, total);
        return;
      }
      this.doOpMotion(op, key, total, c0);
      return;
    }
    // 计数
    if (key >= '1' && key <= '9') {
      this.count = Math.min(this.count * 10 + Number(key), MAX_COUNT);
      return;
    }
    if (key === '0' && this.count > 0) {
      this.count = Math.min(this.count * 10, MAX_COUNT);
      return;
    }
    // 普通动作
    const cnt = this.count || 1;
    this.count = 0;
    switch (key) {
      case 'd': this.pendingOp = 'd'; this.opCount = cnt; return;
      case 'y': this.pendingOp = 'y'; this.opCount = cnt; return;
      case 'g': this.pendingG = true; return;
      case 'r': this.pendingRCount = cnt; return;
      case 'v': this.mode = 'visual'; this.visualAnchor = this.pos(); this.desiredCol = null; return;
      case 'i': this.mode = 'insert'; return;
      case 'a': {
        this.mode = 'insert';
        const { line, col } = this.toLineCol(this.pos());
        const len = this.lineLen(line);
        this.setCursor(this.lineStart(line) + (len === 0 ? 0 : col + 1));
        return;
      }
      case 'I': {
        this.mode = 'insert';
        const { line } = this.toLineCol(this.pos());
        this.setCursor(this.firstNonBlank(line));
        return;
      }
      case 'A': {
        this.mode = 'insert';
        const { line } = this.toLineCol(this.pos());
        this.setCursor(this.lineEnd(line));
        return;
      }
      case 'o': {
        this.mode = 'insert';
        const { line } = this.toLineCol(this.pos());
        this.setCursor(this.lineEnd(line));
        this.ed.type('\n');
        this.sync();
        return;
      }
      case 'O': {
        this.mode = 'insert';
        const { line } = this.toLineCol(this.pos());
        this.setCursor(this.lineStart(line));
        this.ed.type('\n');
        this.sync();
        const nl = this.toLineCol(this.lineStart(line)).line;
        this.setCursor(this.lineStart(nl)); // 新空行行首
        return;
      }
      case 'h': {
        const { col } = this.toLineCol(this.pos());
        if (col > 0) this.setCursor(this.pos() - 1);
        this.desiredCol = null;
        return;
      }
      case 'l': {
        const { line, col } = this.toLineCol(this.pos());
        const len = this.lineLen(line);
        if (col < len - 1) this.setCursor(this.pos() + 1);
        this.desiredCol = null;
        return;
      }
      case 'j': case 'k': this.moveVertical(key === 'j' ? 1 : -1, cnt); return;
      case 'w': this.setCursor(this.clampNormal(this.moveRepeat(this.pos(), cnt, this.stepW))); this.desiredCol = null; return;
      case 'b': this.setCursor(this.clampNormal(this.moveRepeat(this.pos(), cnt, this.stepB))); this.desiredCol = null; return;
      case 'e': this.setCursor(this.clampNormal(this.moveRepeat(this.pos(), cnt, this.stepE))); this.desiredCol = null; return;
      case '0': this.setCursor(this.lineStart(this.toLineCol(this.pos()).line)); this.desiredCol = null; return;
      case '$': {
        const { line } = this.toLineCol(this.pos());
        const target = line + (cnt - 1);
        const l = Math.min(target, this.lineCount() - 1);
        this.setCursor(this.clampNormal(this.lineEnd(l) - (this.lineLen(l) === 0 ? 0 : 1)));
        this.desiredCol = null;
        return;
      }
      case 'G': {
        const l = cnt > 1 ? Math.min(cnt, this.lineCount()) - 1 : this.lineCount() - 1;
        this.setCursor(this.clampNormal(this.firstNonBlank(l)));
        this.desiredCol = null;
        return;
      }
      case 'x': this.doX(cnt); return;
      case 'p': this.doPaste(); return;
      case 'u': {
        const ptrAfter = this.ed.undoDepth - 1; // 即将撤销的事务下标
        this.ed.undo();
        this.sync();
        // vim 实测:u 后光标落在变更起点;VimLayer 自己的编辑动作会记下精确位置,
        // 其余(纯输入事务)用恢复快照的 anchor(插入起点)。
        const known = this.undoCursors.get(ptrAfter);
        this.setCursor(this.clampNormal(known ?? this.ed.cursors[0]!.anchor));
        return;
      }
      default:
        return; // 未支持的键:忽略
    }
  }

  /**
   * j/k:保留目标列(vim desired column 语义)。
   * 计数不可达(目标行越界)时整体不动(vim 实测:2j 在只剩 1 行可走时光标停住)。
   */
  private moveVertical(dir: 1 | -1, cnt: number): void {
    const { line, col } = this.toLineCol(this.pos());
    const target = line + dir * cnt;
    if (target < 0 || target >= this.lineCount()) return; // 计数不可达:不移动
    if (this.desiredCol === null) this.desiredCol = col;
    const len = this.lineLen(target);
    const c = len === 0 ? 0 : Math.min(this.desiredCol, len - 1);
    this.setCursor(this.lineStart(target) + c);
  }

  // ---------- 编辑动作 ----------

  /** x:删除光标起 count 个字符(不跨行) */
  private doX(cnt: number): void {
    const p = this.pos();
    const { line, col } = this.toLineCol(p);
    const len = this.lineLen(line);
    if (len === 0) return; // 空行:x 无效
    const end = Math.min(p + cnt, this.lineStart(line) + len);
    const deleted = this.txt.slice(p, end);
    if (end <= p) return;
    this.register = { text: deleted, linewise: false };
    this.ed.setSelections([{ anchor: p, active: end }]);
    this.ed.backspace();
    this.sync();
    this.noteUndoCursor(p);
    const newLen = this.lineLen(line);
    const c = newLen === 0 ? 0 : Math.min(col, newLen - 1);
    this.setCursor(this.lineStart(line) + c);
  }

  /** r{char}:替换 count 个字符 */
  private doReplace(cnt: number, ch: string): void {
    const p = this.pos();
    const { line, col } = this.toLineCol(p);
    const lineEndPos = this.lineEnd(line);
    if (p + cnt > lineEndPos) return; // 超出行尾:无效(vim 报错响铃)
    this.ed.setSelections([{ anchor: p, active: p + cnt }]);
    this.ed.insert(ch.repeat(cnt));
    this.sync();
    this.noteUndoCursor(p);
    this.setCursor(this.lineStart(line) + Math.min(col + cnt - 1, Math.max(0, this.lineLen(line) - 1)));
  }

  /** dd/yy:行级删除/复制 total 行 */
  private doLinewise(op: 'd' | 'y', total: number): void {
    const { line } = this.toLineCol(this.pos());
    const lo = line;
    const hi = Math.min(line + Math.max(1, total) - 1, this.lineCount() - 1);
    const regText = this.lines.slice(lo, hi + 1).map((s) => s + '\n').join('');
    if (op === 'y') {
      this.register = { text: regText, linewise: true };
      return; // 光标不动
    }
    this.register = { text: regText, linewise: true };
    this.deleteLines(lo, hi);
  }

  /** 删除行 [lo, hi],光标落在原 lo 行(现内容)行首非空白 */
  private deleteLines(lo: number, hi: number): void {
    let from: number, to: number;
    if (hi >= this.lineCount() - 1 && lo > 0) {
      // 删到文末且不是第一行:连同前面那个换行一起删,避免残留空行
      from = this.lineStart(lo) - 1;
      to = this.txt.length;
    } else {
      from = this.lineStart(lo);
      to = hi + 1 < this.lineCount() ? this.lineStart(hi + 1) : this.txt.length;
    }
    const restorePos = this.lineStart(lo); // 编辑前捕获:撤销后光标回到被删行首
    this.ed.setSelections([{ anchor: from, active: to }]);
    this.ed.backspace();
    this.sync();
    this.noteUndoCursor(restorePos);
    const l = Math.min(lo, this.lineCount() - 1);
    this.setCursor(this.clampNormal(this.firstNonBlank(l)));
  }

  /** p:粘贴寄存器 */
  private doPaste(): void {
    if (this.register.text.length === 0) return;
    const p = this.pos();
    if (this.register.linewise) {
      const { line } = this.toLineCol(p);
      const at = line + 1 < this.lineCount() ? this.lineStart(line + 1) : this.txt.length;
      this.setCursor(at);
      this.ed.insert(this.register.text);
      this.sync();
      this.noteUndoCursor(at);
      // 光标到第一行粘贴内容的第一个非空白
      const firstPasted = Math.min(line + 1, this.lineCount() - 1);
      this.setCursor(this.clampNormal(this.firstNonBlank(firstPasted)));
    } else {
      const { line } = this.toLineCol(p);
      const len = this.lineLen(line);
      const at = len === 0 ? this.lineStart(line) : p + 1; // 字符级粘贴:插在光标后
      this.setCursor(at);
      this.ed.insert(this.register.text);
      this.sync();
      this.noteUndoCursor(at);
      const endPos = at + this.register.text.length - 1; // 停在粘贴文本最后一个字符
      this.setCursor(this.clampNormal(endPos));
    }
  }

  /** d/y + 名词(w/b/e/h/l/0/$/j/k) */
  private doOpMotion(op: 'd' | 'y', motion: string, total: number, preCount: number): void {
    const cnt = Math.max(1, total) * Math.max(1, preCount || 1);
    const p = this.pos();
    const { line: sl } = this.toLineCol(p);
    if (motion === 'j' || motion === 'k') {
      // 行级:从当前行到目标行;计数不可达时整个动作作废(vim 实测 d2j 越界即空转)
      const targetLine = sl + (motion === 'j' ? 1 : -1) * cnt;
      if (targetLine < 0 || targetLine >= this.lineCount()) return;
      const lo = Math.min(sl, targetLine);
      const hi = Math.max(sl, targetLine);
      if (op === 'y') {
        this.register = { text: this.lines.slice(lo, hi + 1).map((s) => s + '\n').join(''), linewise: true };
        return;
      }
      this.register = { text: this.lines.slice(lo, hi + 1).map((s) => s + '\n').join(''), linewise: true };
      this.deleteLines(lo, hi);
      return;
    }
    let target: number;
    let inclusive = false;
    switch (motion) {
      case 'w': {
        // w + operator(vim -u NONE 实测规则):目标落在下一行行首或缓冲末(虚拟空行)时——
        // 1) 总计数 >= 2 且起点 <= 本行首个非空白 → 升级为行级操作 [sl, endLine-1];
        // 2) 总计数 == 1 → 行尾回退:操作区止于本行行尾(不含换行);
        // 3) 总计数 >= 2 且起点非行首 → 纯 charwise,终点就是裸目标(可越过缓冲末)。
        const raw = this.moveRepeat(p, cnt, this.stepW);
        const n = this.txt.length;
        const endLine = raw >= n ? this.lineCount() : this.toLineCol(raw).line;
        const endCol = raw >= n ? 0 : raw - this.lineStart(endLine);
        if (endCol === 0 && endLine > sl) {
          if (cnt >= 2 && p <= this.firstNonBlank(sl)) {
            const hi = endLine - 1;
            const regText = this.lines.slice(sl, hi + 1).map((s) => s + '\n').join('');
            this.register = { text: regText, linewise: true };
            if (op === 'y') return;
            this.deleteLines(sl, hi);
            return;
          }
          if (cnt >= 2) {
            target = raw;
            break;
          }
          target = this.lineEnd(sl) - (this.lineLen(sl) === 0 ? 0 : 1);
          inclusive = true;
        } else {
          target = this.clampNormal(raw);
        }
        break;
      }
      case 'b': target = this.clampNormal(this.moveRepeat(p, cnt, this.stepB)); break;
      case 'e': target = this.clampNormal(this.moveRepeat(p, cnt, this.stepE)); inclusive = true; break;
      case 'h': {
        const { line, col } = this.toLineCol(p);
        target = this.lineStart(line) + Math.max(0, col - cnt);
        break;
      }
      case 'l': {
        const { line, col } = this.toLineCol(p);
        target = this.lineStart(line) + Math.min(col + cnt, Math.max(0, this.lineLen(line) - 1));
        break;
      }
      case '0': target = this.lineStart(sl); break;
      case '$': {
        const l = Math.min(sl + cnt - 1, this.lineCount() - 1);
        target = this.lineEnd(l) - (this.lineLen(l) === 0 ? 0 : 1);
        inclusive = true;
        break;
      }
      default: return; // 未支持的名词
    }
    let from = p, to = target;
    if (target < p) {
      // 反向(b/0/h):exclusive 区间 [target, p)
      from = target;
      to = p;
      if (op === 'y') {
        this.register = { text: this.txt.slice(from, to), linewise: false };
        this.setCursor(this.clampNormal(from));
        return;
      }
      this.register = { text: this.txt.slice(from, to), linewise: false };
      this.ed.setSelections([{ anchor: from, active: to }]);
      this.ed.backspace();
      this.sync();
      this.noteUndoCursor(from);
      this.setCursor(this.clampNormal(from));
      return;
    }
    // 正向:vim :h exclusive 特判
    if (!inclusive) {
      const endCol = to - this.lineStart(this.toLineCol(to).line);
      const endLine = this.toLineCol(to).line;
      if (endCol === 0 && endLine > sl) {
        const firstNB = this.firstNonBlank(sl);
        if (p <= firstNB) {
          // 升级为行级删除:删除 [sl, endLine-1] 行
          if (op === 'y') {
            this.register = { text: this.lines.slice(sl, endLine).map((s) => s + '\n').join(''), linewise: true };
            return;
          }
          this.register = { text: this.lines.slice(sl, endLine).map((s) => s + '\n').join(''), linewise: true };
          this.deleteLines(sl, endLine - 1);
          return;
        }
        // 回退到上一行行尾,转 inclusive
        const prevL = endLine - 1;
        to = this.lineEnd(prevL) - (this.lineLen(prevL) === 0 ? 0 : 1);
        inclusive = true;
      }
    }
    const end = inclusive ? to + 1 : to;
    if (end <= from) return;
    const text = this.txt.slice(from, end);
    if (op === 'y') {
      this.register = { text, linewise: false };
      return; // y 不移动光标(目标即起点)
    }
    this.register = { text, linewise: false };
    this.ed.setSelections([{ anchor: from, active: end }]);
    this.ed.backspace();
    this.sync();
    this.noteUndoCursor(from);
    this.setCursor(this.clampNormal(from));
  }

  // ---------- visual 模式 ----------

  private visualKey(key: string): void {
    // 计数
    if (key >= '1' && key <= '9' || (key === '0' && this.count > 0)) {
      this.count = Math.min(this.count * 10 + Number(key), MAX_COUNT);
      return;
    }
    const cnt = this.count || 1;
    this.count = 0;
    const cur = this.pos();
    switch (key) {
      case 'Esc': case 'v':
        this.mode = 'normal';
        this.setCursor(this.clampNormal(cur));
        this.desiredCol = null;
        return;
      case 'd': case 'x': {
        const lo = Math.min(this.visualAnchor, cur);
        const hi = Math.max(this.visualAnchor, cur);
        const end = hi + 1; // 含光标字符
        this.register = { text: this.txt.slice(lo, end), linewise: false };
        this.ed.setSelections([{ anchor: lo, active: end }]);
        this.ed.backspace();
        this.sync();
        this.noteUndoCursor(lo);
        this.mode = 'normal';
        this.setCursor(this.clampNormal(lo));
        this.desiredCol = null;
        return;
      }
      case 'y': {
        const lo = Math.min(this.visualAnchor, cur);
        const hi = Math.max(this.visualAnchor, cur);
        this.register = { text: this.txt.slice(lo, hi + 1), linewise: false };
        this.mode = 'normal';
        this.setCursor(this.clampNormal(lo));
        this.desiredCol = null;
        return;
      }
      case 'p': {
        if (this.register.text.length === 0) return;
        const lo = Math.min(this.visualAnchor, cur);
        const hi = Math.max(this.visualAnchor, cur);
        const end = hi + 1;
        const reg = this.register;
        this.ed.setSelections([{ anchor: lo, active: end }]);
        this.ed.insert(reg.text);
        this.sync();
        this.noteUndoCursor(lo);
        this.mode = 'normal';
        this.setCursor(this.clampNormal(lo + reg.text.length - 1));
        this.desiredCol = null;
        return;
      }
      case 'o': {
        // 交换光标与选区起点
        const t = this.visualAnchor;
        this.visualAnchor = cur;
        this.setCursor(this.clampNormal(t));
        return;
      }
      case 'h': {
        const { line, col } = this.toLineCol(cur);
        if (col > 0) this.setCursor(cur - 1);
        this.desiredCol = null;
        return;
      }
      case 'l': {
        const { line, col } = this.toLineCol(cur);
        if (col < this.lineLen(line) - 1) this.setCursor(cur + 1);
        this.desiredCol = null;
        return;
      }
      case 'j': case 'k': this.moveVisualVertical(key === 'j' ? 1 : -1, cnt); return;
      case 'w': this.setCursor(this.clampNormal(this.moveRepeat(cur, cnt, this.stepW))); this.desiredCol = null; return;
      case 'b': this.setCursor(this.clampNormal(this.moveRepeat(cur, cnt, this.stepB))); this.desiredCol = null; return;
      case 'e': this.setCursor(this.clampNormal(this.moveRepeat(cur, cnt, this.stepE))); this.desiredCol = null; return;
      case '0': this.setCursor(this.lineStart(this.toLineCol(cur).line)); this.desiredCol = null; return;
      case '$': {
        const { line } = this.toLineCol(cur);
        const l = Math.min(line + cnt - 1, this.lineCount() - 1);
        this.setCursor(this.lineEnd(l) - (this.lineLen(l) === 0 ? 0 : 1));
        this.desiredCol = null;
        return;
      }
      case 'G': {
        const l = this.count > 0 ? Math.min(this.count, this.lineCount()) - 1 : this.lineCount() - 1;
        this.count = 0;
        this.setCursor(this.clampNormal(this.firstNonBlank(l)));
        return;
      }
      case 'g': {
        // visual 中 gg 不支持,取消
        return;
      }
      case 'i': case 'I': case 'a': case 'A':
        this.mode = 'insert';
        return;
      default:
        return;
    }
  }

  private moveVisualVertical(dir: 1 | -1, cnt: number): void {
    const cur = this.pos();
    const { line, col } = this.toLineCol(cur);
    if (this.desiredCol === null) this.desiredCol = col;
    const target = Math.min(Math.max(line + dir * cnt, 0), this.lineCount() - 1);
    const len = this.lineLen(target);
    const c = len === 0 ? 0 : Math.min(this.desiredCol, len - 1);
    this.setCursor(this.lineStart(target) + c);
  }
}

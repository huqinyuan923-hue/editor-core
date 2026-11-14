/**
 * 文档模型:Piece Table + 隐式平衡树(treap)子树前缀和。
 *
 * 设计要点:
 * - 文本永不拼接:原始文本(original)与每次插入的文本(adds 缓冲区)都是只读缓冲区,
 *   文档 = 一串 piece(缓冲区引用 + 区间),按顺序组成一棵隐式键平衡树。
 * - 每个节点维护子树聚合 sz(字符数)与 nlz(换行数),即"前缀和缓冲",
 *   使 insert/del 的定位、按行定位均为 O(log n)。
 * - 编辑用 treap 的 split/merge 完成:插入 = 切两刀 + 拼一片;删除 = 切三刀 + 丢中间。
 *   丢弃的子树整体交给 GC,不做任何逐节点摘除,避免红黑树删除修复的高出错面。
 * - 优先级由确定性 PRNG 生成(固定种子),行为可复现。
 */

/** treap 节点:一个 piece + 子树聚合 */
interface PieceNode {
  prio: number; // 平衡优先级(大者在堆顶方向)
  buf: number;  // 缓冲区编号:0 = original,>=1 = adds[buf-1]
  start: number; // 缓冲区内起始偏移
  len: number;   // 本片字符数(恒 >= 1,不产生空片)
  nl: number;    // 本片内 '\n' 个数
  left: PieceNode | null;
  right: PieceNode | null;
  sz: number;    // 子树总字符数(含自身)
  nlz: number;   // 子树总换行数(含自身)
}

/** 确定性 PRNG(mulberry32),用于 treap 优先级 */
function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 统计 s[start, start+len) 内的换行数(用 indexOf,长片扫描走快路径) */
function countNl(s: string, start: number, len: number): number {
  let c = 0;
  let i = start;
  const end = start + len;
  for (;;) {
    const j = s.indexOf('\n', i);
    if (j === -1 || j >= end) break;
    c++;
    i = j + 1;
  }
  return c;
}

/** 初始文本分片上限:保证任何 piece 都不会过大,片内换行统计/查找都是小常数 */
const CHUNK = 4096;

let instanceSeq = 0;

export class Doc {
  private orig: string;
  private adds: string[] = [];
  private root: PieceNode | null = null;
  private rand: () => number;

  constructor(text: string) {
    this.orig = text;
    this.rand = mulberry32(0x9e3779b9 ^ (instanceSeq++ * 2654435761));
    // 初始文本按 CHUNK 切片,自左向右 merge 成平衡树
    let acc: PieceNode | null = null;
    for (let off = 0; off < text.length; off += CHUNK) {
      const len = Math.min(CHUNK, text.length - off);
      const p = this.makePiece(0, off, len);
      acc = this.merge(acc, p);
    }
    this.root = acc;
  }

  /** 文档总字符数 */
  get length(): number {
    return this.root ? this.root.sz : 0;
  }

  /** 行数(以 '\n' 计,结尾换行产生最后一个空行) */
  lineCount(): number {
    return (this.root ? this.root.nlz : 0) + 1;
  }

  // ---------- 树基础操作 ----------

  private makePiece(buf: number, start: number, len: number): PieceNode {
    const nl = countNl(this.bufText(buf), start, len);
    return {
      prio: Math.floor(this.rand() * 2147483647),
      buf, start, len, nl,
      left: null, right: null,
      sz: len, nlz: nl,
    };
  }

  private bufText(buf: number): string {
    return buf === 0 ? this.orig : this.adds[buf - 1]!;
  }

  private update(t: PieceNode | null): void {
    if (!t) return;
    const l = t.left, r = t.right;
    t.sz = t.len + (l ? l.sz : 0) + (r ? r.sz : 0);
    t.nlz = t.nl + (l ? l.nlz : 0) + (r ? r.nlz : 0);
  }

  /** 把整树按字符偏移切成两棵:L 含前 off 个字符。要求 0 <= off <= 子树总长 */
  private split(t: PieceNode | null, off: number): [PieceNode | null, PieceNode | null] {
    if (!t) return [null, null];
    const leftLen = t.left ? t.left.sz : 0;
    if (off < leftLen) {
      const [l, r] = this.split(t.left, off);
      t.left = r;
      this.update(t);
      return [l, t];
    }
    if (off > leftLen + t.len) {
      const [l, r] = this.split(t.right, off - leftLen - t.len);
      t.right = l;
      this.update(t);
      return [t, r];
    }
    // 切点落在本片内(或恰好在本片两端)
    const i = off - leftLen; // 0 <= i <= t.len
    if (i === 0) {
      const l = t.left;
      t.left = null;
      this.update(t);
      return [l, t];
    }
    if (i === t.len) {
      const r = t.right;
      t.right = null;
      this.update(t);
      return [t, r];
    }
    // 片内切分:t 保留前 i 个字符,新片 q 承接其余部分
    // 注意:先把 t 的左右子树都摘下来变成叶子,再参与 merge,
    // 否则 merge(t.left, t) 会在"b 在上"分支里自合并(b.left === a)织出环。
    const q = this.makePiece(t.buf, t.start + i, t.len - i);
    const lSub = t.left;
    const rSub = t.right;
    t.len = i;
    t.nl = countNl(this.bufText(t.buf), t.start, i);
    t.left = null;
    t.right = null;
    this.update(t);
    const lTree = this.merge(lSub, t);
    const rTree = this.merge(q, rSub);
    return [lTree, rTree];
  }

  /** 合并两棵不相交树:所有 L 的字符在所有 R 的字符之前 */
  private merge(a: PieceNode | null, b: PieceNode | null): PieceNode | null {
    if (!a) return b;
    if (!b) return a;
    if (a.prio > b.prio) {
      a.right = this.merge(a.right, b);
      this.update(a);
      return a;
    }
    b.left = this.merge(a, b.left);
    this.update(b);
    return b;
  }

  // ---------- 公开编辑 API ----------

  /** 在 offset 处插入文本 */
  insert(offset: number, text: string): void {
    if (text.length === 0) return;
    if (!(offset >= 0)) offset = 0;
    if (offset > this.length) offset = this.length;
    const bufId = this.adds.push(text); // bufId 从 1 开始编号
    const piece = this.makePiece(bufId, 0, text.length);
    const [l, r] = this.split(this.root, offset);
    this.root = this.merge(this.merge(l, piece), r);
  }

  /** 从 offset 起删除 count 个字符(越界自动截断) */
  del(offset: number, count: number): void {
    if (!(count > 0)) return;
    if (!(offset >= 0)) offset = 0;
    if (offset > this.length) offset = this.length;
    count = Math.min(count, this.length - offset);
    if (count === 0) return;
    const [a, mr] = this.split(this.root, offset);
    const [m, c] = this.split(mr, count);
    this.root = this.merge(a, c);
    // m 整棵子树被丢弃,GC 回收
  }

  // ---------- 读侧 ----------

  /** 全文(整树中序拼接) */
  getText(): string {
    const parts: string[] = [];
    this.collect(this.root, 0, this.length, parts);
    return parts.join('');
  }

  /** 读全局 [offset, offset+count) 的文本(用于编辑器抓取被删文本) */
  getRange(offset: number, count: number): string {
    if (!(count > 0)) return '';
    if (!(offset >= 0)) offset = 0;
    if (offset > this.length) offset = this.length;
    count = Math.min(count, this.length - offset);
    if (count === 0) return '';
    const parts: string[] = [];
    this.collect(this.root, offset, count, parts);
    return parts.join('');
  }

  /** 收集子树与全局区间 [off, off+count) 的交集(递归剪枝,只走相关路径) */
  private collect(t: PieceNode | null, off: number, count: number, parts: string[]): void {
    if (!t || count <= 0) return;
    const leftLen = t.left ? t.left.sz : 0;
    // 左子树覆盖全局区间 [0, leftLen)
    const lTo = Math.min(leftLen, off + count);
    if (lTo > off) this.collect(t.left, off, lTo - off, parts);
    // 本片覆盖 [leftLen, leftLen+len)
    const sFrom = Math.max(leftLen, off);
    const sTo = Math.min(leftLen + t.len, off + count);
    if (sTo > sFrom) {
      parts.push(this.bufText(t.buf).slice(t.start + (sFrom - leftLen), t.start + (sTo - leftLen)));
    }
    // 右子树:换算到右子树自身坐标系 [from, to),只收集交集
    const rOff = leftLen + t.len;
    if (t.right) {
      const from = Math.max(0, off - rOff);
      const to = Math.min(t.right.sz, off + count - rOff);
      if (to > from) this.collect(t.right, from, to - from, parts);
    }
  }

  /** 第 n 行(0 基)。越界抛 RangeError */
  getLine(n: number): string {
    const lc = this.lineCount();
    if (!Number.isInteger(n) || n < 0 || n >= lc) {
      throw new RangeError(`行号越界: ${n}(共 ${lc} 行)`);
    }
    const start = n === 0 ? 0 : this.posOfNl(n - 1) + 1;
    const end = n === lc - 1 ? this.length : this.posOfNl(n);
    return this.getRange(start, end - start);
  }

  /** 行迭代器:按行产出文本(不含换行符) */
  *lines(): Generator<string> {
    const lc = this.lineCount();
    for (let n = 0; n < lc; n++) yield this.getLine(n);
  }

  /** 第 k 个 '\n'(0 基)的全局偏移;要求 k < 总换行数 */
  private posOfNl(k: number): number {
    const root = this.root;
    if (!root || k < 0 || k >= root.nlz) {
      throw new RangeError(`换行序号越界: ${k}`);
    }
    let t: PieceNode = root;
    let base = 0; // t 子树首字符的全局偏移
    for (;;) {
      const l = t.left;
      const lNl = l ? l.nlz : 0;
      if (k < lNl) {
        t = l!;
        continue;
      }
      k -= lNl;
      const lSz = l ? l.sz : 0;
      if (k < t.nl) {
        // 第 k 个换行在本片内:片内找第 k+1 个 '\n'
        const text = this.bufText(t.buf);
        let idx = t.start;
        for (let i = 0; i <= k; i++) {
          idx = text.indexOf('\n', idx);
          if (idx === -1 || idx >= t.start + t.len) {
            throw new Error('片内换行计数不一致(树聚合损坏)');
          }
          idx++;
        }
        return base + lSz + (idx - 1 - t.start);
      }
      k -= t.nl;
      base += lSz + t.len;
      t = t.right!;
    }
  }

  /** 第 n 行行首的全局偏移(0 基行号) */
  lineStartOffset(n: number): number {
    if (n === 0) return 0;
    if (n < 0 || n >= this.lineCount()) throw new RangeError(`行号越界: ${n}`);
    return this.posOfNl(n - 1) + 1;
  }

  /** 第 n 行行尾(换行符之前)的全局偏移 */
  lineEndOffset(n: number): number {
    const lc = this.lineCount();
    if (n < 0 || n >= lc) throw new RangeError(`行号越界: ${n}`);
    return n === lc - 1 ? this.length : this.posOfNl(n);
  }

  /** 统计全局 [0, off) 内的换行数(off 所在行号) */
  private nlBefore(t: PieceNode | null, off: number): number {
    if (!t || off <= 0) return 0;
    const leftLen = t.left ? t.left.sz : 0;
    if (off < leftLen) return this.nlBefore(t.left, off);
    if (off < leftLen + t.len) {
      return (t.left ? t.left.nlz : 0) + countNl(this.bufText(t.buf), t.start, off - leftLen);
    }
    return (t.left ? t.left.nlz : 0) + t.nl + this.nlBefore(t.right, off - leftLen - t.len);
  }

  /** 全局偏移 → (行号, 行内列号),均为 0 基;off 越界自动截断 */
  offsetToLineCol(off: number): { line: number; col: number } {
    if (!(off >= 0)) off = 0;
    if (off > this.length) off = this.length;
    const line = this.nlBefore(this.root, off);
    const col = off - this.lineStartOffset(line);
    return { line, col };
  }

  // ---------- 诊断(测试用):校验树聚合与 BST 序 ----------

  /** 仅供测试:深度校验聚合值、BST 字符序与片段无空片 */
  validate(): void {
    const check = (t: PieceNode | null): { sz: number; nlz: number } => {
      if (!t) return { sz: 0, nlz: 0 };
      if (t.len <= 0) throw new Error('存在空片');
      const l = check(t.left);
      const nl = countNl(this.bufText(t.buf), t.start, t.len);
      if (nl !== t.nl) throw new Error('片内换行数与缓存不一致');
      const r = check(t.right);
      const sz = t.len + l.sz + r.sz;
      const nlz = t.nl + l.nlz + r.nlz;
      if (sz !== t.sz || nlz !== t.nlz) throw new Error('子树聚合不一致');
      return { sz, nlz };
    };
    check(this.root);
    // 内容序验证:整树拼出的文本必须与按切片顺序拼接一致
    const parts: string[] = [];
    const walk = (t: PieceNode | null): void => {
      if (!t) return;
      walk(t.left);
      parts.push(this.bufText(t.buf).slice(t.start, t.start + t.len));
      walk(t.right);
    };
    walk(this.root);
    if (parts.join('') !== this.getText()) throw new Error('中序拼接与 getText 不一致');
  }
}

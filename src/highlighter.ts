/**
 * 朴素 JS 语法高亮:单行正则分词 + 跨行状态机(块注释 / 模板串 / ${} 插值 / 正则字面量)。
 *
 * 状态 = 帧栈:
 * - 底帧是全局 JS 表达式上下文(depth 0,'}' 永不弹出);
 * - 模板串文本是 'tmpl' 帧,遇到 `${` 压入一个 depth=0 的插值表达式帧,
 *   插值内的 '{' / '}' 维护 depth,depth 归零遇 '}' 弹帧回到模板文本;
 * - 帧内携带 regexAllowed(正则字面量消歧:标识符/数字/字符串/右括号后 '/' 是除号)
 *   与 blockComment(跨行块注释)。
 *
 * 增量:缓存每行起始状态;单行编辑后从该行重扫,直到某行的新起始状态与缓存一致
 * (级联收敛),之后各行的高亮结果保证与整文重算完全一致。
 */

export type TokenKind =
  | 'keyword' | 'identifier' | 'number' | 'string'
  | 'template' | 'regex' | 'comment' | 'punct' | 'whitespace';

export interface Token {
  /** 行内起始偏移(0 基) */
  start: number;
  kind: TokenKind;
}

interface ExprFrame {
  kind: 'expr';
  depth: number;        // ${} 内嵌 '{' 深度
  regexAllowed: boolean;
  blockComment: boolean;
}
interface TmplFrame {
  kind: 'tmpl';
}
type Frame = ExprFrame | TmplFrame;
interface HState {
  stack: Frame[];
}

const KEYWORDS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete',
  'do', 'else', 'export', 'extends', 'finally', 'for', 'function', 'if', 'import', 'in',
  'instanceof', 'new', 'return', 'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var',
  'void', 'while', 'with', 'yield', 'let', 'static', 'enum', 'await', 'implements', 'package',
  'protected', 'interface', 'private', 'public',
]);

// 这些关键字后允许接正则字面量(return /re/、case /re/ 等)
const REGEX_OK_KEYWORDS = new Set([
  'return', 'case', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'do', 'else', 'yield', 'await',
]);

const isDigit = (c: string): boolean => c >= '0' && c <= '9';
const isIdentStart = (c: string): boolean =>
  (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$';
const isIdentPart = (c: string): boolean => isIdentStart(c) || isDigit(c);
const isSpace = (c: string): boolean => c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v';

function initialState(): HState {
  return {
    stack: [{ kind: 'expr', depth: 0, regexAllowed: true, blockComment: false }],
  };
}

function cloneState(s: HState): HState {
  return { stack: s.stack.map((f) => ({ ...f })) };
}

function stateEqual(a: HState, b: HState): boolean {
  if (a.stack.length !== b.stack.length) return false;
  for (let i = 0; i < a.stack.length; i++) {
    const fa = a.stack[i]!, fb = b.stack[i]!;
    if (fa.kind !== fb.kind) return false;
    if (fa.kind === 'expr' && fb.kind === 'expr') {
      if (fa.depth !== fb.depth || fa.regexAllowed !== fb.regexAllowed || fa.blockComment !== fb.blockComment) {
        return false;
      }
    }
  }
  return true;
}

/** 单行扫描:纯函数,返回分段与行末状态 */
function scanLine(text: string, start: HState): { tokens: Token[]; end: HState } {
  const st = cloneState(start);
  const tokens: Token[] = [];
  const emit = (kind: TokenKind, at: number): void => {
    const last = tokens[tokens.length - 1];
    if (!last || last.kind !== kind) tokens.push({ start: at, kind });
  };
  let i = 0;
  while (i < text.length) {
    const top = st.stack[st.stack.length - 1]!;
    const at = i;
    if (top.kind === 'tmpl') {
      // 模板串文本:直到反引号(闭合)或 ${(进入插值)
      emit('template', at);
      while (i < text.length) {
        const c = text[i]!;
        if (c === '\\') { i += 2; continue; }
        if (c === '`') { i++; st.stack.pop(); break; }
        if (c === '$' && text[i + 1] === '{') {
          i += 2;
          st.stack.push({ kind: 'expr', depth: 0, regexAllowed: true, blockComment: false });
          break;
        }
        i++;
      }
      continue;
    }
    const ef = top as ExprFrame;
    if (ef.blockComment) {
      emit('comment', at);
      const close = text.indexOf('*/', i);
      if (close === -1) { i = text.length; continue; }
      i = close + 2;
      ef.blockComment = false;
      ef.regexAllowed = true; // 注释等同空白,其后可为正则
      continue;
    }
    const c = text[i]!;
    if (isSpace(c)) {
      emit('whitespace', at);
      while (i < text.length && isSpace(text[i]!)) i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      emit('comment', at);
      i = text.length;
      ef.regexAllowed = true; // 行注释到行尾,下一行行首可为正则
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      emit('comment', at);
      i += 2;
      ef.blockComment = true;
      continue;
    }
    if (c === '/' && ef.regexAllowed) {
      // 尝试正则字面量:处理转义与 [字符类];行尾仍未闭合则按除号回退
      const regexStart = i;
      let j = i + 1;
      let inClass = false;
      let ok = false;
      while (j < text.length) {
        const rc = text[j]!;
        if (rc === '\\') { j += 2; continue; }
        if (rc === '\n') break;
        if (inClass) { if (rc === ']') inClass = false; }
        else if (rc === '[') inClass = true;
        else if (rc === '/') { ok = true; break; }
        j++;
      }
      if (ok) {
        emit('regex', regexStart);
        j++; // 越过闭斜杠
        while (j < text.length && isIdentPart(text[j]!)) j++; // flags(g/i/m/s/u/y/d)
        i = j;
        ef.regexAllowed = false;
        continue;
      }
      // 回退:按除号/ punct 处理
      emit('punct', regexStart);
      i = regexStart + 1;
      ef.regexAllowed = false; // 与其它除号一致
      continue;
    }
    if (c === '"' || c === "'") {
      emit('string', at);
      const quote = c;
      i++;
      while (i < text.length) {
        const sc = text[i]!;
        if (sc === '\\') { i += 2; continue; }
        if (sc === quote) { i++; break; }
        i++;
      }
      ef.regexAllowed = false;
      continue;
    }
    if (c === '`') {
      emit('template', at);
      i++;
      st.stack.push({ kind: 'tmpl' });
      continue;
    }
    if (isDigit(c) || (c === '.' && isDigit(text[i + 1] ?? ''))) {
      emit('number', at);
      if (c === '0' && (text[i + 1] === 'x' || text[i + 1] === 'X')) {
        i += 2;
        while (i < text.length && /[0-9a-fA-F_]/.test(text[i]!)) i++;
      } else if (c === '0' && (text[i + 1] === 'o' || text[i + 1] === 'O')) {
        i += 2;
        while (i < text.length && /[0-7_]/.test(text[i]!)) i++;
      } else if (c === '0' && (text[i + 1] === 'b' || text[i + 1] === 'B')) {
        i += 2;
        while (i < text.length && /[01_]/.test(text[i]!)) i++;
      } else {
        while (i < text.length && (isDigit(text[i]!) || text[i] === '_')) i++;
        if (text[i] === '.') { i++; while (i < text.length && (isDigit(text[i]!) || text[i] === '_')) i++; }
        if (text[i] === 'e' || text[i] === 'E') {
          let k = i + 1;
          if (text[k] === '+' || text[k] === '-') k++;
          if (isDigit(text[k] ?? '')) {
            i = k;
            while (i < text.length && isDigit(text[i]!)) i++;
          }
        }
      }
      if (text[i] === 'n') i++; // BigInt 后缀
      ef.regexAllowed = false;
      continue;
    }
    if (isIdentStart(c)) {
      emit('identifier', at);
      while (i < text.length && isIdentPart(text[i]!)) i++;
      const word = text.slice(at, i);
      if (KEYWORDS.has(word)) {
        tokens[tokens.length - 1]!.kind = 'keyword';
        ef.regexAllowed = REGEX_OK_KEYWORDS.has(word);
      } else {
        ef.regexAllowed = false;
      }
      continue;
    }
    // 其余一律按运算符/标点处理(至少消费一个字符,'/' 除外——它单独结算以便下一发正则消歧)
    emit('punct', at);
    i++;
    while (i < text.length) {
      const pc = text[i]!;
      if (isSpace(pc) || isDigit(pc) || isIdentStart(pc) || pc === '"' || pc === "'" || pc === '`' || pc === '/') break;
      i++;
    }
    const first = text[at]!;
    if (first === '}') {
      if (st.stack.length > 1) {
        if (ef.depth === 0) {
          st.stack.pop(); // 插值闭合,回到模板文本
        } else {
          ef.depth--;
          ef.regexAllowed = false;
        }
      } else {
        ef.regexAllowed = false; // 全局 '}' 之后不算正则起点
      }
    } else if (first === ')' || first === ']') {
      ef.regexAllowed = false;
    } else {
      ef.regexAllowed = true;
    }
  }
  return { tokens, end: st };
}

export class Highlighter {
  private lines: string[] = [];
  private states: HState[] = [];  // states[i] = 第 i 行的起始状态
  private toks: Token[][] = [];   // tokens 缓存

  constructor(lang: 'js') {
    if (lang !== 'js') throw new Error(`不支持的语言: ${lang}`);
    this.setText('');
  }

  /** 整文重置(全量重扫) */
  setText(text: string): void {
    this.lines = text.split('\n');
    this.states = [initialState()];
    this.toks = [];
    for (let i = 0; i < this.lines.length; i++) {
      const { tokens, end } = scanLine(this.lines[i]!, this.states[i]!);
      this.toks.push(tokens);
      this.states.push(end);
    }
  }

  /** 单行替换 + 级联增量重扫 */
  editLine(n: number, text: string): void {
    if (n < 0 || n >= this.lines.length) throw new RangeError(`行号越界: ${n}`);
    this.lines[n] = text;
    this.toks[n] = scanLine(text, this.states[n]!).tokens;
    let i = n;
    while (i + 1 < this.lines.length) {
      const { end } = scanLine(this.lines[i]!, this.states[i]!);
      if (stateEqual(end, this.states[i + 1]!)) break; // 收敛:后续行不受影响
      this.states[i + 1] = end;
      this.toks[i + 1] = scanLine(this.lines[i + 1]!, end).tokens;
      i++;
    }
  }

  lineCount(): number {
    return this.lines.length;
  }

  /** 第 n 行高亮结果(0 基) */
  line(n: number): { text: string; tokens: Token[] } {
    if (n < 0 || n >= this.lines.length) throw new RangeError(`行号越界: ${n}`);
    return { text: this.lines[n]!, tokens: this.toks[n]! };
  }

  /** 整文重算(对照基准:增量结果必须与之逐行一致) */
  highlightAll(): { text: string; tokens: Token[] }[] {
    const out: { text: string; tokens: Token[] }[] = [];
    let st = initialState();
    for (const ln of this.lines) {
      const r = scanLine(ln, st);
      out.push({ text: ln, tokens: r.tokens });
      st = r.end;
    }
    return out;
  }
}

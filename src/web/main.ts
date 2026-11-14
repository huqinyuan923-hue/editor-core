/**
 * editor-lab:canvas 自绘编辑器 UI(piece table 内核 + vim 模式开关)。
 * 行列像素对齐、当前行高亮、多光标闪烁、vim 模式指示。
 */
import { Editor } from '../editor';
import type { Sel } from '../editor';
import { Highlighter } from '../highlighter';
import type { TokenKind } from '../highlighter';
import { VimLayer } from '../vim';

const SAMPLE = `// editor-lab —— 零依赖代码编辑器内核演示
// 试试:Alt+点击 加光标 | 勾选 vim 模式后 hjkl / dd / yy / p / 3w
// Ctrl+Z / Ctrl+Y 走内核 undo/redo 合并栈

const editor = {
  doc: new PieceTable(originalText),   // piece table + treap 前缀和
  cursors: [{ anchor: 0, active: 0 }], // 多光标,anchor <= active
  undo: new MergeStack(),              // 连续输入合并,换行/超时断开
};

function render(line, tokens) {
  let x = 0;
  for (const t of tokens) {
    draw(text.slice(t.start), COLORS[t.kind]);
    x += width(t.kind);
  }
  return x; // 行迭代器逐行喂给 canvas
}

const RE = /^hello\\s+world$/gi;
const tpl = \`模板串 \${editor.doc.lineCount()} 行\`;
/* 块注释跨行
   增量高亮:单行编辑只重算受影响行 */
export default editor;
`;

const COLORS: Record<TokenKind, string> = {
  keyword: '#c792ea',
  identifier: '#82aaff',
  number: '#f78c6c',
  string: '#c3e88d',
  template: '#c3e88d',
  regex: '#ff5370',
  comment: '#5c6370',
  punct: '#89ddff',
  whitespace: '#ffffff',
};

const BG = '#1e1e2e';
const FG = '#d4d4d4';
const CUR_LINE = 'rgba(255,255,255,0.055)';
const SEL_BG = 'rgba(130,170,255,0.25)';
const GUTTER = 52; // 行号槽宽
const FONT = '14px ui-monospace, Consolas, "Courier New", monospace';

const canvas = document.getElementById('editor') as HTMLCanvasElement;
const modeEl = document.getElementById('mode') as HTMLElement;
const pendingEl = document.getElementById('pending') as HTMLElement;
const posEl = document.getElementById('pos') as HTMLElement;
const statEl = document.getElementById('stat') as HTMLElement;
const vimToggle = document.getElementById('vim-toggle') as HTMLInputElement;

const ed = new Editor(SAMPLE, { mergeTimeoutMs: 1000 });
const hl = new Highlighter('js');
hl.setText(SAMPLE);
const vim = new VimLayer(ed);

let scrollLine = 0;
let scrollCol = 0;
let charW = 8.4;
let lineH = 21;

function measureFont(ctx: CanvasRenderingContext2D): void {
  ctx.font = FONT;
  charW = ctx.measureText('M').width;
}

function syncHighlight(): void {
  // 行数不变时逐行差分,只重算变化的行(生产路径走 editLine 增量)
  const docLines = [...ed.doc.lines()];
  if (docLines.length === hl.lineCount()) {
    for (let i = 0; i < docLines.length; i++) {
      if (hl.line(i).text !== docLines[i]) {
        hl.editLine(i, docLines[i]!);
      }
    }
  } else {
    hl.setText(docLines.join('\n'));
  }
}

function ensureVisible(): void {
  const c = ed.cursors[0]!;
  const { line, col } = ed.doc.offsetToLineCol(c.active);
  const rows = Math.floor(canvas.height / lineH) - 1;
  if (line < scrollLine) scrollLine = line;
  if (line >= scrollLine + rows) scrollLine = line - rows + 1;
  if (col < scrollCol) scrollCol = col;
  if (col >= scrollCol + Math.floor(canvas.width / charW) - 8) {
    scrollCol = col - Math.floor(canvas.width / charW) + 8;
  }
  if (scrollCol < 0) scrollCol = 0;
}

function render(now: number): void {
  const ctx = canvas.getContext('2d')!;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = FONT;
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, w, h);

  const rows = Math.ceil(h / lineH);
  const cols = Math.ceil((w - GUTTER) / charW);
  const blinkOn = Math.floor(now / 530) % 2 === 0;

  // 当前行高亮
  for (const c of ed.cursors) {
    const { line } = ed.doc.offsetToLineCol(c.active);
    if (line >= scrollLine && line < scrollLine + rows) {
      ctx.fillStyle = CUR_LINE;
      ctx.fillRect(0, (line - scrollLine) * lineH, w, lineH);
    }
  }
  // 选择区
  ctx.fillStyle = SEL_BG;
  for (const c of ed.cursors) {
    const a = Math.min(c.anchor, c.active), b = Math.max(c.anchor, c.active);
    if (a === b) continue;
    const la = ed.doc.offsetToLineCol(a), lb = ed.doc.offsetToLineCol(b);
    for (let ln = la.line; ln <= lb.line; ln++) {
      const from = ln === la.line ? la.col : 0;
      const to = ln === lb.line ? lb.col : ed.doc.lineEndOffset(ln) - ed.doc.lineStartOffset(ln);
      ctx.fillRect(
        GUTTER + (from - scrollCol) * charW,
        (ln - scrollLine) * lineH,
        Math.max(2, (to - from) * charW),
        lineH,
      );
    }
  }
  // 文本(按 token 着色)
  for (let r = 0; r < rows; r++) {
    const ln = scrollLine + r;
    if (ln >= hl.lineCount()) break;
    const { text, tokens } = hl.line(ln);
    for (let ti = 0; ti < tokens.length; ti++) {
      const t = tokens[ti]!;
      const end = ti + 1 < tokens.length ? tokens[ti + 1]!.start : text.length;
      const kind = t.kind;
      ctx.fillStyle = kind === 'whitespace' ? FG : COLORS[kind];
      const from = Math.max(t.start, scrollCol);
      const to = Math.min(end, scrollCol + cols);
      if (to > from) {
        ctx.fillText(text.slice(from, to), GUTTER + (from - scrollCol) * charW, r * lineH + 15);
      }
    }
    // 行号(右对齐于行号槽)
    ctx.fillStyle = '#45475a';
    const numStr = String(ln + 1);
    ctx.fillText(numStr, GUTTER - 10 - numStr.length * charW * 0.6, r * lineH + 15);
  }
  // 光标(vim normal 为块状,其余为竖线;闪烁)
  for (const c of ed.cursors) {
    const { line, col } = ed.doc.offsetToLineCol(c.active);
    if (line < scrollLine || line >= scrollLine + rows) continue;
    const x = GUTTER + (col - scrollCol) * charW;
    const y = (line - scrollLine) * lineH;
    ctx.fillStyle = blinkOn ? '#aeffff' : 'rgba(174,255,255,0.25)';
    if (vimOn && vim.mode === 'normal') {
      ctx.fillRect(x, y, charW, lineH);
    } else {
      ctx.fillRect(x, y, 2, lineH);
    }
  }
  // 状态栏
  const c0 = ed.cursors[0]!;
  const lc = ed.doc.offsetToLineCol(c0.active);
  const modeName = vimOn ? vim.mode.toUpperCase() : 'EDIT';
  modeEl.textContent = modeName;
  modeEl.className = vimOn ? vim.mode : 'edit';
  pendingEl.textContent = vimOn ? vim.pending : '';
  posEl.textContent = `Ln ${lc.line + 1}, Col ${lc.col + 1}`;
  statEl.textContent = `${ed.cursors.length} 光标 · ${ed.doc.length} 字符 · ${ed.doc.lineCount()} 行`;
  ensureVisible();
  requestAnimationFrame(render);
}

// ---------- 编辑入口 ----------

let vimOn = false;
vimToggle.addEventListener('change', () => {
  vimOn = vimToggle.checked;
  if (!vimOn) {
    // 退出 vim:光标收拢为普通光标
    ed.setSelections(ed.cursors.map((c) => ({ anchor: c.active, active: c.active })));
  }
  canvas.focus();
});

function moveAll(dx: number, dy: number, extend: boolean): void {
  const sels: Sel[] = [];
  for (const c of ed.cursors) {
    const active = extend ? c.active : c.anchor;
    const la = ed.doc.offsetToLineCol(Math.min(c.anchor, c.active));
    if (dy !== 0) {
      const line = Math.min(Math.max(la.line + dy, 0), ed.doc.lineCount() - 1);
      const start = ed.doc.lineStartOffset(line);
      const len = ed.doc.lineEndOffset(line) - start;
      const col = Math.min(la.col, len);
      const p = start + col;
      sels.push(extend ? { anchor: c.anchor, active: p } : { anchor: p, active: p });
    } else {
      const p = Math.min(Math.max(active + dx, 0), ed.doc.length);
      sels.push(extend ? { anchor: c.anchor, active: p } : { anchor: p, active: p });
    }
  }
  ed.setSelections(sels);
}

function toLineColStart(): void {
  ed.setSelections(ed.cursors.map((c) => {
    const { line } = ed.doc.offsetToLineCol(c.active);
    const p = ed.doc.lineStartOffset(line);
    return { anchor: p, active: p };
  }));
}
function toLineColEnd(): void {
  ed.setSelections(ed.cursors.map((c) => {
    const { line } = ed.doc.offsetToLineCol(c.active);
    const p = ed.doc.lineEndOffset(line);
    return { anchor: p, active: p };
  }));
}

canvas.addEventListener('keydown', (ev) => {
  const k = ev.key;
  if (vimOn) {
    if (k === 'ArrowLeft') { vim.feedKey('h'); }
    else if (k === 'ArrowRight') { vim.feedKey('l'); }
    else if (k === 'ArrowUp') { vim.feedKey('k'); }
    else if (k === 'ArrowDown') { vim.feedKey('j'); }
    else if (k === 'Escape') { vim.feedKey('Esc'); }
    else if (k === 'Enter') { vim.feedKey('Enter'); }
    else if (k === 'Backspace') { vim.feedKey('Backspace'); }
    else if (k.length === 1 && !ev.ctrlKey && !ev.metaKey) { vim.feedKey(k); }
    else return;
    ev.preventDefault();
    syncHighlight();
    return;
  }
  // 普通编辑模式
  if (ev.ctrlKey && (k === 'z' || k === 'Z')) { if (ev.shiftKey) ed.redo(); else ed.undo(); ev.preventDefault(); }
  else if (ev.ctrlKey && (k === 'y' || k === 'Y')) { ed.redo(); ev.preventDefault(); }
  else if (k === 'ArrowLeft') { moveAll(-1, 0, ev.shiftKey); ev.preventDefault(); }
  else if (k === 'ArrowRight') { moveAll(1, 0, ev.shiftKey); ev.preventDefault(); }
  else if (k === 'ArrowUp') { moveAll(0, -1, ev.shiftKey); ev.preventDefault(); }
  else if (k === 'ArrowDown') { moveAll(0, 1, ev.shiftKey); ev.preventDefault(); }
  else if (k === 'Home') { toLineColStart(); ev.preventDefault(); }
  else if (k === 'End') { toLineColEnd(); ev.preventDefault(); }
  else if (k === 'Backspace') { ed.backspace(); ev.preventDefault(); }
  else if (k === 'Delete') {
    ed.setSelections(ed.cursors.map((c) => {
      const a = Math.min(c.anchor, c.active);
      const b = Math.max(c.anchor, c.active);
      return b > a ? { anchor: a, active: b } : { anchor: c.active, active: Math.min(c.active + 1, ed.doc.length) };
    }));
    ed.backspace();
    ev.preventDefault();
  }
  else if (k === 'Enter') { ed.type('\n'); ev.preventDefault(); }
  else if (k === 'Tab') { ed.type('  '); ev.preventDefault(); }
  else if (k.length === 1 && !ev.ctrlKey && !ev.metaKey) { ed.type(k); ev.preventDefault(); }
  else return;
  syncHighlight();
});

canvas.addEventListener('mousedown', (ev) => {
  const rect = canvas.getBoundingClientRect();
  const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
  const line = Math.min(scrollLine + Math.floor(y / lineH), ed.doc.lineCount() - 1);
  const col = Math.max(0, Math.round((x - GUTTER) / charW) + scrollCol);
  const p = ed.doc.lineStartOffset(line) + Math.min(col, ed.doc.lineEndOffset(line) - ed.doc.lineStartOffset(line));
  if (ev.altKey) {
    // Alt+点击:增删光标(点击已有光标处则移除)
    const rest = ed.cursors.filter((c) => c.active !== p);
    const sels = rest.length > 0 ? rest : [{ anchor: p, active: p } as Sel];
    if (!rest.some((c) => c.active === p) && rest.length > 0) sels.push({ anchor: p, active: p });
    ed.setSelections(sels);
  } else if (ev.shiftKey) {
    const cur = ed.cursors[0]!;
    ed.setSelections([{ anchor: cur.anchor, active: p }]);
  } else {
    ed.setSelections([{ anchor: p, active: p }]);
    if (vimOn) vim.feedKey('Esc'); // 鼠标定位后回 normal 态
  }
  canvas.focus();
});

canvas.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  if (ev.deltaY > 0) scrollLine += 3; else scrollLine -= 3;
  scrollLine = Math.min(Math.max(scrollLine, 0), Math.max(0, ed.doc.lineCount() - 2));
  if (ev.shiftKey) {
    scrollCol += ev.deltaY > 0 ? 4 : -4;
    if (scrollCol < 0) scrollCol = 0;
  }
}, { passive: false });

function fit(): void {
  canvas.width = canvas.clientWidth * (window.devicePixelRatio || 1);
  canvas.height = canvas.clientHeight * (window.devicePixelRatio || 1);
  const ctx = canvas.getContext('2d')!;
  measureFont(ctx);
}
window.addEventListener('resize', fit);
fit();
canvas.focus();
requestAnimationFrame(render);

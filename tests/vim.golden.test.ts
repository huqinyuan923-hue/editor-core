import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Editor } from '../src/editor';
import { VimLayer } from '../src/vim';

/**
 * M5 验收 #5:VimLayer 行为对照真机 vim(-u NONE 实测 golden,禁止手编)。
 * golden 由 scripts/gen-vim-golden.mjs 生成;实现与真机不一致时改实现,不改 golden。
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN: {
  name: string;
  init: string[];
  cursor: [number, number];
  keys: string;
  outLines: string[];
  outCursor: [number, number];
}[] = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'vim-golden.json'), 'utf8'));

/** 把 normal! 键序列拆成逐键输入('\<Esc>' → 'Esc') */
function splitKeys(keys: string): string[] {
  const out: string[] = [];
  const s = keys.replace(/\\<Esc>/g, '\u0001');
  for (const ch of s) out.push(ch === '\u0001' ? 'Esc' : ch);
  return out;
}

function runCase(c: (typeof GOLDEN)[number]): { lines: string[]; cursor: [number, number] } {
  const ed = new Editor(c.init.join('\n'), { mergeTimeoutMs: Infinity });
  const vim = new VimLayer(ed);
  const [L, C] = c.cursor;
  const p = ed.doc.lineStartOffset(L - 1) + (C - 1);
  ed.setSelections([{ anchor: p, active: p }]);
  for (const k of splitKeys(c.keys)) vim.feedKey(k);
  const pos = ed.cursors[0]!.active;
  const { line, col } = ed.doc.offsetToLineCol(pos);
  return { lines: [...ed.doc.lines()], cursor: [line + 1, col + 1] };
}

describe('VimLayer 对照 vim -u NONE 实测 golden', () => {
  for (const c of GOLDEN) {
    it(c.name, () => {
      const r = runCase(c);
      expect(r.lines).toEqual(c.outLines);
      expect(r.cursor).toEqual(c.outCursor);
    });
  }
  it('golden 覆盖 ≥30 条', () => {
    expect(GOLDEN.length).toBeGreaterThanOrEqual(30);
  });
});

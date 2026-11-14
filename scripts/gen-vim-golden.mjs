/**
 * Vim golden 生成器:用本机 vim -u NONE(silent ex 模式)实测每个场景,
 * 产出 tests/fixtures/vim-golden.json。golden 一律以真机为准,禁止手编。
 *
 * 实现要点:
 * - 初始文本写入临时文件后由 vim 打开——文件读取不属于可撤销变更,
 *   这样场景里的 u 才真正撤销的是场景操作本身(而不是建行命令);
 * - 结果用 writefile(getline(1,'$')) 落盘回读,空行不会被 -es 的 %p 打成空格。
 *
 * 用法:node scripts/gen-vim-golden.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = join(ROOT, '.tmp');

const T1 = ['foo bar baz qux'];
const T2 = ['alpha beta', 'gamma delta', 'epsilon'];
const T3 = ['one', 'two', 'three', 'four', 'five'];
const T4 = ['abcdef', 'xy', 'longer line'];
const T5 = ['foo', 'bar'];

// 场景:name / 初始行 / 光标(1 基行,列)/ normal! 键序列
const CASES = [
  { name: 'd3w_词首', lines: T1, cursor: [1, 1], keys: 'd3w' },
  { name: 'dw_词中', lines: T1, cursor: [1, 5], keys: 'dw' },
  { name: '3dw_计数前', lines: T1, cursor: [1, 1], keys: '3dw' },
  { name: 'd2w_计数后', lines: T1, cursor: [1, 1], keys: 'd2w' },
  { name: 'de_词尾含', lines: T1, cursor: [1, 7], keys: 'de' },
  { name: 'db_反向', lines: T1, cursor: [1, 9], keys: 'db' },
  { name: 'd$_到行尾', lines: T1, cursor: [1, 5], keys: 'd$' },
  { name: 'd0_到行首', lines: T2, cursor: [2, 3], keys: 'd0' },
  { name: 'dw_末词行尾特判', lines: T1, cursor: [1, 13], keys: 'dw' },
  { name: 'dw_跨行合并', lines: T5, cursor: [1, 1], keys: 'dw' },
  { name: '2dd', lines: T2, cursor: [2, 1], keys: '2dd' },
  { name: 'dd', lines: T3, cursor: [2, 1], keys: 'dd' },
  { name: '3dd', lines: T3, cursor: [2, 1], keys: '3dd' },
  { name: 'ddp_下移', lines: T3, cursor: [2, 1], keys: 'ddp' },
  { name: 'yyjp_复制粘贴', lines: T3, cursor: [1, 1], keys: 'yyjp' },
  { name: 'yyp_复制一行', lines: T3, cursor: [1, 1], keys: 'yyp' },
  { name: '2yyp', lines: T3, cursor: [1, 1], keys: '2yyp' },
  { name: 'x', lines: T1, cursor: [1, 2], keys: 'x' },
  { name: '3x', lines: T1, cursor: [1, 1], keys: '3x' },
  { name: 'x_行尾', lines: T1, cursor: [1, 15], keys: 'x' },
  { name: 'xp_交换字符', lines: T1, cursor: [1, 1], keys: 'xp' },
  { name: 'rx_替换', lines: T1, cursor: [1, 1], keys: 'rx' },
  { name: '3ro_计数替换', lines: T1, cursor: [1, 1], keys: '3ro' },
  { name: 'w', lines: T1, cursor: [1, 1], keys: 'w' },
  { name: '3w', lines: T1, cursor: [1, 1], keys: '3w' },
  { name: 'w_跨行', lines: T2, cursor: [1, 7], keys: 'w' },
  { name: 'b_跨行回退', lines: T2, cursor: [2, 1], keys: 'b' },
  { name: 'e', lines: T1, cursor: [1, 1], keys: 'e' },
  { name: '2e', lines: T1, cursor: [1, 1], keys: '2e' },
  { name: '$', lines: T2, cursor: [1, 5], keys: '$' },
  { name: '0', lines: T2, cursor: [2, 5], keys: '0' },
  { name: 'G_末行', lines: T3, cursor: [3, 1], keys: 'G' },
  { name: 'gg_首行', lines: T3, cursor: [3, 2], keys: 'gg' },
  { name: '3G_计数行', lines: T3, cursor: [1, 1], keys: '3G' },
  { name: 'jj_列记忆', lines: T4, cursor: [1, 5], keys: 'jj' },
  { name: 'j_短行钳制', lines: T4, cursor: [1, 5], keys: 'j' },
  { name: 'j_保列', lines: T2, cursor: [1, 3], keys: 'j' },
  { name: 'v3wd_可视删除', lines: T1, cursor: [1, 1], keys: 'v3wd' },
  { name: 'veyp_可视复制粘贴', lines: T1, cursor: [1, 5], keys: 'veyp' },
  { name: 'vjd_可视跨行删除', lines: T2, cursor: [2, 1], keys: 'vjd' },
  { name: 'i_插入退出', lines: T1, cursor: [1, 1], keys: 'iXY\\<Esc>' },
  { name: 'a_后插', lines: T1, cursor: [1, 1], keys: 'aXY\\<Esc>' },
  { name: 'A_行尾插', lines: T1, cursor: [1, 1], keys: 'A!?\\<Esc>' },
  { name: 'o_下开行', lines: T2, cursor: [1, 1], keys: 'oNEW\\<Esc>' },
  { name: 'O_上开行', lines: T2, cursor: [2, 1], keys: 'ONEW\\<Esc>' },
  { name: 'u_撤dd', lines: T3, cursor: [2, 1], keys: 'ddu' },
  { name: 'u_撤x', lines: T1, cursor: [1, 2], keys: 'xu' },
  { name: '2dd_u', lines: T2, cursor: [2, 1], keys: '2ddu' },
  { name: 'd2e', lines: T1, cursor: [1, 1], keys: 'd2e' },
  { name: 'd2w_行级升级', lines: T5, cursor: [1, 1], keys: 'd2w' },
  { name: '2dw_行级升级', lines: T5, cursor: [1, 1], keys: '2dw' },
  { name: 'd1w_行尾回退', lines: T5, cursor: [1, 1], keys: 'd1w' },
  { name: 'd2w_起点非行首', lines: T5, cursor: [1, 3], keys: 'd2w' },
  { name: 'd2w_跨行词内目标', lines: T5, cursor: [1, 1], keys: 'd3w' },
  { name: 'd2j_计数不可达', lines: T3.slice(0, 3), cursor: [2, 1], keys: 'd2j' },
  { name: '2j_计数不可达', lines: T3.slice(0, 3), cursor: [2, 1], keys: '2j' },
  { name: 'j_计数可达', lines: T3, cursor: [1, 1], keys: '2j' },
  { name: 'dw_末行词', lines: T5, cursor: [2, 1], keys: 'dw' },
  { name: 'd2w_起点非行首_跨行', lines: ['foo bar', 'baz'], cursor: [1, 5], keys: 'd2w' },
];

function runCase(c, idx) {
  const inFile = join(TMP, `vim-golden-${idx}-in.txt`);
  const outFile = join(TMP, `vim-golden-${idx}-out.txt`);
  writeFileSync(inFile, c.lines.join('\n') + '\n', 'utf8');
  rmSync(outFile, { force: true });
  const args = [
    '-u', 'NONE', '-i', 'NONE', '-es', inFile,
    '--cmd', 'set noswapfile shortmess+=A fileformat=unix',
    '-c', `call cursor(${c.cursor[0]}, ${c.cursor[1]})`,
    '-c', `execute "normal! ${c.keys}"`,
    '-c', `call writefile(getline(1, '$') + ['@@CURSOR ' . line('.') . ' ' . col('.')], '${outFile.replace(/\\/g, '/')}')`,
    '-c', 'qa!',
  ];
  const r = spawnSync('vim', args, { timeout: 15000, input: '' });
  if (r.error) throw new Error(`vim 启动失败: ${r.error.message}`);
  const out = readFileSync(outFile, 'utf8').split('\n').map((s) => s.replace(/\r$/, ''));
  while (out.length && out[out.length - 1] === '') out.pop();
  const marker = out[out.length - 1] ?? '';
  if (!marker.startsWith('@@CURSOR ')) {
    throw new Error(`场景 ${c.name}:输出无光标标记。stdout=${JSON.stringify(String(r.stdout))} stderr=${JSON.stringify(String(r.stderr))}`);
  }
  const [, l, col] = marker.split(' ');
  return { name: c.name, init: c.lines, cursor: c.cursor, keys: c.keys, outLines: out.slice(0, -1), outCursor: [Number(l), Number(col)] };
}

mkdirSync(TMP, { recursive: true });
const results = [];
for (let i = 0; i < CASES.length; i++) {
  const c = CASES[i];
  if (!c) continue;
  try {
    results.push(runCase(c, i));
    console.log(`ok  ${c.name}`);
  } catch (e) {
    console.error(`FAIL ${c.name}: ${e.message}`);
    process.exitCode = 1;
  }
}
const dir = join(ROOT, 'tests', 'fixtures');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'vim-golden.json'), JSON.stringify(results, null, 2), 'utf8');
console.log(`\n写入 ${results.length} 条 golden → tests/fixtures/vim-golden.json`);

/**
 * 把 assets/logo.svg 渲染成位图（供 make-icons.mjs 使用）。
 *
 * 同时产出两个版本：
 *  - assets/logo-1024.png    原色（蓝色盾牌）
 *  - assets/logo-on-1024.png 绿色系（「已启用」状态）
 *
 * 用无头 Chrome 渲染，保证和页面里看到的 SVG 完全一致（不依赖第三方库）。
 * 用法：node scripts/render-svg.mjs
 * 可用 CHROME_PATH 指定 Chrome 路径。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const CHROME =
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SOURCE = join(root, 'assets', 'logo.svg');
const SIZE = 1024;

// 蓝色 → 绿色（保留原图左右两半的明暗关系）
const GREEN_MAP = [
  ['#508EF3', '#34D399'],
  ['#3278EB', '#10B981'],
];

if (!existsSync(CHROME)) {
  console.error(`找不到 Chrome：${CHROME}\n可以用 CHROME_PATH=/path/to/chrome 指定。`);
  process.exit(1);
}

const svg = readFileSync(SOURCE, 'utf8');
const match = svg.match(/<svg[\s\S]*<\/svg>/i);
if (!match) {
  console.error('assets/logo.svg 里没有找到 <svg> 元素');
  process.exit(1);
}

/** 生成绿色版本（只替换填充色，白色钥匙孔不动） */
function toGreen(svgText) {
  let next = svgText;
  for (const [from, to] of GREEN_MAP) {
    next = next.replace(new RegExp(from, 'gi'), to);
  }
  return next;
}

function render(svgElement, output) {
  const workDir = mkdtempSync(join(tmpdir(), 'logo-render-'));
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; background: transparent; }
  svg { display: block; width: ${SIZE}px; height: ${SIZE}px; }
</style></head><body>${svgElement}</body></html>`;
  const htmlFile = join(workDir, 'logo.html');
  writeFileSync(htmlFile, html);

  try {
    execFileSync(
      CHROME,
      [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--hide-scrollbars',
        '--default-background-color=00000000',
        `--user-data-dir=${join(workDir, 'profile')}`,
        `--screenshot=${output}`,
        `--window-size=${SIZE},${SIZE}`,
        `file://${htmlFile}`,
      ],
      { stdio: 'pipe', timeout: 60_000 },
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  if (!existsSync(output)) throw new Error(`渲染失败：${output}`);
  console.log(`已生成 ${output.replace(root + '/', '')}`);
}

const element = match[0]
  .replace(/\swidth="[^"]*"/i, '')
  .replace(/\sheight="[^"]*"/i, '')
  .replace(/\sclass="[^"]*"/i, '');

render(element, join(root, 'assets', 'logo-1024.png'));
render(toGreen(element), join(root, 'assets', 'logo-on-1024.png'));
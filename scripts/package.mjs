/**
 * 打一个只含运行期文件的 zip（manifest / src / icons / _locales）。
 *
 * 排除 docs、tests、scripts、assets、README、package.json 等开发文件，
 * 便于分发给别人安装或自行压缩上传。
 *
 * 用法：node scripts/package.mjs [--skip-check]
 * 产物：dist/chrome-auth-plugin-<version>.zip
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const distDir = join(root, 'dist');
const stageDir = join(distDir, 'package');

const ZIP_FILES = ['manifest.json', 'src', 'icons', '_locales'];
const FORBIDDEN = [/\.map$/, /\.md$/, /^tests\//, /^docs\//, /^scripts\//, /^assets\//, /^dist\//];

if (!process.argv.includes('--skip-check')) {
  execFileSync(process.execPath, [join(root, 'scripts', 'check.mjs')], { stdio: 'inherit' });
}

const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });
for (const entry of ZIP_FILES) {
  cpSync(join(root, entry), join(stageDir, entry), { recursive: true });
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(stageDir);
const offenders = files.filter((file) => {
  const rel = relative(stageDir, file).replaceAll('\\', '/');
  return FORBIDDEN.some((rule) => rule.test(rel));
});
if (offenders.length > 0) {
  console.error('打包目录里出现了不该发布的文件：');
  for (const file of offenders) console.error(' -', relative(stageDir, file));
  process.exit(1);
}

// manifest 里引用的文件必须都在
const referenced = new Set([
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  manifest.options_ui?.page,
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action?.default_icon || {}),
  '_locales/zh_CN/messages.json',
  '_locales/en/messages.json',
].filter(Boolean));
for (const path of referenced) {
  if (!existsSync(join(stageDir, path))) {
    console.error(`打包缺少 manifest 引用的文件：${path}`);
    process.exit(1);
  }
}

const zipName = `chrome-auth-plugin-${manifest.version}.zip`;
const zipPath = join(distDir, zipName);
rmSync(zipPath, { force: true });
execFileSync('zip', ['-r', '-q', zipPath, ...ZIP_FILES], { cwd: stageDir });

const bytes = statSync(zipPath).size;
writeFileSync(
  join(distDir, 'package-files.txt'),
  `${files.map((file) => relative(stageDir, file)).sort().join('\n')}\n`,
);
console.log(`\n已生成 ${relative(root, zipPath)}（${(bytes / 1024).toFixed(0)} KB，${files.length} 个文件）`);
console.log(`文件清单：${relative(root, join(distDir, 'package-files.txt'))}`);

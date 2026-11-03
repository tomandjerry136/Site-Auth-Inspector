/**
 * 项目自检（无依赖）：
 *  - manifest 结构、引用的文件是否存在、图标尺寸是否正确
 *  - 所有 JS 语法检查
 *  - HTML 中不允许内联脚本（MV3 CSP 会拦截）
 *  - 关键文件与目录是否齐全
 *
 * 用法：node scripts/check.mjs
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const notes = [];

function fail(message) {
  problems.push(message);
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------
const manifestPath = join(root, 'manifest.json');
if (!existsSync(manifestPath)) {
  console.error('✗ 缺少 manifest.json');
  process.exit(1);
}
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (error) {
  console.error(`✗ manifest.json 不是合法 JSON：${error.message}`);
  process.exit(1);
}

if (manifest.manifest_version !== 3) fail('manifest_version 必须是 3');
for (const key of ['name', 'version', 'description']) {
  if (!manifest[key]) fail(`manifest 缺少 ${key}`);
}
if (manifest.name && manifest.name.length > 45) fail('name 超过 Chrome 商店 45 字符限制');
if (manifest.description && manifest.description.length > 132) fail('description 超过 Chrome 商店 132 字符限制');
if (!manifest.background?.service_worker) fail('缺少 background.service_worker');
if (manifest.background?.type !== 'module') fail('background 需要 type: module 才能 import 本地模块');
if (!manifest.action?.default_popup) fail('缺少 action.default_popup');
if (!manifest.action?.default_icon) fail('缺少 action.default_icon');
if (!manifest.icons) fail('缺少 icons');
if (!Array.isArray(manifest.permissions)) fail('permissions 必须是数组');
if (!Array.isArray(manifest.optional_host_permissions)) fail('缺少 optional_host_permissions（按站点授权依赖它）');

const requiredPermissions = ['storage', 'scripting', 'cookies', 'activeTab'];
for (const permission of requiredPermissions) {
  if (!manifest.permissions?.includes(permission)) fail(`permissions 缺少 ${permission}`);
}
if (manifest.permissions?.includes('webRequest') || manifest.permissions?.includes('tabs')) {
  notes.push('检测到 webRequest / tabs 权限，请确认是否必要（会扩大权限提示范围）');
}

// ---------------------------------------------------------------------------
// 引用文件
// ---------------------------------------------------------------------------
const referenced = new Set();
if (manifest.background?.service_worker) referenced.add(manifest.background.service_worker);
if (manifest.action?.default_popup) referenced.add(manifest.action.default_popup);
if (manifest.options_ui?.page) referenced.add(manifest.options_ui.page);
for (const path of Object.values(manifest.icons || {})) referenced.add(path);
for (const path of Object.values(manifest.action?.default_icon || {})) referenced.add(path);

for (const path of referenced) {
  if (!existsSync(join(root, path))) fail(`manifest 引用的文件不存在：${path}`);
}

// 图标尺寸
function pngSize(file) {
  const buffer = readFileSync(file);
  if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

for (const [size, path] of Object.entries(manifest.icons || {})) {
  const file = join(root, path);
  if (!existsSync(file)) continue;
  const dimensions = pngSize(file);
  if (!dimensions) fail(`图标不是有效 PNG：${path}`);
  else if (dimensions.width !== Number(size) || dimensions.height !== Number(size)) {
    fail(`图标 ${path} 尺寸应为 ${size}x${size}，实际 ${dimensions.width}x${dimensions.height}`);
  }

  // 工具栏「已启用」变体：与普通图标同尺寸，必须存在
  const activePath = path.replace(/(\d+)\.png$/, '$1-on.png');
  const activeFile = join(root, activePath);
  if (!existsSync(activeFile)) {
    fail(`缺少「已启用」状态图标：${activePath}`);
  } else {
    const activeSize = pngSize(activeFile);
    if (!activeSize || activeSize.width !== Number(size) || activeSize.height !== Number(size)) {
      fail(`状态图标 ${activePath} 尺寸应为 ${size}x${size}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 脚本与页面
// ---------------------------------------------------------------------------
const allFiles = walk(root);
const jsFiles = allFiles.filter((file) => file.endsWith('.js') || file.endsWith('.mjs'));
if (jsFiles.length === 0) fail('没有找到任何 JS 文件');

for (const file of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    const message = String(error.stderr || error.message).split('\n').slice(0, 4).join(' ');
    fail(`语法错误：${relative(root, file)} → ${message}`);
  }
}

for (const file of allFiles.filter((item) => item.endsWith('.html'))) {
  const html = readFileSync(file, 'utf8');
  if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)) fail(`HTML 中存在内联脚本（会被 CSP 拦截）：${relative(root, file)}`);
  if (/\son[a-z]+\s*=\s*["']/i.test(html)) fail(`HTML 中存在内联事件处理器：${relative(root, file)}`);
}

// 关键文件
const requiredFiles = [
  'src/background.js',
  'src/popup.html',
  'src/popup.js',
  'src/popup.css',
  'src/options.html',
  'src/options.js',
  'src/customize.html',
  'src/customize.css',
  'src/customize.js',
  'src/lib/customize.js',
  'src/lib/i18n.js',
  'src/lib/locales/zh.js',
  'src/lib/locales/en.js',
  '_locales/zh_CN/messages.json',
  '_locales/en/messages.json',
  'src/options.css',
  'src/lib/analyzer.js',
  'src/lib/format.js',
  'src/lib/mask.js',
  'src/lib/settings.js',
  'src/lib/state.js',
  'src/injected/hook.js',
  'src/injected/collector.js',
  'assets/logo.svg',
  'assets/logo-1024.png',
  'assets/logo-on-1024.png',
  'README.md',
];
for (const file of requiredFiles) {
  if (!existsSync(join(root, file))) fail(`缺少文件：${file}`);
}

// 体积提醒（Chrome 商店限制 2GB，但过大说明可能引入了无用文件）
const totalBytes = allFiles
  .filter((file) => !file.includes('/tests/') && !file.includes('/scripts/'))
  .reduce((total, file) => total + statSync(file).size, 0);
notes.push(`扩展本体大小约 ${(totalBytes / 1024).toFixed(1)} KB`);

// ---------------------------------------------------------------------------
// 结果
// ---------------------------------------------------------------------------
console.log(`检查 ${jsFiles.length} 个 JS 文件、${allFiles.filter((f) => f.endsWith('.html')).length} 个 HTML 文件`);
for (const note of notes) console.log(`· ${note}`);

if (problems.length > 0) {
  console.error(`\n✗ 发现 ${problems.length} 个问题：`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log('\n✓ 自检通过');

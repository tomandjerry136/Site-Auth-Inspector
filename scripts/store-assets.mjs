/**
 * 生成 Chrome Web Store 上架物料：
 *  - 截图 1280x800（中英各 3 张）
 *  - 小型宣传图 440x280（中英）
 *  - 大图 1400x560（中英）
 *
 * 用无头 Chrome 渲染 HTML 版式后截图，保证文字排版质量。
 * 依赖 docs/ 下的界面截图（先跑 E2E_SCREENSHOTS=1 node tests/e2e/run.mjs）。
 *
 * 用法：node scripts/store-assets.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const OUT = join(root, 'store');
const CHROME =
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

if (!existsSync(CHROME)) {
  console.error(`找不到 Chrome：${CHROME}\n可以用 CHROME_PATH=/path/to/chrome 指定。`);
  process.exit(1);
}

const shots = {
  result: { zh: 'popup-result.png', en: 'popup-result-en.png' },
  steps: { zh: 'popup-steps.png', en: 'popup-steps-en.png' },
  customize: { zh: 'customize.png', en: 'customize-en.png' },
  overlay: { zh: 'overlay-result.png', en: 'overlay-result.png' },
};

for (const [name, variants] of Object.entries(shots)) {
  for (const [locale, file] of Object.entries(variants)) {
    const full = join(root, 'docs', file);
    if (!existsSync(full)) {
      console.error(`缺少 ${name}(${locale}) 截图：${full}\n先运行：E2E_SCREENSHOTS=1 node tests/e2e/run.mjs`);
      process.exit(1);
    }
  }
}

const dataUri = (file) => `data:image/png;base64,${readFileSync(join(root, 'docs', file)).toString('base64')}`;

const COPY = {
  zh: {
    name: '网站鉴权分析器',
    tagline: '登录一次，就知道网站是怎么认证你的',
    features: [
      '自动识别 Cookie / Token / OAuth / SSO 等登录方式',
      '页面右下角实时显示悬浮框，登录完成点一下就出结果',
      '复制登录信息，或带说明的认证配置，直接调接口 / 发给 AI',
    ],
    scenes: [
      {
        title: '自动识别登录鉴权方式',
        subtitle: '综合 Cookie、本地存储、请求头与登录响应打分，给出方式和可信度。',
        image: 'result',
        bullets: ['Bearer / Cookie / API Key / OAuth / SAML / CAS', '可信度 + 判断依据，结果可核对'],
      },
      {
        title: '边登录边记录',
        subtitle: '启用后自动开始，页面右下角悬浮框显示进度；登录后一键结束分析。',
        image: 'steps',
        bullets: ['无需手动抓包', '刷新也不怕漏掉登录请求'],
      },
      {
        title: '想带什么就带什么',
        subtitle: '逐项勾选、改值、加自定义 Header / Cookie / URL 参数，右侧实时预览。',
        image: 'customize',
        bullets: ['登录信息 / 用法说明 / 请求头三份结果', '改动自动保存，复制即用'],
      },
    ],
    promo: { title: '网站鉴权分析器', sub: '自动识别登录方式，一键复制可直接用' },
  },
  en: {
    name: 'Site Auth Inspector',
    tagline: 'Sign in once — know exactly how the site authenticates you',
    features: [
      'Detects cookies, bearer tokens, OAuth and SSO flows',
      'A floating card on the page records the sign-in and shows the result',
      'Copy the credential, or a ready-to-use auth config for APIs and AI tools',
    ],
    scenes: [
      {
        title: 'Detects the auth method automatically',
        subtitle: 'Scores cookies, storage, request headers and login responses, then reports the method and confidence.',
        image: 'result',
        bullets: ['Bearer / cookie / API key / OAuth / SAML / CAS', 'Confidence score with evidence you can verify'],
      },
      {
        title: 'Records while you sign in',
        subtitle: 'Starts on enable, shows progress in a floating card, and finishes in one click.',
        image: 'steps',
        bullets: ['No manual request capture', 'A refresh does not lose the sign-in flow'],
      },
      {
        title: 'Send exactly what you need',
        subtitle: 'Tick, edit or add headers, cookies and URL params; preview updates live.',
        image: 'customize',
        bullets: ['Three outputs: credential, usage notes, headers', 'Changes saved automatically'],
      },
    ],
    promo: { title: 'Site Auth Inspector', sub: 'Detect auth methods, copy usable credentials' },
  },
};

function pageShell({ width, height, body }) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{width:${width}px;height:${height}px;overflow:hidden}
  body{
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
    background:#f3f5fb;color:#111827;
  }
  .wrap{position:relative;width:100%;height:100%;padding:64px 72px;display:flex;gap:56px;align-items:center}
  .glow{position:absolute;border-radius:50%;filter:blur(80px);opacity:.55}
  .g1{width:520px;height:520px;background:#c7d2fe;left:-140px;top:-160px}
  .g2{width:460px;height:460px;background:#bae6fd;right:-120px;bottom:-160px}
  .copy{position:relative;flex:1 1 auto;min-width:0;max-width:540px}
  .brand{display:flex;align-items:center;gap:12px;margin-bottom:22px}
  .brand img{width:44px;height:44px;border-radius:12px;background:#fff;padding:3px;box-shadow:0 6px 18px rgba(16,24,40,.12)}
  .brand b{font-size:15px;letter-spacing:.01em;color:#3730a3}
  h1{font-size:46px;line-height:1.18;letter-spacing:-.02em;margin-bottom:14px}
  .sub{font-size:19px;line-height:1.6;color:#4b5563;margin-bottom:22px}
  ul{list-style:none;display:flex;flex-direction:column;gap:12px}
  li{display:flex;gap:10px;font-size:16px;color:#374151;line-height:1.5}
  li::before{content:"";flex:0 0 auto;width:18px;height:18px;margin-top:2px;border-radius:50%;
    background:linear-gradient(135deg,#4f46e5,#0ea5e9);box-shadow:0 2px 6px rgba(79,70,229,.35)}
  .shot{position:relative;flex:0 0 auto;display:flex;align-items:center;justify-content:center;gap:18px}
  .shot img{border-radius:16px;box-shadow:0 24px 60px rgba(16,24,40,.22),0 2px 6px rgba(16,24,40,.1)}
  .popup img{width:400px}
  .overlay img{width:330px;border-radius:14px}
  .customize img{width:520px;border-radius:14px}
  .badge{position:absolute;left:-26px;bottom:56px;padding:10px 16px;border-radius:999px;background:#111827;color:#fff;
    font-size:14px;font-weight:600;box-shadow:0 10px 24px rgba(17,24,39,.28)}
  </style></head><body><div class="wrap">
  <div class="glow g1"></div><div class="glow g2"></div>${body}
  </div></body></html>`;
}

function sceneHtml(copy, scene, locale) {
  const sources = {
    result: { cls: 'popup', src: shots.result[locale], width: 400 },
    steps: { cls: 'popup', src: shots.steps[locale], width: 400 },
    customize: { cls: 'customize', src: shots.customize[locale], width: 520 },
  };
  const image = { ...(sources[scene.image] ?? sources.result), src: dataUri(sources[scene.image]?.src ?? shots.result[locale]) };
  const bullets = scene.bullets.map((item) => `<li>${item}</li>`).join('');
  return pageShell({
    width: 1280,
    height: 800,
    body: `<div class="copy">
      <div class="brand"><img src="${iconUri}" alt="" /><b>${copy.name}</b></div>
      <h1>${scene.title}</h1>
      <p class="sub">${scene.subtitle}</p>
      <ul>${bullets}</ul>
    </div>
    <div class="shot ${image.cls}"><img src="${image.src}" alt="" style="width:${image.width}px" /></div>`,
  });
}

function promoHtml(copy, width, height) {
  const big = width >= 1000;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{width:${width}px;height:${height}px;overflow:hidden}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
    background:linear-gradient(135deg,#4f46e5 0%,#4338ca 45%,#0ea5e9 100%);color:#fff;
    display:flex;align-items:center;justify-content:center}
  .card{display:flex;align-items:center;gap:${big ? 40 : 22}px;padding:${big ? 64 : 34}px}
  img{width:${big ? 128 : 72}px;height:${big ? 128 : 72}px;border-radius:${big ? 30 : 18}px;background:#fff;padding:${big ? 10 : 6}px;
    box-shadow:0 18px 40px rgba(0,0,0,.25)}
  h1{font-size:${big ? 54 : 30}px;letter-spacing:-.02em;line-height:1.2}
  p{margin-top:${big ? 12 : 8}px;font-size:${big ? 22 : 15}px;color:rgba(255,255,255,.86);line-height:1.4}
  </style></head><body><div class="card">
  <img src="${iconUri}" alt="" />
  <div><h1>${copy.promo.title}</h1><p>${copy.promo.sub}</p></div>
  </div></body></html>`;
}

const iconUri = `data:image/png;base64,${readFileSync(join(root, 'icons', 'icon128.png')).toString('base64')}`;

function render(html, file, width, height) {
  const workDir = mkdtempSync(join(tmpdir(), 'store-asset-'));
  const htmlFile = join(workDir, 'page.html');
  writeFileSync(htmlFile, html);
  try {
    execFileSync(
      CHROME,
      [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--hide-scrollbars',
        `--user-data-dir=${join(workDir, 'profile')}`,
        `--screenshot=${file}`,
        `--window-size=${width},${height}`,
        `--force-device-scale-factor=1`,
        `file://${htmlFile}`,
      ],
      { stdio: 'pipe', timeout: 60_000 },
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  if (!existsSync(file)) throw new Error(`截图失败：${file}`);
  console.log(`已生成 ${file.replace(root + '/', '')}`);
}

for (const [locale, copy] of Object.entries(COPY)) {
  const dir = join(OUT, 'screenshots', locale === 'zh' ? 'zh-CN' : 'en');
  mkdirSync(dir, { recursive: true });
  copy.scenes.forEach((scene, index) => {
    render(
      sceneHtml(copy, scene, locale),
      join(dir, `${index + 1}-${['analyze', 'record', 'customize'][index]}.png`),
      1280,
      800,
    );
  });
}

const promoDir = join(OUT, 'promo');
mkdirSync(promoDir, { recursive: true });
for (const [locale, copy] of Object.entries(COPY)) {
  const suffix = locale === 'zh' ? 'zh-CN' : 'en';
  render(promoHtml(copy, 440, 280), join(promoDir, `tile-440x280-${suffix}.png`), 440, 280);
  render(promoHtml(copy, 1400, 560), join(promoDir, `marquee-1400x560-${suffix}.png`), 1400, 560);
}

console.log('\n物料目录：store/');

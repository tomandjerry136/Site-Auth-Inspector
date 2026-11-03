/**
 * 从矢量 logo 生成扩展图标（无第三方依赖，SVG 由 scripts/render-svg.mjs 预渲染）。
 *
 * 源文件：
 *  - assets/logo.svg         主 logo（蓝色盾牌）
 *  - assets/logo-1024.png    ↑ 渲染结果
 *  - assets/logo-on-1024.png ↑ 绿色系（「已启用」状态）
 *
 * 做法：解码 PNG → 裁掉透明边 → 等比放大铺满画布（面积平均重采样）→ 编码 PNG。
 *
 * 用法：node scripts/render-svg.mjs && node scripts/make-icons.mjs
 * 换 logo 时只改 assets/logo.svg，然后跑这两条命令。
 */
import { deflateSync, inflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const SOURCE = join(root, 'assets', 'logo-1024.png');
const SOURCE_ACTIVE = join(root, 'assets', 'logo-on-1024.png');
const OUT_DIR = join(root, 'icons');
const SIZES = [16, 32, 48, 128];
// 图标要尽量铺满画布：Chrome 会把整张图缩到固定大小，留白多看起来就小
const MARGIN = 0; // 画布四周留白比例（保持 0，图标尽量铺满）
const ALPHA_THRESHOLD = 8; // 判定“有内容”的 alpha 下限

// ---------------------------------------------------------------------------
// PNG 解码（仅 8 位 RGB/RGBA、非隔行）
// ---------------------------------------------------------------------------
function decodePng(buffer) {
  if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47) {
    throw new Error('不是有效的 PNG 文件');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 6;
  let interlace = 0;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 6 && colorType !== 2)) {
    throw new Error(
      `暂不支持这种 PNG（bitDepth=${bitDepth}, colorType=${colorType}, interlace=${interlace}）。` +
        '请导出为 8 位 RGB/RGBA 的非隔行 PNG。',
    );
  }

  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(width * height * 4);

  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };

  const line = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? line[x - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * width * 4 + Math.floor(x / channels) * 4 + (x % channels)] : 0;
      const upLeft = y > 0 && x >= channels
        ? pixels[(y - 1) * width * 4 + Math.floor((x - channels) / channels) * 4 + ((x - channels) % channels)]
        : 0;
      let value = raw[rowStart + 1 + x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += Math.floor((left + up) / 2);
      else if (filter === 4) value += paeth(left, up, upLeft);
      line[x] = value & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      const source = x * channels;
      const target = (y * width + x) * 4;
      pixels[target] = line[source];
      pixels[target + 1] = line[source + 1];
      pixels[target + 2] = line[source + 2];
      pixels[target + 3] = channels === 4 ? line[source + 3] : 255;
    }
  }

  return { width, height, pixels };
}

// ---------------------------------------------------------------------------
// PNG 编码（RGBA）
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// 处理
// ---------------------------------------------------------------------------
function contentBounds(image) {
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const alpha = image.pixels[(y * image.width + x) * 4 + 3];
      if (alpha <= ALPHA_THRESHOLD) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) throw new Error('logo 是全透明的，请检查 assets/logo.svg');
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** 把源图区域按面积平均缩放到 target 尺寸（预乘 alpha，避免边缘发黑） */
function resample(image, bounds, targetWidth, targetHeight) {
  const out = Buffer.alloc(targetWidth * targetHeight * 4);
  const scaleX = bounds.width / targetWidth;
  const scaleY = bounds.height / targetHeight;

  for (let ty = 0; ty < targetHeight; ty += 1) {
    const y0 = bounds.y + ty * scaleY;
    const y1 = y0 + scaleY;
    const sy0 = Math.floor(y0);
    const sy1 = Math.min(bounds.y + bounds.height, Math.ceil(y1));
    for (let tx = 0; tx < targetWidth; tx += 1) {
      const x0 = bounds.x + tx * scaleX;
      const x1 = x0 + scaleX;
      const sx0 = Math.floor(x0);
      const sx1 = Math.min(bounds.x + bounds.width, Math.ceil(x1));

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let weightSum = 0;

      for (let sy = sy0; sy < sy1; sy += 1) {
        const wy = Math.min(sy + 1, y1) - Math.max(sy, y0);
        if (wy <= 0) continue;
        for (let sx = sx0; sx < sx1; sx += 1) {
          const wx = Math.min(sx + 1, x1) - Math.max(sx, x0);
          if (wx <= 0) continue;
          const weight = wx * wy;
          const index = (sy * image.width + sx) * 4;
          const alpha = image.pixels[index + 3] / 255;
          // 预乘 alpha 后累加，避免透明边缘把颜色拉黑
          r += image.pixels[index] * alpha * weight;
          g += image.pixels[index + 1] * alpha * weight;
          b += image.pixels[index + 2] * alpha * weight;
          a += alpha * weight;
          weightSum += weight;
        }
      }

      const target = (ty * targetWidth + tx) * 4;
      if (weightSum === 0 || a === 0) {
        out[target] = 0;
        out[target + 1] = 0;
        out[target + 2] = 0;
        out[target + 3] = 0;
        continue;
      }
      out[target] = Math.round(r / a);
      out[target + 1] = Math.round(g / a);
      out[target + 2] = Math.round(b / a);
      out[target + 3] = Math.round((a / weightSum) * 255);
    }
  }
  return out;
}

/**
 * 在图标右下角画一个绿色状态点（带白色描边），用于「当前站点已启用」。
 * 直接按目标分辨率绘制，4x4 超采样做边缘抗锯齿，避免 16px 下糊成一团。
 */
function drawActiveDot(rgba, size) {
  // 绿点要够大才看得见：约 24% 直径，外圈白色描边把它和图标分开
  const radius = Math.max(2.6, size * 0.22);
  const ring = Math.max(1.1, size * 0.07);
  const center = size - radius - ring - Math.max(0.1, size * 0.01);
  const dot = [16, 185, 129]; // #10b981
  const ringColor = [255, 255, 255];
  const samples = 4;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let dotHits = 0;
      let ringHits = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const px = x + (sx + 0.5) / samples;
          const py = y + (sy + 0.5) / samples;
          const distance = Math.hypot(px - center, py - center);
          if (distance <= radius) dotHits += 1;
          else if (distance <= radius + ring) ringHits += 1;
        }
      }
      const total = samples * samples;
      const dotCoverage = dotHits / total;
      const ringCoverage = ringHits / total;
      if (dotCoverage === 0 && ringCoverage === 0) continue;

      const target = (y * size + x) * 4;
      const base = [rgba[target], rgba[target + 1], rgba[target + 2]];
      const baseAlpha = rgba[target + 3] / 255;

      // 先铺白描边，再叠绿点
      let r = base[0];
      let g = base[1];
      let b = base[2];
      let a = baseAlpha;
      if (ringCoverage > 0) {
        r = r * (1 - ringCoverage) + ringColor[0] * ringCoverage;
        g = g * (1 - ringCoverage) + ringColor[1] * ringCoverage;
        b = b * (1 - ringCoverage) + ringColor[2] * ringCoverage;
        a = Math.min(1, a + ringCoverage);
      }
      if (dotCoverage > 0) {
        r = r * (1 - dotCoverage) + dot[0] * dotCoverage;
        g = g * (1 - dotCoverage) + dot[1] * dotCoverage;
        b = b * (1 - dotCoverage) + dot[2] * dotCoverage;
        a = Math.min(1, a + dotCoverage);
      }

      rgba[target] = Math.round(r);
      rgba[target + 1] = Math.round(g);
      rgba[target + 2] = Math.round(b);
      rgba[target + 3] = Math.round(a * 255);
    }
  }
}

function renderIcon(image, bounds, size) {
  // contain 等比缩放：这张 logo 是竖长的盾牌，按长边铺满，允许 3% 溢出把视觉尺寸做大，
  // 但不能按宽度裁切（会切掉盾牌底部的尖角）
  const usable = size * 1.08;
  const scale = usable / Math.max(bounds.width, bounds.height);
  const contentWidth = Math.max(1, Math.round(bounds.width * scale));
  const contentHeight = Math.max(1, Math.round(bounds.height * scale));
  const offsetX = Math.round((size - contentWidth) / 2);
  const offsetY = Math.round((size - contentHeight) / 2);

  const content = resample(image, bounds, contentWidth, contentHeight);
  const canvas = Buffer.alloc(size * size * 4);

  for (let y = 0; y < contentHeight; y += 1) {
    for (let x = 0; x < contentWidth; x += 1) {
      const targetX = x + offsetX;
      const targetY = y + offsetY;
      if (targetX < 0 || targetY < 0 || targetX >= size || targetY >= size) continue;
      const source = (y * contentWidth + x) * 4;
      const target = (targetY * size + targetX) * 4;
      canvas[target] = content[source];
      canvas[target + 1] = content[source + 1];
      canvas[target + 2] = content[source + 2];
      canvas[target + 3] = content[source + 3];
    }
  }

  return { canvas, size };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const source = decodePng(readFileSync(SOURCE));
const bounds = contentBounds(source);
console.log(`源图：${source.width}x${source.height}，内容区域 ${bounds.width}x${bounds.height}（偏移 ${bounds.x},${bounds.y}）`);

mkdirSync(OUT_DIR, { recursive: true });
// 「已启用」状态用绿色系素材；素材缺失时退回「原色 + 右下角绿点」
let activeSource = null;
let activeBounds = null;
try {
  activeSource = decodePng(readFileSync(SOURCE_ACTIVE));
  activeBounds = contentBounds(activeSource);
  console.log(
    `绿色状态素材：${activeSource.width}x${activeSource.height}，内容区域 ${activeBounds.width}x${activeBounds.height}`,
  );
} catch {
  console.log('未找到 assets/logo-on-1024.png，改用「原色 + 绿点」生成状态图标');
}

for (const size of SIZES) {
  const { canvas } = renderIcon(source, bounds, size);

  const file = join(OUT_DIR, `icon${size}.png`);
  writeFileSync(file, encodePng(size, size, canvas));
  console.log(`已生成 ${file.replace(root + '/', '')}`);

  // 已启用状态：整枚图标变绿色系（不再是原色 + 小绿点）
  const active = activeSource
    ? renderIcon(activeSource, activeBounds, size).canvas
    : (() => {
        const fallback = Buffer.from(canvas);
        drawActiveDot(fallback, size);
        return fallback;
      })();
  const activeFile = join(OUT_DIR, `icon${size}-on.png`);
  writeFileSync(activeFile, encodePng(size, size, active));
  console.log(`已生成 ${activeFile.replace(root + '/', '')}`);
}

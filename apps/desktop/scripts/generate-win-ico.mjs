#!/usr/bin/env node
/**
 * generate-win-ico.mjs — 从 1024x1024 满幅方形母版生成 Windows 的 icon.ico。
 *
 * 与 generate-mac-icns.mjs 对称:mac 圆角画进 icns,Windows 惯例是满幅方图,
 * 母版直接降采样,不加圆角、不留边距。
 *
 * 条目结构与现行 icon.ico 逐项对齐,**不要改动尺寸档位或顺序**:
 *   16 / 24 / 32 / 48 / 64 / 128 / 256,全部 32bpp 未压缩 BMP(XOR 位图 + AND 掩码)。
 *   - 不用 PNG 压缩条目:老版 Windows 资源查看器与部分第三方壳对 PNG 条目支持不佳,
 *     现行 ico 全 BMP,保持一致最稳。
 *   - 顺序/数量影响 exe 图标资源索引:resources/installer.nsh 的 customInit 注释
 *     说明了旧 .lnk 的 IconLocation 索引会因此漂移,保持结构不变可避免新一轮漂移。
 *
 * 用法(仓库根或 apps/desktop 下执行均可):
 *   node apps/desktop/scripts/generate-win-ico.mjs [master.png] [out.ico]
 *   默认: master = apps/desktop/resources/icon-master-1024.png
 *         out    = apps/desktop/resources/icon.ico
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const resourcesDir = path.join(__dirname, '..', 'resources');

const masterPath = process.argv[2] ?? path.join(resourcesDir, 'icon-master-1024.png');
const outPath = process.argv[3] ?? path.join(resourcesDir, 'icon.ico');

// 与现行 icon.ico 一致的尺寸档位(小 → 大)
const SIZES = [16, 24, 32, 48, 64, 128, 256];

/**
 * 把 RGBA 像素编码成 ico 内嵌 BMP 条目:
 *   BITMAPINFOHEADER(biHeight = 高度 x2,含 AND 掩码)
 *   + XOR 位图(BGRA,行序自下而上)
 *   + AND 掩码(1bpp,每行按 32bit 对齐;alpha 通道已表达透明,掩码全 0)
 */
function encodeBmpEntry(rgba, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(size, 4); // biWidth
  header.writeInt32LE(size * 2, 8); // biHeight (XOR + AND)
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  // biCompression / biSizeImage / 其余字段保持 0

  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const srcRow = size - 1 - y; // 自下而上
    for (let x = 0; x < size; x++) {
      const s = (srcRow * size + x) * 4;
      const d = (y * size + x) * 4;
      xor[d] = rgba[s + 2]; // B
      xor[d + 1] = rgba[s + 1]; // G
      xor[d + 2] = rgba[s]; // R
      xor[d + 3] = rgba[s + 3]; // A
    }
  }

  const maskRowBytes = Math.ceil(size / 32) * 4;
  const and = Buffer.alloc(maskRowBytes * size); // 全 0 = 不透明由 alpha 决定

  return Buffer.concat([header, xor, and]);
}

async function main() {
  if (!fs.existsSync(masterPath)) {
    console.error(`[generate-win-ico] master image missing: ${masterPath}`);
    process.exit(1);
  }

  // 前提断言:母版必须满幅不透明。AND 掩码全 0 的写法依赖这一点——
  // 若母版带透明像素,老 GDI 渲染路径(不认 32bpp alpha)会显示黑底。
  const masterRgba = await sharp(masterPath).ensureAlpha().raw().toBuffer();
  for (let i = 3; i < masterRgba.length; i += 4) {
    if (masterRgba[i] !== 255) {
      console.error('[generate-win-ico] master image has transparent pixels; full-bleed opaque master required');
      process.exit(1);
    }
  }

  const entries = [];
  for (const size of SIZES) {
    const rgba = await sharp(masterPath)
      .resize(size, size, { fit: 'cover' })
      .ensureAlpha()
      .raw()
      .toBuffer();
    entries.push({ size, data: encodeBmpEntry(rgba, size) });
  }

  // ICONDIR(6B) + ICONDIRENTRY(16B x N) + 各条目数据
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0); // reserved
  dir.writeUInt16LE(1, 2); // type: icon
  dir.writeUInt16LE(entries.length, 4);

  const dirEntries = [];
  let offset = 6 + entries.length * 16;
  for (const { size, data } of entries) {
    const e = Buffer.alloc(16);
    e[0] = size === 256 ? 0 : size; // 0 表示 256
    e[1] = size === 256 ? 0 : size;
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    dirEntries.push(e);
    offset += data.length;
  }

  fs.writeFileSync(outPath, Buffer.concat([dir, ...dirEntries, ...entries.map((e) => e.data)]));

  const sizeKb = (fs.statSync(outPath).size / 1024).toFixed(0);
  console.log(`[generate-win-ico] wrote ${outPath} (${sizeKb} KB, ${entries.length} entries)`);
}

main().catch((err) => {
  console.error('[generate-win-ico] failed:', err);
  process.exit(1);
});

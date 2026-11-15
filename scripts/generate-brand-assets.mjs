import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const websiteDir = path.join(__dirname, '..', 'hermos-website');

const BG_COLOR = '#050A05';
const BRAND_PRIMARY = '#0FD765';
const BRAND_LIGHT = '#38EF7D';

export function getLogoSvg({ size = 512, solidBg = false } = {}) {
  const bg = solidBg
    ? `<rect width="512" height="512" fill="${BG_COLOR}"/>`
    : `<rect width="512" height="512" rx="112" fill="${BG_COLOR}"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${size}" height="${size}">
  ${bg}
  <path
    d="M160 128v256M352 128v256M160 256h192"
    stroke="${BRAND_PRIMARY}"
    stroke-width="41.6"
    stroke-linecap="round"
    stroke-linejoin="round"
  />
  <circle cx="256" cy="392" r="25.6" fill="${BRAND_LIGHT}"/>
</svg>`;
}

export function createIco(images) {
  const count = images.length;
  const headerLen = 6;
  const dirEntryLen = 16;
  let offset = headerLen + count * dirEntryLen;

  const header = Buffer.alloc(headerLen);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);

  const dirEntries = [];
  const buffers = [];

  for (const img of images) {
    const entry = Buffer.alloc(dirEntryLen);
    entry.writeUInt8(img.width >= 256 ? 0 : img.width, 0);
    entry.writeUInt8(img.height >= 256 ? 0 : img.height, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(img.buffer.length, 8);
    entry.writeUInt32LE(offset, 12);

    dirEntries.push(entry);
    buffers.push(img.buffer);
    offset += img.buffer.length;
  }

  return Buffer.concat([header, ...dirEntries, ...buffers]);
}

async function main() {
  console.log('Generating HermOS brand and website assets...');

  // 1. logo.svg
  const svg512 = getLogoSvg({ size: 512, solidBg: false });
  fs.writeFileSync(path.join(websiteDir, 'logo.svg'), svg512, 'utf8');
  console.log('Created hermos-website/logo.svg');

  // Helper to render PNG buffer from SVG
  async function renderPng(size, solidBg = false) {
    const svg = getLogoSvg({ size, solidBg });
    return sharp(Buffer.from(svg)).png().toBuffer();
  }

  // 2. logo.png (512x512)
  const logoPngBuf = await renderPng(512);
  fs.writeFileSync(path.join(websiteDir, 'logo.png'), logoPngBuf);
  console.log(`Created hermos-website/logo.png (512x512, ${logoPngBuf.length} bytes)`);

  // 3. icon-512.png (512x512)
  const icon512Buf = await renderPng(512);
  fs.writeFileSync(path.join(websiteDir, 'icon-512.png'), icon512Buf);
  console.log(`Created hermos-website/icon-512.png (512x512, ${icon512Buf.length} bytes)`);

  // 4. icon-192.png (192x192)
  const icon192Buf = await renderPng(192);
  fs.writeFileSync(path.join(websiteDir, 'icon-192.png'), icon192Buf);
  console.log(`Created hermos-website/icon-192.png (192x192, ${icon192Buf.length} bytes)`);

  // 5. favicon-96.png (96x96)
  const favicon96Buf = await renderPng(96);
  fs.writeFileSync(path.join(websiteDir, 'favicon-96.png'), favicon96Buf);
  console.log(`Created hermos-website/favicon-96.png (96x96, ${favicon96Buf.length} bytes)`);

  // 6. favicon-48.png (48x48)
  const favicon48Buf = await renderPng(48);
  fs.writeFileSync(path.join(websiteDir, 'favicon-48.png'), favicon48Buf);
  console.log(`Created hermos-website/favicon-48.png (48x48, ${favicon48Buf.length} bytes)`);

  // 7. favicon-32.png (32x32)
  const favicon32Buf = await renderPng(32);
  fs.writeFileSync(path.join(websiteDir, 'favicon-32.png'), favicon32Buf);
  console.log(`Created hermos-website/favicon-32.png (32x32, ${favicon32Buf.length} bytes)`);

  // 8. apple-touch-icon.png (180x180, solid opaque background, properly centered)
  const appleTouchBuf = await renderPng(180, true);
  fs.writeFileSync(path.join(websiteDir, 'apple-touch-icon.png'), appleTouchBuf);
  console.log(`Created hermos-website/apple-touch-icon.png (180x180, ${appleTouchBuf.length} bytes)`);

  // 9. favicon.ico (multi-resolution: 16x16, 32x32, 48x48)
  const ico16 = await renderPng(16);
  const ico32 = await renderPng(32);
  const ico48 = await renderPng(48);
  const icoBuf = createIco([
    { width: 16, height: 16, buffer: ico16 },
    { width: 32, height: 32, buffer: ico32 },
    { width: 48, height: 48, buffer: ico48 },
  ]);
  fs.writeFileSync(path.join(websiteDir, 'favicon.ico'), icoBuf);
  console.log(`Created hermos-website/favicon.ico (${icoBuf.length} bytes, 3 sub-images: 16, 32, 48)`);

  console.log('All brand assets successfully generated!');
}

if (process.argv[1] && process.argv[1].endsWith('generate-brand-assets.mjs')) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const websiteDir = path.resolve(__dirname, '../../hermos-website');

describe('Website Brand & Favicon Assets Integrity', () => {
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it('verifies logo.svg is valid crisp vector SVG', () => {
    const svgPath = path.join(websiteDir, 'logo.svg');
    expect(fs.existsSync(svgPath)).toBe(true);

    const content = fs.readFileSync(svgPath, 'utf8');
    expect(content).toContain('<svg');
    expect(content).toContain('viewBox="0 0 512 512"');
    expect(content).toContain('#0FD765');
    expect(content).toContain('#38EF7D');
    expect(content).toContain('#050A05');
  });

  const expectedPngs: Array<{ file: string; width: number; height: number; minSizeGoogle?: number }> = [
    { file: 'logo.png', width: 512, height: 512, minSizeGoogle: 112 },
    { file: 'icon-512.png', width: 512, height: 512 },
    { file: 'icon-192.png', width: 192, height: 192 },
    { file: 'favicon-96.png', width: 96, height: 96 },
    { file: 'favicon-48.png', width: 48, height: 48 },
    { file: 'favicon-32.png', width: 32, height: 32 },
    { file: 'apple-touch-icon.png', width: 180, height: 180 },
  ];

  for (const { file, width, height, minSizeGoogle } of expectedPngs) {
    it(`verifies ${file} header, dimensions (${width}x${height}), and sRGB metadata`, async () => {
      const filePath = path.join(websiteDir, file);
      expect(fs.existsSync(filePath), `${file} should exist`).toBe(true);

      const buf = fs.readFileSync(filePath);
      expect(buf.subarray(0, 8).equals(PNG_MAGIC), `${file} must have valid PNG magic header`).toBe(true);

      const meta = await sharp(buf).metadata();
      expect(meta.format).toBe('png');
      expect(meta.width).toBe(width);
      expect(meta.height).toBe(height);
      expect(meta.space).toBe('srgb');

      if (minSizeGoogle) {
        expect(meta.width! >= minSizeGoogle).toBe(true);
        expect(meta.height! >= minSizeGoogle).toBe(true);
      }
    });
  }

  it('verifies Google Search Favicon Guidelines: favicon-48 and favicon-96 are multiples of 48', async () => {
    for (const file of ['favicon-48.png', 'favicon-96.png', 'icon-192.png', 'icon-512.png']) {
      const meta = await sharp(path.join(websiteDir, file)).metadata();
      expect(meta.width! % 48 === 0 || meta.width === 512).toBe(true);
      expect(meta.width).toBe(meta.height);
    }
  });

  it('verifies apple-touch-icon.png has opaque background and centered monogram', async () => {
    const { data, info } = await sharp(path.join(websiteDir, 'apple-touch-icon.png'))
      .raw()
      .toBuffer({ resolveWithObject: true });

    expect(info.width).toBe(180);
    expect(info.height).toBe(180);

    // Apple HIG: All corners must be opaque
    const corners = [
      0, // top-left
      (180 - 1) * 4, // top-right
      ((180 - 1) * 180) * 4, // bottom-left
      ((180 - 1) * 180 + (180 - 1)) * 4, // bottom-right
    ];
    for (const c of corners) {
      expect(data[c + 3]).toBe(255); // Alpha = 255 (opaque)
      expect(data[c]).toBe(5);       // R (#050A05)
      expect(data[c + 1]).toBe(10);  // G
      expect(data[c + 2]).toBe(5);   // B
    }

    // Monogram bounding box check: must be centered horizontally and vertically
    let minX = 180, maxX = 0, minY = 180, maxY = 0;
    for (let y = 0; y < 180; y++) {
      for (let x = 0; x < 180; x++) {
        const idx = (y * 180 + x) * 4;
        const g = data[idx + 1];
        const r = data[idx];
        if (g > 80 && g > r * 1.5) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    // Perfect center is 90; allow +/- 2px subpixel antialiasing tolerance
    expect(Math.abs(centerX - 90)).toBeLessThanOrEqual(2);
    expect(Math.abs(centerY - 90)).toBeLessThanOrEqual(5);

    // Padding inside iOS squircle safe area (> 25px margin)
    expect(minX).toBeGreaterThan(30);
    expect(180 - maxX).toBeGreaterThan(30);
    expect(minY).toBeGreaterThan(25);
    expect(180 - maxY).toBeGreaterThan(25);
  });

  it('verifies favicon.ico binary structure and embedded sub-images', () => {
    const icoPath = path.join(websiteDir, 'favicon.ico');
    expect(fs.existsSync(icoPath)).toBe(true);

    const buf = fs.readFileSync(icoPath);
    expect(buf.length).toBeGreaterThan(500);

    // Header check
    expect(buf.readUInt16LE(0)).toBe(0); // Reserved
    expect(buf.readUInt16LE(2)).toBe(1); // Type = 1 (ICO)
    const count = buf.readUInt16LE(4);
    expect(count).toBe(3); // 16, 32, 48

    const expectedSizes = [16, 32, 48];
    for (let i = 0; i < count; i++) {
      const offset = 6 + i * 16;
      const w = buf.readUInt8(offset);
      const h = buf.readUInt8(offset + 1);
      expect(w).toBe(expectedSizes[i]);
      expect(h).toBe(expectedSizes[i]);

      const size = buf.readUInt32LE(offset + 8);
      const dataOffset = buf.readUInt32LE(offset + 12);
      expect(size).toBeGreaterThan(0);
      expect(dataOffset + size).toBeLessThanOrEqual(buf.length);

      // Embedded PNG magic header
      const pngMagic = buf.subarray(dataOffset, dataOffset + 8);
      expect(pngMagic.equals(PNG_MAGIC)).toBe(true);
    }
  });
});

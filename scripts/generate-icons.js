#!/usr/bin/env node

/**
 * Generates platform-specific icons from assets/icon-source.png.
 *
 * Output:
 *   assets/icon.icns   — macOS (via iconutil, macOS-only)
 *   assets/icon.ico    — Windows (raw ICO composed in pure Node)
 *   assets/icon.png    — 512x512 fallback for Linux / electron-builder
 *
 * Requires: npm install --save-dev sharp
 * Usage:    node scripts/generate-icons.js
 */

import sharp from 'sharp';
import { execSync } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SOURCE = join(ROOT, 'assets', 'icon-source.png');
const ASSETS = join(ROOT, 'assets');

if (!existsSync(SOURCE)) {
  console.error('Error: assets/icon-source.png not found.');
  console.error('Place a square PNG (at least 1024x1024) at that path and re-run.');
  process.exit(1);
}

// ── Resize helpers ─────────────────────────────────────────────
async function resize(size) {
  return sharp(SOURCE)
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

// macOS icons must fill the full square — the OS applies its own mask.
// The source icon has transparency, so we flatten onto white.
// For best results, provide an icon-source.png that fills the full square
// edge-to-edge with no transparency or baked-in rounding.
async function resizeMac(size) {
  return sharp(SOURCE)
    .resize(size, size, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .png()
    .toBuffer();
}

// ── ICO generation (pure Node, no native deps) ────────────────
// ICO format: header + directory entries + PNG image data
function buildIco(buffers, sizes) {
  const count = buffers.length;
  const headerSize = 6;
  const dirEntrySize = 16;
  const dataOffset = headerSize + dirEntrySize * count;

  // Header: reserved(2) + type(2, 1=ICO) + count(2)
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);       // reserved
  header.writeUInt16LE(1, 2);       // type = ICO
  header.writeUInt16LE(count, 4);   // image count

  const dirEntries = [];
  let offset = dataOffset;

  for (let i = 0; i < count; i++) {
    const entry = Buffer.alloc(dirEntrySize);
    const s = sizes[i] >= 256 ? 0 : sizes[i]; // 256 is stored as 0
    entry.writeUInt8(s, 0);                     // width
    entry.writeUInt8(s, 1);                     // height
    entry.writeUInt8(0, 2);                     // color palette
    entry.writeUInt8(0, 3);                     // reserved
    entry.writeUInt16LE(1, 4);                  // color planes
    entry.writeUInt16LE(32, 6);                 // bits per pixel
    entry.writeUInt32LE(buffers[i].length, 8);  // image size
    entry.writeUInt32LE(offset, 12);            // image offset
    dirEntries.push(entry);
    offset += buffers[i].length;
  }

  return Buffer.concat([header, ...dirEntries, ...buffers]);
}

// ── macOS .icns via iconutil ───────────────────────────────────
async function generateIcns() {
  if (process.platform !== 'darwin') {
    console.log('  Skipping .icns (macOS iconutil not available on this platform)');
    return;
  }

  const iconsetDir = join(ASSETS, 'icon.iconset');
  mkdirSync(iconsetDir, { recursive: true });

  const iconsetSizes = [16, 32, 64, 128, 256, 512, 1024];

  for (const size of iconsetSizes) {
    const buf = await resizeMac(size);
    // Standard resolution
    if (size <= 512) {
      writeFileSync(join(iconsetDir, `icon_${size}x${size}.png`), buf);
    }
    // @2x retina (half the labeled size)
    const retinaLabel = size / 2;
    if (retinaLabel >= 16 && Number.isInteger(retinaLabel)) {
      writeFileSync(join(iconsetDir, `icon_${retinaLabel}x${retinaLabel}@2x.png`), buf);
    }
  }

  execSync(`iconutil -c icns -o "${join(ASSETS, 'icon.icns')}" "${iconsetDir}"`, {
    stdio: 'inherit',
  });

  rmSync(iconsetDir, { recursive: true, force: true });
  console.log('  Generated assets/icon.icns');
}

// ── Windows .ico ───────────────────────────────────────────────
async function generateIco() {
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const buffers = [];

  for (const size of icoSizes) {
    buffers.push(await resize(size));
  }

  const ico = buildIco(buffers, icoSizes);
  writeFileSync(join(ASSETS, 'icon.ico'), ico);
  console.log('  Generated assets/icon.ico');
}

// ── 512px PNG fallback ─────────────────────────────────────────
async function generatePng() {
  const buf = await resize(512);
  writeFileSync(join(ASSETS, 'icon.png'), buf);
  console.log('  Generated assets/icon.png');
}

// ── Run ────────────────────────────────────────────────────────
console.log('Generating icons from assets/icon-source.png...');
await generateIcns();
await generateIco();
await generatePng();
console.log('Done.');

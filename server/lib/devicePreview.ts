import type { CardSample, RenderCommand } from './types';
import { renderValue } from './templates';
import { GFX_FONTS } from './gfxFonts';
import { LOGICAL_H, LOGICAL_W, renderStaticFrame } from './epaperBitmap';

const EPAPER_W = 122;
const ROW_BYTES = 16;
const DYNAMIC_FIELDS = ['market', 'low', 'mid', 'high', 'time', 'date'];
const RED = '#b00020';
const BLACK = '#111111';

function isDynamic(item: RenderCommand) {
  const value = item.value || '';
  return DYNAMIC_FIELDS.some((field) => value.includes('{' + field + '}') || value.includes('$' + field));
}

function fontForTier(tier: number) {
  if (tier === 4) return GFX_FONTS[24];
  if (tier === 3) return GFX_FONTS[18];
  if (tier === 2) return GFX_FONTS[12];
  return GFX_FONTS[9];
}

function fontAscent(tier: number) {
  if (tier === 4) return 32;
  if (tier === 3) return 23;
  if (tier === 2) return 16;
  return 12;
}

function ink(ctx: CanvasRenderingContext2D, x: number, y: number, color: number) {
  if (x < 0 || x >= LOGICAL_W || y < 0 || y >= LOGICAL_H) return;
  ctx.fillStyle = color === 1 ? RED : BLACK;
  ctx.fillRect(x, y, 1, 1);
}

// Mirrors firmware renderTextToPlanes() exactly: Adafruit GFX's MSB-first,
// continuous glyph bitstream, baseline semantics, glyph offsets, and clipping.
function renderFirmwareText(ctx: CanvasRenderingContext2D, text: string, x: number, topY: number, tier: number, color: number) {
  const font = fontForTier(tier);
  const baseline = topY + fontAscent(tier);
  let cursorX = x;
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code < font.first || code > font.last) {
      cursorX += 8;
      continue;
    }
    const glyph = font.glyphs[code - font.first];
    let bitmapOffset = glyph[0];
    const width = glyph[1];
    const height = glyph[2];
    const advance = glyph[3];
    const xOffset = glyph[4];
    const yOffset = glyph[5];
    let bits = 0;
    let bit = 0;
    for (let gy = 0; gy < height; gy++) {
      for (let gx = 0; gx < width; gx++) {
        if ((bit++ & 7) === 0) bits = font.bitmap[bitmapOffset++];
        const on = (bits & 0x80) !== 0;
        bits = (bits << 1) & 0xff;
        if (on) ink(ctx, cursorX + xOffset + gx, baseline + yOffset + gy, color);
      }
    }
    cursorX += advance;
  }
}

// Replays the exact planes delivered to the ESP32. This removes canvas
// antialiasing from static text and makes the preview a 1:1 panel-pixel view.
function drawPlane(ctx: CanvasRenderingContext2D, plane: Uint8Array, color: string) {
  ctx.fillStyle = color;
  for (let physicalY = 0; physicalY < 250; physicalY++) {
    for (let physicalX = 0; physicalX < EPAPER_W; physicalX++) {
      const byte = plane[physicalY * ROW_BYTES + (physicalX >> 3)];
      if ((byte & (0x80 >> (physicalX & 7))) !== 0) continue;
      const logicalX = physicalY;
      const logicalY = EPAPER_W - 1 - physicalX;
      ctx.fillRect(logicalX, logicalY, 1, 1);
    }
  }
}

export function renderDevicePreviewFrame(program: RenderCommand[], card: CardSample): string {
  const staticFrame = renderStaticFrame(program, card);
  const canvas = document.createElement('canvas');
  canvas.width = LOGICAL_W;
  canvas.height = LOGICAL_H;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);
  drawPlane(ctx, staticFrame.black, BLACK);
  drawPlane(ctx, staticFrame.red, RED);
  for (const item of program) {
    if (!item.visible || !isDynamic(item)) continue;
    const text = renderValue(item.value, card);
    if (text) renderFirmwareText(ctx, text, item.x, item.y, item.font, item.color);
  }
  return canvas.toDataURL('image/png');
}

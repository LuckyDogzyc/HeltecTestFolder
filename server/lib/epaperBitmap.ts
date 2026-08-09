import type { CardSample, RenderCommand } from './types';
import { renderValue, fitTextToDeviceSlot } from './templates';

// ===== E-paper 位图渲染器（浏览器端 canvas）=====
// 物理屏幕 122×250（宽×高），三色：白/黑/红。
// 输出：双平面 1bpp（black + red），每行 16 字节（(122+7)/8），像素 0=白 1=着墨。
// 用途：把"静态层"（标题/装饰/自定义文本，任意字体字号）渲染成位图，
//       固件只负责 drawNative 画位图 + 在动态槽位用内置字体画价格，从此不再内置大字体。

export const EPAPER_W = 122;
export const EPAPER_H = 250;
const ROW_BYTES = Math.ceil(EPAPER_W / 8); // 16

// 字号档位 → 像素高度（与固件 9pt/12pt 近似；位图模式可自由用任意 px）
export const FONT_PX: Record<number, number> = { 0: 12, 1: 12, 2: 16 };

export type RenderedFrame = {
  black: Uint8Array; // 4000 字节
  red: Uint8Array;   // 4000 字节
  dataUrl: string;   // 预览图（白底 122×250）
};

// 动态槽位：位图模式中由固件本地实时绘制的字段（价格/时间等）
export const DYNAMIC_FIELDS = ['market', 'low', 'mid', 'high', 'time'];

function isDynamic(item: RenderCommand): boolean {
  const v = item.value || '';
  return DYNAMIC_FIELDS.some((f) => v.includes(`{${f}}`) || v.includes(`$${f}`));
}

function packRow(pixels: Uint8ClampedArray, plane: Uint8Array, row: number, colorValue: number) {
  // pixels: 122×250 的 RGBA 数据（每像素4字节）
  const base = row * EPAPER_W * 4;
  for (let col = 0; col < EPAPER_W; col++) {
    const alpha = pixels[base + col * 4 + 3];
    if (alpha < 128) continue; // 透明 = 不画
    const r = pixels[base + col * 4];
    const g = pixels[base + col * 4 + 1];
    const b = pixels[base + col * 4 + 2];
    // 黑色（红绿蓝都低）→ black 平面；红色（R 高 G/B 低）→ red 平面
    const isRed = r > 140 && g < 110 && b < 110;
    const isBlack = r < 110 && g < 110 && b < 110;
    if (colorValue === 1 && isRed) {
      plane[row * ROW_BYTES + (col >> 3)] |= (0x80 >> (col & 7));
    } else if (isBlack) {
      plane[row * ROW_BYTES + (col >> 3)] |= (0x80 >> (col & 7));
    }
  }
}

// 渲染一帧：把 program 中非动态元素画到位图上（动态元素跳过，留给固件实时画）
// 返回黑/红双平面 + 预览 dataUrl
export function renderStaticFrame(program: RenderCommand[], card: CardSample, fontFamily = 'monospace'): RenderedFrame {
  const canvas = document.createElement('canvas');
  canvas.width = EPAPER_W;
  canvas.height = EPAPER_H;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, EPAPER_W, EPAPER_H);

  for (const item of program) {
    if (!item.visible || isDynamic(item)) continue;
    const text = renderValue(item.value, card);
    if (!text) continue;
    const px = FONT_PX[item.font] || 12;
    ctx.font = `bold ${px}px ${fontFamily}`;
    ctx.fillStyle = item.color === 1 ? '#b00020' : '#111111';
    ctx.textBaseline = 'top';
    ctx.fillText(fitTextToDeviceSlot(text, item.font, item.x, EPAPER_W), item.x, item.y);
  }

  const imageData = ctx.getImageData(0, 0, EPAPER_W, EPAPER_H);
  const black = new Uint8Array(EPAPER_H * ROW_BYTES);
  const red = new Uint8Array(EPAPER_H * ROW_BYTES);
  for (let row = 0; row < EPAPER_H; row++) {
    packRow(imageData.data, black, row, 0);
    packRow(imageData.data, red, row, 1);
  }
  return { black, red, dataUrl: canvas.toDataURL('image/png') };
}

// 动态槽位列表（固件本地绘制的元素）：返回 {value, x, y, font, color}
export function dynamicSlots(program: RenderCommand[]) {
  return program.filter((item) => item.visible && isDynamic(item)).map((item) => ({
    value: item.value,
    x: item.x,
    y: item.y,
    font: item.font,
    color: item.color,
  }));
}

export function frameToBase64(plane: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < plane.length; i++) bin += String.fromCharCode(plane[i]);
  return btoa(bin);
}

export function framePayload(program: RenderCommand[], card: CardSample): { blackB64: string; redB64: string; slots: ReturnType<typeof dynamicSlots> } {
  const frame = renderStaticFrame(program, card);
  return { blackB64: frameToBase64(frame.black), redB64: frameToBase64(frame.red), slots: dynamicSlots(program) };
}

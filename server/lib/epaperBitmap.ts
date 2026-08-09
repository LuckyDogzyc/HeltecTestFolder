import type { CardSample, RenderCommand } from './types';
import { renderValue, fitTextToDeviceSlot } from './templates';

// ===== E-paper 位图渲染器（浏览器端 canvas）=====
// 物理屏幕 122×250（宽×高），三色：白/黑/红。
// 固件 setRotation(0)：逻辑坐标 = 物理坐标（122×250 竖屏），文字横排、从上到下。
// 本渲染器用物理坐标画 canvas（122×250），与 WebUI 预览、固件渲染完全一致。
// 输出：双平面 1bpp（black + red），每行 16 字节（(122+7)/8），像素 0=着墨 1=白（GxEPD2 数据格式）。
// 统一渲染源：预览图（dataUrl）与下发位图来自同一次 canvas 渲染，所见即所得。
// 动态槽位（价格/时间）：Web 端渲染时用当前卡数据画上（预览一致），同时下发 slots，
// 固件每次唤醒用内置字体重画价格（renderTextToPlanes），保证价格实时更新。

// 物理可视尺寸（setRotation(0)，逻辑 = 物理）
export const LOGICAL_W = 122;
export const LOGICAL_H = 250;
// 物理面板尺寸：位图输出方向（与逻辑一致）
export const EPAPER_W = 122;
export const EPAPER_H = 250;
const ROW_BYTES = Math.ceil(EPAPER_W / 8); // 16

// 字号档位 → 像素高度（与固件 9pt/12pt 近似；位图模式可自由用任意 px）
export const FONT_PX: Record<number, number> = { 0: 12, 1: 12, 2: 16 };

export type RenderedFrame = {
  black: Uint8Array; // 4000 字节
  red: Uint8Array;   // 4000 字节
  dataUrl: string;   // 预览图（逻辑 250×122，三色）
  blackB64: string;
  redB64: string;
  slots: SlotSpec[];
};

export type SlotSpec = { value: string; x: number; y: number; font: number; color: number };

// 动态槽位：位图模式中由固件本地实时绘制的字段（价格/时间等）
export const DYNAMIC_FIELDS = ['market', 'low', 'mid', 'high', 'time'];

function isDynamic(item: RenderCommand): boolean {
  const v = item.value || '';
  return DYNAMIC_FIELDS.some((f) => v.includes(`{${f}}`) || v.includes(`$${f}`));
}

// GxEPD2 数据格式：bit 1 = 白（不着墨），bit 0 = 着墨（黑/红）。
// 平面初始化为全 0xFF（白底），着墨像素清 0。
function packPixel(plane: Uint8Array, physX: number, physY: number, set: boolean) {
  if (physX < 0 || physX >= EPAPER_W || physY < 0 || physY >= EPAPER_H) return;
  if (set) plane[physY * ROW_BYTES + (physX >> 3)] &= ~(0x80 >> (physX & 7));
}

// 渲染一帧：所有元素（含动态价格/时间）画到 canvas——预览图（122×250 物理方向）与
// 下发位图同源同一次渲染，所见即所得。
// 动态槽位同时作为 slots 下发，固件唤醒时用内置字体重画价格（renderTextToPlanes）。
export function renderStaticFrame(program: RenderCommand[], card: CardSample, fontFamily = 'monospace'): RenderedFrame {
  const canvas = document.createElement('canvas');
  canvas.width = LOGICAL_W;
  canvas.height = LOGICAL_H;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);

  for (const item of program) {
    if (!item.visible) continue;
    const text = renderValue(item.value, card);
    if (!text) continue;
    const px = FONT_PX[item.font] || 12;
    ctx.font = `bold ${px}px ${fontFamily}`;
    ctx.fillStyle = item.color === 1 ? '#b00020' : '#111111';
    ctx.textBaseline = 'top';
    ctx.fillText(fitTextToDeviceSlot(text, item.font, item.x, LOGICAL_W), item.x, item.y);
  }

  const imageData = ctx.getImageData(0, 0, LOGICAL_W, LOGICAL_H);
  const px = imageData.data;
  // 平面初始化为全 0xFF = 白底（GxEPD2 数据格式 bit 1 = 白）
  const black = new Uint8Array(EPAPER_H * ROW_BYTES).fill(0xFF);
  const red = new Uint8Array(EPAPER_H * ROW_BYTES).fill(0xFF);
  for (let ly = 0; ly < LOGICAL_H; ly++) {
    for (let lx = 0; lx < LOGICAL_W; lx++) {
      const i = (ly * LOGICAL_W + lx) * 4;
      const alpha = px[i + 3];
      if (alpha < 128) continue;
      const r = px[i], g = px[i + 1], b = px[i + 2];
      const isRed = r > 140 && g < 110 && b < 110;
      const isBlack = r < 110 && g < 110 && b < 110;
      // setRotation(0)：逻辑 = 物理，直映射
      if (isRed) packPixel(red, lx, ly, true);
      else if (isBlack) packPixel(black, lx, ly, true);
    }
  }
  return {
    black,
    red,
    dataUrl: canvas.toDataURL('image/png'),
    blackB64: frameToBase64(black),
    redB64: frameToBase64(red),
    slots: dynamicSlots(program),
  };
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

export function framePayload(program: RenderCommand[], card: CardSample): { blackB64: string; redB64: string; slots: SlotSpec[]; dataUrl: string } {
  const frame = renderStaticFrame(program, card);
  return { blackB64: frame.blackB64, redB64: frame.redB64, slots: frame.slots, dataUrl: frame.dataUrl };
}

import type { CardSample, RenderCommand } from './types';
import { renderValue, fitTextToDeviceSlot } from './templates';

// ===== E-paper 位图渲染器（浏览器端 canvas）=====
// 物理屏幕 122×250（宽×高），三色：白/黑/红。
// 固件 setRotation(1)：渲染坐标系为逻辑 250×122（横屏），文字横排、从左到右。
// 本渲染器用逻辑坐标画 canvas（250×122，与 WebUI 预览一致），输出时按 rotation 1
// 映射 (x,y) → (122-1-y, x) 转物理 122×250 位图。
// 输出：双平面 1bpp（black + red），每行 16 字节（(122+7)/8），像素 0=着墨 1=白（GxEPD2 数据格式）。
// 统一渲染源：预览图（dataUrl）与下发位图来自同一次 canvas 渲染，所见即所得。
// 动态槽位（价格/时间）：Web 端渲染时用当前卡数据画上（预览一致），同时下发 slots，
// 固件每次唤醒用内置字体重画价格（renderTextToPlanes），保证价格实时更新。

// 逻辑（旋转后）可视尺寸：与固件 setRotation(1) 渲染坐标系一致
export const LOGICAL_W = 250;
export const LOGICAL_H = 122;
// 物理面板尺寸：位图输出方向
export const EPAPER_W = 122;
export const EPAPER_H = 250;
const ROW_BYTES = Math.ceil(EPAPER_W / 8); // 16

// 字号档位 → 像素高度（与 DOM 编辑预览 CSS 对齐：font0-4 = 15/15/21/30/40px；
// 位图模式可自由用任意字号，Web canvas 是唯一渲染源）
export const FONT_PX: Record<number, number> = { 0: 15, 1: 15, 2: 21, 3: 30, 4: 40 };

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

// 渲染"下发位图"：只画静态层（跳过动态价格/时间——这些由固件在唤醒时用内置字体
// 渲染进位图，见固件 renderTextToPlanes；若这里也画，会与固件渲染重叠成乱码）。
// 预览图单独用 renderPreviewFrame（画全部元素）展示。
// canvas 用逻辑坐标 250×122（与固件 setRotation(1) 渲染坐标系一致），
// 输出时按 rotation 1 映射 (logicalX, logicalY) → (121 - logicalY, logicalX) 转物理 122×250 位图。
export function renderStaticFrame(program: RenderCommand[], card: CardSample, fontFamily = 'monospace'): RenderedFrame {
  const canvas = document.createElement('canvas');
  canvas.width = LOGICAL_W;
  canvas.height = LOGICAL_H;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);

  for (const item of program) {
    if (!item.visible) continue;
    // 跳过固件可画的动态槽位（font 0-2，固件内置 9pt/12pt 字体）；font 3/4 的动态
    // 元素固件画不了（无大字体），由 Web canvas 渲染进位图（与动态Slots 的过滤一致）。
    if (isDynamic(item) && (item.font ?? 0) <= 2) continue;
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
      // rotation 1 映射（Adafruit_GFX: x' = WIDTH-1-y, y' = x；WIDTH=122 物理）
      const physX = EPAPER_W - 1 - ly;
      const physY = lx;
      if (isRed) packPixel(red, physX, physY, true);
      else if (isBlack) packPixel(black, physX, physY, true);
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
// 固件只内置 9pt/12pt 字体（font 0-2）；font 3/4 的大字动态元素由 Web canvas
// 渲染进位图（renderStaticFrame 不跳过它们），固件槽位仅处理 font 0-2。
export function dynamicSlots(program: RenderCommand[]) {
  return program
    .filter((item) => item.visible && isDynamic(item) && (item.font ?? 0) <= 2)
    .map((item) => ({
      value: item.value,
      x: item.x,
      y: item.y,
      font: item.font,
      color: item.color,
    }));
}

// 预览渲染：画全部元素（含动态价格，用当前卡数据）——展示设备最终显示效果。
// 与 renderStaticFrame 的唯一区别是动态元素也画（设备上动态元素由固件用内置字体画，
// 字形近似 monospace，位置颜色一致，此处预览所见即所得）。
export function renderPreviewFrame(program: RenderCommand[], card: CardSample, fontFamily = 'monospace'): string {
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
  return canvas.toDataURL('image/png');
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

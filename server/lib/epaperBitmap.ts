import type { CardSample, RenderCommand } from './types';
import { renderValue, fitTextToDeviceSlot } from './templates';

// ===== E-paper 位图渲染器（浏览器端 canvas）=====
// 物理屏幕 122×250（宽×高），三色：白/黑/红。
// 固件 setRotation(1) 后渲染坐标系为逻辑 250×122（横屏），模板坐标 x∈[0,249], y∈[0,121]。
// 本渲染器用逻辑坐标画 canvas，输出时按 rotation 1 映射 (x,y) → (122-1-y, x) 转物理 122×250 位图。
// 输出：双平面 1bpp（black + red），每行 16 字节（(122+7)/8），像素 0=白 1=着墨。
// 用途：把"静态层"（标题/装饰/自定义文本，任意字体字号）渲染成位图，
//       固件只负责 writeImage 画位图 + 在动态槽位用内置字体画价格，从此不再内置大字体。

// 逻辑（旋转后）可视尺寸：与固件渲染坐标系一致
export const LOGICAL_W = 250;
export const LOGICAL_H = 122;
// 物理面板尺寸：位图输出方向
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

function packPixel(plane: Uint8Array, physX: number, physY: number, set: boolean) {
  if (physX < 0 || physX >= EPAPER_W || physY < 0 || physY >= EPAPER_H) return;
  if (set) plane[physY * ROW_BYTES + (physX >> 3)] |= (0x80 >> (physX & 7));
}

// 渲染一帧：把 program 中非动态元素画到位图上（动态元素跳过，留给固件实时画）
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
    if (!item.visible || isDynamic(item)) continue;
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
  const black = new Uint8Array(EPAPER_H * ROW_BYTES);
  const red = new Uint8Array(EPAPER_H * ROW_BYTES);
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

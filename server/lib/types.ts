export type CardSample = {
  cardKey?: string;
  productId: number;
  title: string;
  name: string;
  set: string;
  rarity: string;
  subType: string;
  market: string;
  low: string;
  mid: string;
  high: string;
  power: string;
  // 评级卡价格：key 形如 "PSA:10"，值为美元价格
  grades?: Record<string, number>;
};

export type RenderCommand = {
  type: 'text';
  value: string;
  valueFrom?: string;
  fallback?: string;
  x: number;
  y: number;
  font: -1 | 0 | 1 | 2 | 3 | 4;
  color: 0 | 1 | 2;
  wrap: boolean;
  visible: boolean;
};

// 位图静态层（Web canvas 渲染的黑/红双平面 1bpp）+ 动态槽位（固件本地画的字段）
export type FrameSlots = { value: string; x: number; y: number; font: number; color: number }[];
export type BackgroundColor = 'white' | 'black' | 'red';
export type DeviceFrame = { blackB64: string; redB64: string; slots: FrameSlots; backgroundColor?: BackgroundColor };

export type DeviceRecord = {
  deviceId: string;
  factoryName: string;
  displayName: string;
  deviceKeyHash: string;
  publicIp: string;
  lanIp: string;
  firmware: string;
  lastSeen: string;
  configVersion: number;
  productId: number;
  cardKey?: string;
  dataUrl?: string;
  templateId: string;
  renderProgram: RenderCommand[];
  frame?: DeviceFrame;
  lastStatus?: Record<string, unknown>;
};

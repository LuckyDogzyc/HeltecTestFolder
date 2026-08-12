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
};

export type RenderCommand = {
  type: 'text';
  value: string;
  valueFrom?: string;
  fallback?: string;
  x: number;
  y: number;
  font: 0 | 1 | 2 | 3 | 4;
  color: 0 | 1;
  wrap: boolean;
  visible: boolean;
};

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
  lastStatus?: Record<string, unknown>;
};

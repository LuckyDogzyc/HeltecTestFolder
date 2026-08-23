"use client";

import { useEffect, useMemo, useRef, useState } from 'react';
import { ELEMENT_TYPES, MAX_CUSTOM_ITEMS, elementTypeOf, fitTextToDeviceSlot, makeCustomItem, normalizeTitle, renderValue, sampleCard, templatePrograms } from '@/lib/templates';
import { renderDevicePreviewFrame } from '@/lib/devicePreview';
import { framePayload } from '@/lib/epaperBitmap';
import type { BackgroundColor, CardSample, RenderCommand } from '@/lib/types';

type CardSearchRow = { cardKey: string; n: string; s?: string; r?: string; t?: string; m?: number; l?: number; h?: number; mid?: number; num?: string };
type DisplayInfo = { width: number; height: number; model?: string };
type Account = { email: string };
type OwnedDevice = { deviceId: string; factoryName?: string; displayName?: string; lastSeen?: string; configVersion?: number; cardKey?: string; renderProgram?: RenderCommand[]; lastStatus?: Record<string, unknown>; frame?: { backgroundColor?: BackgroundColor } };
type DiscoverableDevice = { deviceId: string; factoryName?: string; firmware?: string; lastSeen?: string; presence: string };
const PAGE_SIZE = 8;

function cardAmount(card?: CardSearchRow): number | null {
  if (!card) return null;
  return typeof card.m === 'number' ? card.m : (typeof card.l === 'number' ? card.l : null);
}
function cardProductId(cardKey?: string) {
  const productId = Number((cardKey || '').split(':')[1]);
  return Number.isFinite(productId) ? productId : 0;
}
function toPreviewCard(card?: CardSearchRow): CardSample {
  if (!card) return sampleCard;
  return { productId: cardProductId(card.cardKey), cardKey: card.cardKey, title: normalizeTitle(card.n || sampleCard.name), name: card.n || sampleCard.name, set: card.s || sampleCard.set, rarity: card.r || sampleCard.rarity, subType: card.t || sampleCard.subType, market: cardAmount(card) == null ? '--' : String(cardAmount(card)), low: card.l == null ? '--' : String(card.l), mid: card.mid == null ? '--' : String(card.mid), high: card.h == null ? '--' : String(card.h), power: sampleCard.power };
}
function displayFor(device?: OwnedDevice): DisplayInfo {
  const status = device?.lastStatus || {};
  const raw = (status.display || status.screen || status.epaper || {}) as Record<string, unknown>;
  const width = Number(raw.width || raw.w || 250);
  const height = Number(raw.height || raw.h || 122);
  return { width: Number.isFinite(width) && width > 0 ? width : 250, height: Number.isFinite(height) && height > 0 ? height : 122, model: typeof raw.model === 'string' ? raw.model : undefined };
}
function lastUpdatedLabel(value?: string) {
  const date = new Date(value || '');
  if (Number.isNaN(date.getTime())) return '上次更新时间：暂无记录';
  const text = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  return `上次更新时间：${text}`;
}

function deviceState(device: OwnedDevice) {
  const seen = Date.parse(device.lastSeen || '');
  if (!Number.isFinite(seen)) return { label: '未上报', className: 'offline', detail: '等待设备下次唤醒' };
  const ageMin = Math.max(0, (Date.now() - seen) / 60000);
  if (ageMin <= 10) return { label: '在线', className: 'online', detail: '刚刚同步' };
  const sleepMin = Number((device.lastStatus || {}).sleepMin) || 60;
  if (ageMin <= sleepMin * 2) return { label: '沉睡中', className: 'sleeping', detail: '下次唤醒时更新' };
  return { label: '离线', className: 'offline', detail: '配置会保留在云端' };
}

function EpaperPreview({ program, card, display, editable, onChange, backgroundColor }: { program: RenderCommand[]; card: CardSample; display: DisplayInfo; editable?: boolean; onChange?: (next: RenderCommand[]) => void; backgroundColor: BackgroundColor }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState(0);
  const [scale, setScale] = useState(2);
  const deviceWidth = display.width;
  const deviceHeight = display.height;
  // The editor canvas uses the same pixel replay as the true-preview card.
  // DOM text is intentionally not used here: browser Courier metrics cannot
  // represent ESP32 GFX glyph offsets or right/bottom clipping accurately.
  const rasterPreview = renderDevicePreviewFrame(program, card, backgroundColor);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    function updateScale() {
      const width = frame ? Math.max(deviceWidth * 0.45, frame.clientWidth - 20) : deviceWidth;
      const nextScale = Math.max(0.45, Math.min(2, Math.floor((width / deviceWidth) * 100) / 100));
      setScale(nextScale);
    }
    updateScale();
    const observer = new ResizeObserver(updateScale);
    observer.observe(frame);
    window.addEventListener('resize', updateScale);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateScale);
    };
  }, [deviceWidth]);

  function beginDrag(index: number, ev: React.PointerEvent<HTMLDivElement>) {
    if (!editable || !onChange) return;
    const applyChange = onChange;
    ev.currentTarget.setPointerCapture(ev.pointerId);
    setSelected(index);
    const startX = ev.clientX;
    const startY = ev.clientY;
    const origin = program[index];
    function move(e: PointerEvent) {
      // 1 panel pixel per pointer-pixel/scale. Do not clamp: all four edges
      // clip naturally on the panel, so left/top must be movable off-canvas too.
      const dx = Math.round((e.clientX - startX) / scale);
      const dy = Math.round((e.clientY - startY) / scale);
      const next = program.map((item, i) => i === index ? { ...item, x: origin.x + dx, y: origin.y + dy } : item);
      applyChange(next);
    }
    function up() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // 字号缩放：拖动手柄横向距离映射到 font 档位 0-4
  function beginFontScale(index: number, ev: React.PointerEvent<HTMLElement>) {
    if (!editable || !onChange) return;
    ev.stopPropagation();
    const applyChange = onChange;
    ev.currentTarget.setPointerCapture(ev.pointerId);
    const startX = ev.clientX;
    const originFont = program[index].font;
    function move(e: PointerEvent) {
      const dx = (e.clientX - startX) / scale;
      const nextFont = Math.max(-1, Math.min(4, Math.round(originFont + dx / 24))) as -1 | 0 | 1 | 2 | 3 | 4;
      applyChange(program.map((item, i) => i === index ? { ...item, font: nextFont } : item));
    }
    function up() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  return (
    <div className="epaperFrame" ref={frameRef}>
      <div className="epaperViewport" style={{ width: deviceWidth * scale, height: deviceHeight * scale, aspectRatio: `${deviceWidth} / ${deviceHeight}` }}>
        <div className="epaper" style={{ width: deviceWidth, height: deviceHeight, transform: `scale(${scale})` }}>
          <img className="epaperRaster" src={rasterPreview} alt="设备像素布局画布" draggable={false} />
          {program.filter((item) => item.visible).map((item, idx) => {
            const originalIndex = program.indexOf(item);
            const isSelected = editable && selected === originalIndex;
            const label = fitTextToDeviceSlot(renderValue(item.value, card), item.font, item.x, deviceWidth);
            // Hit area follows the actual firmware advance closely enough to select
            // each visible element, while the image beneath remains the sole visual truth.
            const advance = item.font === 4 ? 28 : item.font === 3 ? 21 : item.font === 2 ? 14 : 11;
            const glyphHeight = item.font === 4 ? 38 : item.font === 3 ? 28 : item.font === 2 ? 20 : 15;
            return (
              <div
                key={`${item.value}-${idx}`}
                onPointerDown={(ev) => beginDrag(originalIndex, ev)}
                onClick={() => setSelected(originalIndex)}
                className={`${editable ? 'dragItem dragHit' : 'epaperText'} font${item.font} ${isSelected ? 'selected' : ''}`}
                style={{
                  left: item.x,
                  top: item.y,
                  width: Math.max(12, label.length * advance),
                  height: glyphHeight,
                }}
              >
                {editable && <span className="dragLabel">{label}</span>}
                {editable && (
                  <span
                    className="fontHandle"
                    title="拖动调整字号"
                    onPointerDown={(ev) => beginFontScale(originalIndex, ev)}
                    style={{ position: 'absolute', right: -8, bottom: -8 }}
                  >
                    ⤡
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ProgramEditor({ program, card, display, onChange, backgroundColor, onBackgroundChange }: { program: RenderCommand[]; card: CardSample; display: DisplayInfo; onChange: (next: RenderCommand[]) => void; backgroundColor: BackgroundColor; onBackgroundChange: (color: BackgroundColor) => void }) {
  const availableColors = backgroundColor === 'white' ? [{ value: 0, label: '黑色' }, { value: 1, label: '红色' }] : backgroundColor === 'black' ? [{ value: 2, label: '白色' }, { value: 1, label: '红色' }] : [{ value: 2, label: '白色' }, { value: 0, label: '黑色' }];
  function changeBackground(nextBackground: BackgroundColor) {
    const allowed = nextBackground === 'white' ? [0, 1] : nextBackground === 'black' ? [2, 1] : [2, 0];
    onChange(program.map((item) => allowed.includes(item.color) ? item : { ...item, color: allowed[0] as 0 | 1 | 2 }));
    onBackgroundChange(nextBackground);
  }
  function update(index: number, patch: Partial<RenderCommand>) {
    onChange(program.map((item, i) => i === index ? { ...item, ...patch } : item));
  }
  function removeAt(index: number) {
    onChange(program.filter((_, i) => i !== index));
  }
  function addItem() {
    if (program.length >= MAX_CUSTOM_ITEMS) return;
    const next = makeCustomItem(program.length + 1);
    onChange([...program, { ...next, color: availableColors[0].value as 0 | 1 | 2, y: 20 + program.length * 16, x: 8 }]);
  }
  return (
    <div className="editorGrid">
      <EpaperPreview program={program} card={card} display={display} editable onChange={onChange} backgroundColor={backgroundColor} />
      <div className="fieldList"><div className="fieldPanel backgroundField"><label>屏幕背景</label><select aria-label="屏幕背景" value={backgroundColor} onChange={(e) => changeBackground(e.target.value as BackgroundColor)}><option value="white">白</option><option value="black">黑</option><option value="red">红</option></select></div>
        <div className="fieldListHead">
          <span className="muted">元素列表（{program.length}/{MAX_CUSTOM_ITEMS}）· 画布上拖动移动，右下角手柄缩放字号</span>
        </div>
        {program.map((item, index) => {
          const typeId = elementTypeOf(item.value);
          return (
            <div className="fieldPanel" key={index}>
              <label className="visCheck" title="显示元素"><input type="checkbox" checked={item.visible} onChange={(e) => update(index, { visible: e.target.checked })} /></label>
              <select
                aria-label="元素类型"
                value={typeId}
                onChange={(e) => {
                  const id = e.target.value;
                  const t = ELEMENT_TYPES.find((x) => x.id === id);
                  update(index, { value: t?.id === 'custom' ? '' : (t?.value ?? item.value) });
                }}
              >
                {ELEMENT_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
              {typeId === 'custom' && (
                <input aria-label="自定义文本" value={item.value} placeholder="输入文本，支持 {title} 等占位符" onChange={(e) => update(index, { value: e.target.value })} />
              )}
              <select aria-label="字体颜色" value={item.color} onChange={(e) => update(index, { color: Number(e.target.value) as 0 | 1 | 2 })}>{availableColors.map((color) => <option key={color.value} value={color.value}>{color.label}</option>)}</select>
              <button type="button" className="secondary removeBtn" onClick={() => removeAt(index)}>删除</button>
            </div>
          );
        })}
        <button type="button" className="secondary addBtn" onClick={addItem} disabled={program.length >= MAX_CUSTOM_ITEMS}>＋ 添加元素</button>
      </div>
    </div>
  );
}

export default function Page() {
  const [account, setAccount] = useState<Account | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [devices, setDevices] = useState<OwnedDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState('');
  const [devicePanelOpen, setDevicePanelOpen] = useState(false);
  const [addDeviceOpen, setAddDeviceOpen] = useState(false);
  const [discoverableDevices, setDiscoverableDevices] = useState<DiscoverableDevice[]>([]);
  const [templateId] = useState('custom');
  const [program, setProgram] = useState<RenderCommand[]>(templatePrograms.custom.map((item) => ({ ...item })));
  const [backgroundColor, setBackgroundColor] = useState<BackgroundColor>('white');
  const [q, setQ] = useState('');
  const [cardMarket, setCardMarket] = useState('pokemon-us');
  const [cards, setCards] = useState<CardSearchRow[]>([]);
  const [selectedCard, setSelectedCard] = useState<CardSearchRow | undefined>();
  const [page, setPage] = useState(1);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const selectedDevice = devices.find((device) => device.deviceId === selectedDeviceId);
  const previewCard = useMemo(() => toPreviewCard(selectedCard), [selectedCard]);
  const pagedCards = cards.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const pageCount = Math.max(1, Math.ceil(cards.length / PAGE_SIZE));

  async function loadDevices() {
    const response = await fetch('/api/me/devices', { cache: 'no-store' });
    if (!response.ok) throw new Error('无法读取设备列表');
    const next = (await response.json()).devices as OwnedDevice[] || [];
    setDevices(next);
    const storedDeviceId = window.localStorage.getItem('card-ink:last-device');
    const target = next.find((device) => device.deviceId === storedDeviceId) || next.reduce<OwnedDevice | undefined>((latest, device) => !latest || (device.configVersion || 0) > (latest.configVersion || 0) ? device : latest, undefined);
    if (target) selectDevice(target);
    else setSelectedDeviceId('');
  }
  async function loadSession() {
    try {
      const response = await fetch('/api/auth/me', { cache: 'no-store' });
      if (!response.ok) { setAccount(null); setDevices([]); return; }
      setAccount((await response.json()).user || null);
      await loadDevices();
    } catch { setMessage('无法连接云端，请稍后重试'); } finally { setAuthChecked(true); }
  }
  useEffect(() => { void loadSession(); }, []);
  useEffect(() => { if (addDeviceOpen) void discoverDevices(); }, [addDeviceOpen]);
  async function submitAuth(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true);
    try {
      const response = await fetch('/api/auth/' + authMode, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '认证失败');
      setAccount(data.user || { email }); setPassword(''); await loadDevices();
      setMessage('登录成功。选择设备和卡牌后即可保存。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '认证失败'); } finally { setBusy(false); }
  }
  async function logout() {
    setBusy(true);
    try { await fetch('/api/auth/logout', { method: 'POST' }); setAccount(null); setDevices([]); setSelectedDeviceId(''); setSelectedCard(undefined); } finally { setBusy(false); }
  }
  async function discoverDevices() {
    try {
      const response = await fetch('/api/me/devices/discoverable', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '搜索失败');
      setDiscoverableDevices(data.devices || []);
    } catch (error) { setMessage(error instanceof Error ? error.message : '搜索设备失败'); }
  }
  async function claimNearbyDevice(device: DiscoverableDevice) {
    setBusy(true);
    try {
      const response = await fetch('/api/me/devices/' + encodeURIComponent(device.deviceId) + '/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '绑定失败');
      await loadDevices(); setSelectedDeviceId(device.deviceId); setAddDeviceOpen(false); setDevicePanelOpen(false);
      setMessage('设备已绑定。现在可给它改名并开始配置。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '绑定失败'); } finally { setBusy(false); }
  }
  async function searchCards(nextPage = 1) {
    const query = q.trim();
    if (!query) { setCards([]); return setMessage('输入卡名、系列或编号后再搜索'); }
    try {
      const response = await fetch('/api/cards/search?q=' + encodeURIComponent(query) + '&market=' + encodeURIComponent(cardMarket));
      const next = (await response.json()).cards as CardSearchRow[] || [];
      setCards(next); setPage(nextPage); setMessage(next.length ? '请选择一张卡牌。' : '没有找到相关卡牌。');
    } catch { setMessage('卡牌搜索失败，请稍后重试'); }
  }
  async function loadSelectedDeviceCard(device: OwnedDevice) {
    if (!device.cardKey) { setSelectedCard(undefined); return; }
    try {
      const response = await fetch('/api/prices/latest?cardKey=' + encodeURIComponent(device.cardKey), { cache: 'no-store' });
      if (!response.ok) throw new Error('无法读取设备当前卡牌');
      const data = await response.json();
      const card = data.card || {};
      const price = data.price || {};
      setCardMarket(data.source?.market === 'pokemon-jp' ? 'pokemon-jp' : 'pokemon-us');
      setSelectedCard({ cardKey: card.cardKey || device.cardKey, n: card.localizedName || card.name || device.cardKey, s: card.setName || '', r: card.rarity || '', t: card.variant || '', m: typeof price.amount === 'number' ? price.amount : undefined, l: typeof price.low === 'number' ? price.low : undefined, num: card.number || '' });
    } catch (error) { setMessage(error instanceof Error ? error.message : '无法载入设备当前卡牌'); }
  }
  function selectDevice(device: OwnedDevice) {
    setSelectedDeviceId(device.deviceId);
    window.localStorage.setItem('card-ink:last-device', device.deviceId);
    setDevicePanelOpen(false);
    if (device.renderProgram?.length) setProgram(device.renderProgram.map((item) => ({ ...item })));
    setBackgroundColor(device.frame?.backgroundColor || 'white');
    void loadSelectedDeviceCard(device);
    setMessage('正在载入设备当前排版和卡牌…');
  }
  async function renameDevice(device: OwnedDevice) {
    const displayName = window.prompt('为这台设备命名', device.displayName || device.factoryName || device.deviceId)?.trim();
    if (!displayName) return;
    setBusy(true);
    try {
      const response = await fetch('/api/devices/' + encodeURIComponent(device.deviceId), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName }) });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || '改名失败');
      setDevices((current) => current.map((item) => item.deviceId === device.deviceId ? { ...item, displayName } : item));
      setMessage('设备已命名为“' + displayName + '”。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '改名失败'); } finally { setBusy(false); }
  }

  async function saveCloudConfig() {
    if (!selectedDevice) return setMessage('请先选择设备');
    if (!selectedCard?.cardKey) return setMessage('请先搜索并选择卡牌');
    setBusy(true);
    try {
      const payload = framePayload(program, previewCard, backgroundColor);
      const response = await fetch('/api/devices/' + encodeURIComponent(selectedDevice.deviceId) + '/config', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ productId: cardProductId(selectedCard.cardKey), cardKey: selectedCard.cardKey, templateId, renderProgram: program, frame: { blackB64: payload.blackB64, redB64: payload.redB64, slots: payload.slots, backgroundColor: payload.backgroundColor } }) });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || '保存失败');
      await loadDevices(); setMessage('已保存到云端，设备下次唤醒时自动更新。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '云端保存失败'); } finally { setBusy(false); }
  }

  if (!authChecked) return <main className="authShell"><div className="authCard">正在连接云端…</div></main>;
  if (!account) return <main className="authShell"><section className="authIntro"><span className="wordmark">CARD INK</span><h1>卡牌墨水屏</h1><p>选择卡牌，调整布局，保存到你的设备。</p></section><form className="authCard authForm" onSubmit={submitAuth}><h2>{authMode === 'login' ? '登录' : '创建账号'}</h2><label>邮箱<input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" /></label><label>密码<input type="password" required minLength={6} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={authMode === 'login' ? 'current-password' : 'new-password'} /></label><button className="primaryAction" disabled={busy}>{authMode === 'login' ? '进入控制台' : '注册并开始使用'}</button><button type="button" className="quietButton" onClick={() => setAuthMode(authMode === 'login' ? 'register' : 'login')}>{authMode === 'login' ? '创建账号' : '返回登录'}</button>{message && <p className="message">{message}</p>}</form></main>;

  return <main className="console"><aside className={"sidebar deviceDrawer " + (devicePanelOpen ? "open" : "")}><header><span className="wordmark">CARD INK</span><span className="submark">DEVICE CONSOLE</span></header><section><div className="drawerTitle"><p className="eyebrow">设备列表</p><button className="quietButton" onClick={() => setDevicePanelOpen(false)}>关闭</button></div><button type="button" className="addDeviceButton" onClick={() => setAddDeviceOpen(true)}>＋ 添加设备</button><div className="deviceList">{devices.map((device) => { const state = deviceState(device); return <div className={'deviceRow ' + (selectedDeviceId === device.deviceId ? 'active' : '')} key={device.deviceId}><button className="deviceChoice" onClick={() => selectDevice(device)}><span><i className={state.className}></i>{device.displayName || device.factoryName || device.deviceId}</span><small>{device.deviceId} · v{device.configVersion || 1}</small><small>{state.detail}</small></button><button className="renameButton" onClick={() => void renameDevice(device)}>改名</button></div>; })}{!devices.length && <p className="muted">还没有设备。</p>}</div>{addDeviceOpen && <div className="claimForm nearbyDevices"><div><b>同一网络下未绑定的设备</b><button type="button" className="quietButton" onClick={() => void discoverDevices()}>重新搜索</button></div><p className="muted">仅显示与当前网络相同、正在在线且尚未绑定账号的设备。</p>{discoverableDevices.map((device) => <div className="nearbyDevice" key={device.deviceId}><span><b>{device.factoryName || 'CARD INK'}</b><small>{device.deviceId} · {device.presence === 'online' ? '在线' : '沉睡中'}</small></span><button className="primaryAction" disabled={busy} onClick={() => void claimNearbyDevice(device)}>绑定</button></div>)}{!discoverableDevices.length && <p className="muted">暂未发现可绑定设备。请确认设备已完成 Wi-Fi 配置并刚刚联网。</p>}<button type="button" className="quietButton" onClick={() => setAddDeviceOpen(false)}>取消</button></div>}</section><footer><span>{account.email}</span><button className="quietButton" disabled={busy} onClick={() => void logout()}>退出</button></footer></aside><section className="workspace"><header className="topbar"><button className="deviceMenuButton" onClick={() => setDevicePanelOpen(true)}>设备列表 <span>{devices.length}</span></button><div className="currentDeviceTitle"><span className="eyebrow">当前设备</span><div><h1>{selectedDevice?.displayName || selectedDevice?.factoryName || '选择一台设备'}</h1>{selectedDevice && <button type="button" className="currentRenameButton" aria-label="重命名当前设备" title="重命名当前设备" onClick={() => void renameDevice(selectedDevice)}>✎</button>}</div></div>{selectedDevice && <span className="status lastUpdated">{lastUpdatedLabel(selectedDevice.lastSeen)}</span>}</header><div className="workGrid"><section className="previewPanel"><div className="panelHeading"><div><span className="eyebrow">实时预览</span><h2>设备画面 <small>{displayFor(selectedDevice).width} × {displayFor(selectedDevice).height}</small></h2></div></div>{selectedDevice ? <ProgramEditor program={program} card={previewCard} display={displayFor(selectedDevice)} onChange={setProgram} backgroundColor={backgroundColor} onBackgroundChange={setBackgroundColor} /> : <div className="emptyState">从左侧选择或添加一台设备。</div>}</section><aside className="selectionPanel"><section className="savePanel previewSave"><span className="eyebrow">当前选择</span><b>{selectedCard ? selectedCard.n : '尚未选择卡牌'}</b><small>{selectedCard ? ((selectedCard.s || '--') + ' · ' + (selectedCard.num || '--')) : '搜索并选择一张卡牌后保存。'}</small><button className="primaryAction" disabled={busy || !selectedDevice || !selectedCard} onClick={() => void saveCloudConfig()}>保存到云端</button><p>保存后，设备将在下次唤醒时更新。</p></section></aside><aside className="inspector"><section><span className="eyebrow">卡牌搜索</span><div className="marketSwitch"><button className={cardMarket === 'pokemon-us' ? 'selected' : ''} onClick={() => { setCardMarket('pokemon-us'); setCards([]); }}>美版</button><button className={cardMarket === 'pokemon-jp' ? 'selected' : ''} onClick={() => { setCardMarket('pokemon-jp'); setCards([]); }}>日版</button></div><div className="searchBox"><input value={q} onChange={(event) => setQ(event.target.value)} placeholder="卡名、系列或编号" onKeyDown={(event) => { if (event.key === 'Enter') void searchCards(); }} /><button onClick={() => void searchCards()}>搜索</button></div><div className="searchList">{pagedCards.map((card) => <button className={'cardRow ' + (selectedCard?.cardKey === card.cardKey ? 'active' : '')} key={card.cardKey} onClick={() => { setSelectedCard(card); setMessage('已选择 ' + card.n); }}><b>{card.n}</b><small>{card.s || '--'} · {card.num || '--'} · ${cardAmount(card) ?? '--'}</small></button>)}</div>{cards.length > PAGE_SIZE && <div className="pager"><button className="quietButton" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button><span>{page} / {pageCount}</span><button className="quietButton" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>下一页</button></div>}</section></aside><footer className="activity"><span className="activityDot"></span>{message || '拖动预览文字即可调整布局；没有模板选择，所有设备均使用当前自定义排版。'}</footer></div></section></main>;
}

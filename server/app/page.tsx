"use client";

import { useEffect, useMemo, useRef, useState } from 'react';
import { ELEMENT_TYPES, MAX_CUSTOM_ITEMS, elementTypeOf, fitTextToDeviceSlot, makeCustomItem, normalizeTitle, renderValue, sampleCard, templatePrograms } from '@/lib/templates';
import { renderDevicePreviewFrame } from '@/lib/devicePreview';
import { framePayload } from '@/lib/epaperBitmap';
import type { CardSample, RenderCommand } from '@/lib/types';

type CardSearchRow = { cardKey: string; n: string; s?: string; r?: string; t?: string; m?: number; l?: number; h?: number; mid?: number; num?: string };
type DisplayInfo = { width: number; height: number; model?: string };
type Account = { email: string };
type Plan = 'free' | 'pro';
type OwnedDevice = { deviceId: string; factoryName?: string; displayName?: string; lastSeen?: string; configVersion?: number; cardKey?: string; templateId?: string; renderProgram?: RenderCommand[]; lastStatus?: Record<string, unknown> };
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
function deviceState(device: OwnedDevice) {
  const seen = Date.parse(device.lastSeen || '');
  if (!Number.isFinite(seen)) return { label: '未上报', className: 'offline', detail: '等待设备下次唤醒并上报状态' };
  const ageMin = Math.max(0, (Date.now() - seen) / 60000);
  if (ageMin <= 10) return { label: '在线', className: 'online', detail: '刚刚与云端同步' };
  const sleepMin = Number((device.lastStatus || {}).sleepMin) || 60;
  if (ageMin <= sleepMin * 2) return { label: '沉睡中', className: 'sleeping', detail: '保存后将在下次唤醒时应用' };
  return { label: '离线', className: 'offline', detail: '保存仍会保留在云端，等待下次唤醒' };
}

function EpaperPreview({ program, card, display, editable, onChange }: { program: RenderCommand[]; card: CardSample; display: DisplayInfo; editable?: boolean; onChange?: (next: RenderCommand[]) => void }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState(0);
  const [scale, setScale] = useState(1);
  const raster = renderDevicePreviewFrame(program, card);
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const update = () => setScale(Math.max(0.45, Math.min(2, Math.floor((frame.clientWidth / display.width) * 100) / 100)));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [display.width]);
  function moveItem(index: number, event: React.PointerEvent<HTMLDivElement>) {
    if (!editable || !onChange) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelected(index);
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = program[index];
    const move = (nextEvent: PointerEvent) => onChange(program.map((item, itemIndex) => itemIndex === index ? { ...item, x: origin.x + Math.round((nextEvent.clientX - startX) / scale), y: origin.y + Math.round((nextEvent.clientY - startY) / scale) } : item));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }
  return <div className="epaperFrame" ref={frameRef}><div className="epaperViewport" style={{ width: display.width * scale, height: display.height * scale }}><div className="epaper" style={{ width: display.width, height: display.height, transform: 'scale(' + scale + ')' }}><img className="epaperRaster" src={raster} alt="设备像素布局画布" draggable={false} />{editable && program.map((item, index) => item.visible && <div key={index} className={'dragItem ' + (selected === index ? 'selected' : '')} style={{ left: item.x, top: item.y, width: Math.max(20, fitTextToDeviceSlot(renderValue(item.value, card), item.font, item.x, display.width).length * 11), height: 18 }} onPointerDown={(event) => moveItem(index, event)}><span>{renderValue(item.value, card)}</span></div>)}</div></div></div>;
}
function ProgramEditor({ program, card, display, onChange }: { program: RenderCommand[]; card: CardSample; display: DisplayInfo; onChange: (next: RenderCommand[]) => void }) {
  const update = (index: number, patch: Partial<RenderCommand>) => onChange(program.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  return <div className="editorGrid"><EpaperPreview program={program} card={card} display={display} editable onChange={onChange} /><div className="fieldList"><p className="muted">元素列表（{program.length}/{MAX_CUSTOM_ITEMS}）· 在画布拖动元素，或在此编辑内容和坐标。</p>{program.map((item, index) => <div className="fieldPanel" key={index}><label><input type="checkbox" checked={item.visible} onChange={(event) => update(index, { visible: event.target.checked })} /> 显示</label><select aria-label="元素类型" value={elementTypeOf(item.value)} onChange={(event) => { const type = ELEMENT_TYPES.find((entry) => entry.id === event.target.value); update(index, { value: type?.id === 'custom' ? '' : (type?.value || item.value) }); }}>{ELEMENT_TYPES.map((type) => <option key={type.id} value={type.id}>{type.label}</option>)}</select>{elementTypeOf(item.value) === 'custom' && <input aria-label="自定义文本" value={item.value} onChange={(event) => update(index, { value: event.target.value })} />}<label>X<input type="number" value={item.x} onChange={(event) => update(index, { x: Number(event.target.value) || 0 })} /></label><label>Y<input type="number" value={item.y} onChange={(event) => update(index, { y: Number(event.target.value) || 0 })} /></label><button type="button" className="secondary" onClick={() => onChange(program.filter((_, itemIndex) => itemIndex !== index))}>删除</button></div>)}<button type="button" className="secondary" disabled={program.length >= MAX_CUSTOM_ITEMS} onClick={() => onChange([...program, makeCustomItem(program.length + 1)])}>＋ 添加元素</button></div></div>;
}

export default function Page() {
  const [account, setAccount] = useState<Account | null>(null);
  const [plan, setPlan] = useState<Plan>('free');
  const [authChecked, setAuthChecked] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [devices, setDevices] = useState<OwnedDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState('');
  const [claimDeviceId, setClaimDeviceId] = useState('');
  const [pairingCode, setPairingCode] = useState('');
  const [templateId, setTemplateId] = useState<'price' | 'advanced'>('price');
  const [program, setProgram] = useState<RenderCommand[]>(templatePrograms.price.map((item) => ({ ...item })));
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
    const data = await response.json();
    const next = Array.isArray(data.devices) ? data.devices as OwnedDevice[] : [];
    setDevices(next);
    setSelectedDeviceId((current) => current && next.some((device) => device.deviceId === current) ? current : (next[0]?.deviceId || ''));
  }
  async function loadSession() {
    try {
      const response = await fetch('/api/auth/me', { cache: 'no-store' });
      if (!response.ok) { setAccount(null); setDevices([]); return; }
      const data = await response.json();
      setAccount(data.user || null); setPlan(data.plan === 'pro' ? 'pro' : 'free'); await loadDevices();
    } catch { setMessage('无法连接云端，请稍后重试'); } finally { setAuthChecked(true); }
  }
  useEffect(() => { void loadSession(); }, []);
  function chooseTemplate(next: 'price' | 'advanced') {
    if (next === 'advanced' && plan !== 'pro') return;
    setTemplateId(next);
    setProgram((next === 'advanced' ? templatePrograms.custom : templatePrograms.price).map((item) => ({ ...item })));
  }
  async function submitAuth(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true);
    try {
      const response = await fetch('/api/auth/' + authMode, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '认证失败');
      setAccount(data.user || { email }); setPlan(data.plan === 'pro' ? 'pro' : 'free'); setPassword('');
      setMessage(authMode === 'login' ? '登录成功。请认领或选择你的设备。' : '注册成功。请认领你的第一台设备。'); await loadDevices();
    } catch (error) { setMessage(error instanceof Error ? error.message : '认证失败'); } finally { setBusy(false); }
  }
  async function logout() {
    setBusy(true); try { await fetch('/api/auth/logout', { method: 'POST' }); setAccount(null); setDevices([]); setSelectedDeviceId(''); setSelectedCard(undefined); setMessage('已退出登录'); } finally { setBusy(false); }
  }
  async function claimDevice(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!claimDeviceId.trim() || !pairingCode.trim()) return setMessage('请输入设备 ID 和一次性配对码');
    setBusy(true);
    try {
      const response = await fetch('/api/me/devices/' + encodeURIComponent(claimDeviceId.trim()) + '/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: pairingCode.trim() }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || '认领失败');
      setClaimDeviceId(''); setPairingCode(''); await loadDevices(); setMessage('设备已认领。请选择设备、卡牌和模板后保存到云端。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '认领失败'); } finally { setBusy(false); }
  }
  async function searchCards(nextPage = 1) {
    const query = q.trim(); setSelectedCard(undefined);
    if (!query) { setCards([]); setPage(1); return setMessage('请输入卡名、系列或编号后再搜索'); }
    try {
      const response = await fetch('/api/cards/search?q=' + encodeURIComponent(query) + '&market=' + encodeURIComponent(cardMarket));
      const data = await response.json(); const next = Array.isArray(data.cards) ? data.cards as CardSearchRow[] : [];
      setCards(next); setPage(nextPage); setMessage(next.length ? '找到 ' + next.length + ' 张卡。请点击一张卡牌查看预览。' : '没有找到“' + query + '”，请检查关键词后重试。');
    } catch { setMessage('卡牌搜索失败，请稍后重试'); }
  }
  function selectDevice(device: OwnedDevice) {
    setSelectedDeviceId(device.deviceId);
    const advanced = device.templateId === 'advanced'; setTemplateId(advanced ? 'advanced' : 'price');
    if (device.renderProgram?.length) setProgram(device.renderProgram.map((item) => ({ ...item })));
    setMessage('已选择 ' + (device.displayName || device.factoryName || device.deviceId) + '。保存会进入云端，设备下次唤醒时应用。');
  }
  async function saveCloudConfig() {
    if (!selectedDevice) return setMessage('请先选择一台已认领设备');
    if (!selectedCard?.cardKey) return setMessage('请先搜索并选择一张卡牌');
    if (templateId === 'advanced' && plan !== 'pro') return setMessage('自定义布局仅对 Pro 开放');
    setBusy(true);
    try {
      const payload = framePayload(program, previewCard);
      const response = await fetch('/api/devices/' + encodeURIComponent(selectedDevice.deviceId) + '/config', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ productId: cardProductId(selectedCard.cardKey), cardKey: selectedCard.cardKey, templateId, renderProgram: program, frame: { blackB64: payload.blackB64, redB64: payload.redB64, slots: payload.slots } }) });
      const data = await response.json(); if (!response.ok || !data.ok) throw new Error(data.error || '保存失败');
      await loadDevices(); setMessage('已保存到云端。设备将在下次唤醒并连接云端时自动应用此配置。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '云端保存失败'); } finally { setBusy(false); }
  }

  if (!authChecked) return <main className="shell"><div className="card authCard">正在验证账号…</div></main>;
  if (!account) return <main className="shell authShell"><section className="hero"><div><span className="badge">云端墨水屏管理</span><h1>选择卡牌，云端保存</h1><p className="muted">登录后认领设备；设备下次唤醒时自动拉取显示配置。</p></div></section><form className="card authCard stack" onSubmit={submitAuth}><h2>{authMode === 'login' ? '登录账号' : '注册账号'}</h2><label>邮箱<input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" /></label><label>密码<input type="password" required minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={authMode === 'login' ? 'current-password' : 'new-password'} /></label><button className="primaryAction" disabled={busy}>{authMode === 'login' ? '登录并管理设备' : '注册并开始使用'}</button><button type="button" className="secondary" onClick={() => setAuthMode(authMode === 'login' ? 'register' : 'login')}>{authMode === 'login' ? '没有账号？注册' : '已有账号？登录'}</button>{message && <p className="message">{message}</p>}</form></main>;

  return <main className="shell"><section className="hero"><div><span className="badge">云端墨水屏管理</span><h1>Pokémon Display</h1><p className="muted">流程：认领或选择设备 → 选择卡牌和模板 → 保存到云端 → 设备下次唤醒自动应用。</p></div><div className="accountBar"><span>{account.email}</span><b className={'plan ' + plan}>{plan === 'pro' ? 'Pro' : '免费版'}</b><button className="secondary" disabled={busy} onClick={() => void logout()}>退出登录</button></div></section><section className="layout"><aside className="side stack"><div className="card"><h2>1. 我的设备</h2><p className="muted">设备 ID 与一次性配对码由设备配网页或包装提供。认领后仅你的账号可保存配置。</p><form className="stack claimForm" onSubmit={claimDevice}><input aria-label="设备 ID" value={claimDeviceId} onChange={(event) => setClaimDeviceId(event.target.value)} placeholder="设备 ID" /><input aria-label="一次性配对码" value={pairingCode} onChange={(event) => setPairingCode(event.target.value)} placeholder="一次性配对码" /><button disabled={busy}>认领设备</button></form><div className="stack deviceList">{devices.map((device) => { const state = deviceState(device); return <button key={device.deviceId} className={'deviceChoice ' + (selectedDeviceId === device.deviceId ? 'active' : '')} onClick={() => selectDevice(device)}><b>{device.displayName || device.factoryName || device.deviceId} <span className={'presence ' + state.className}>{state.label}</span></b><span>{device.deviceId} · 配置 v{device.configVersion || 1}</span><span>{state.detail}</span>{device.cardKey && <span>已保存卡牌：{device.cardKey}</span>}</button>; })}{!devices.length && <p className="muted">还没有已认领设备。输入设备 ID 和一次性配对码开始。</p>}</div></div><div className="card"><h2>2. 搜索卡牌</h2><div className="searchBox"><select value={cardMarket} onChange={(event) => { setCardMarket(event.target.value); setCards([]); setSelectedCard(undefined); }} aria-label="卡牌市场"><option value="pokemon-us">宝可梦美国</option><option value="pokemon-jp">宝可梦日本</option></select><input value={q} onChange={(event) => setQ(event.target.value)} placeholder="卡名、系列或编号" onKeyDown={(event) => { if (event.key === 'Enter') void searchCards(); }} /><button type="button" onClick={() => void searchCards()}>搜索</button></div><p className="muted">仅搜索单卡；密封产品已过滤。</p><div className="searchList">{pagedCards.map((card) => <button className={'cardRow ' + (selectedCard?.cardKey === card.cardKey ? 'active' : '')} key={card.cardKey} onClick={() => { setSelectedCard(card); setMessage('已选择 ' + card.n + '，预览已更新。'); }}><b>{card.n}</b><span>{card.s || '--'} · {card.num || '--'} · {card.t || '默认版本'} · Market {cardAmount(card) == null ? '--' : '$' + cardAmount(card)}</span></button>)}</div><p className={selectedCard ? 'selectedCardNotice ok' : 'selectedCardNotice muted'}>{selectedCard ? '当前已选：' + selectedCard.n + ' · ' + (selectedCard.num || '--') : '搜索后请选择一张卡牌。'}</p>{!!cards.length && <div className="pager"><button className="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button><span>{page} / {pageCount}</span><button className="secondary" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>下一页</button></div>}</div></aside><section className="main stack"><div className="card"><div className="sectionTitle"><div><h2>3. 模板</h2><p className="muted">免费版可使用官方基础模板。Pro 可创建高级自定义布局。</p></div><button className="primaryAction" disabled={busy || !selectedDevice || !selectedCard} onClick={() => void saveCloudConfig()}>保存到云端</button></div><div className="templateTabs"><button className={templateId === 'price' ? 'active' : 'secondary'} onClick={() => chooseTemplate('price')}>官方基础模板</button><button className={templateId === 'advanced' ? 'active' : 'secondary'} disabled={plan !== 'pro'} onClick={() => chooseTemplate('advanced')}>Pro 自定义布局</button></div>{plan !== 'pro' && <div className="upgradeNotice"><b>Pro 功能已锁定</b><span>高级自定义布局仅限 Pro。当前免费版仍可搜索卡牌、使用官方模板并保存到你的设备。</span></div>}</div><div className="card previewCard"><div className="sectionTitle"><h2>4. 像素预览</h2><span className="muted">与设备显示规则一致的预览</span></div>{selectedCard ? <img src={renderDevicePreviewFrame(program, previewCard)} alt="设备像素预览" className="previewImage" /> : <div className="noPreview">请选择一张卡牌以查看预览。</div>}</div><div className="card previewCard"><div className="sectionTitle"><h2>{templateId === 'advanced' ? 'Pro 自定义布局编辑器' : '官方基础模板预览'}</h2><span className="muted">{selectedDevice ? (selectedDevice.displayName || selectedDevice.deviceId) : '请先选择设备'}</span></div>{!selectedDevice ? <div className="noPreview">先选择已认领设备，再配置卡牌和模板。</div> : templateId === 'advanced' && plan === 'pro' ? <ProgramEditor program={program} card={previewCard} display={displayFor(selectedDevice)} onChange={setProgram} /> : <EpaperPreview program={program} card={previewCard} display={displayFor(selectedDevice)} />}</div><div className="message">{message || '所有修改仅保存到云端；设备在下次唤醒时自动应用。'}</div></section></section></main>;
}

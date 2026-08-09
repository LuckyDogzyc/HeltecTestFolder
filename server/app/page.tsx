"use client";

import { useEffect, useMemo, useRef, useState } from 'react';
import { fitTextToDeviceSlot, normalizeTitle, renderValue, sampleCard, templateLabels, templatePrograms, ELEMENT_TYPES, MAX_CUSTOM_ITEMS, elementTypeOf, makeCustomItem } from '@/lib/templates';
import { framePayload, renderPreviewFrame, LOGICAL_W, LOGICAL_H } from '@/lib/epaperBitmap';
import type { CardSample, RenderCommand } from '@/lib/types';

type CardSearchRow = { cardKey: string; sourceId: string; market: string; n: string; s?: string; r?: string; t?: string; m?: number; l?: number; h?: number; mid?: number; num?: string };
type DisplayInfo = { width: number; height: number; colors?: number; model?: string; rotation?: number };
type LanDevice = { ip: string; name: string; deviceId: string; status: any; display?: DisplayInfo; presence?: 'online' | 'sleeping' | 'offline'; nextWakeAt?: string; cloudOnly?: boolean };
const PAGE_SIZE = 8;

function cardVariantKey(card?: CardSearchRow) {
  if (!card) return '';
  return card.cardKey;
}

// 价格取值：优先 market(m)，缺失时回退 low(l)（与 /api/prices/latest 的 amount 逻辑一致）
function cardAmount(card?: CardSearchRow): number | null {
  if (!card) return null;
  if (typeof card.m === 'number') return card.m;
  if (typeof card.l === 'number') return card.l;
  return null;
}

function cardProductId(cardKey?: string) {
  const productId = Number((cardKey || '').split(':')[1]);
  return Number.isFinite(productId) ? productId : 0;
}

function toPreviewCard(card?: CardSearchRow): CardSample {
  if (!card) return sampleCard;
  return {
    productId: cardProductId(card.cardKey),
    cardKey: card.cardKey,
    title: normalizeTitle(card.n || sampleCard.name),
    name: card.n || sampleCard.name,
    set: card.s || sampleCard.set,
    rarity: card.r || sampleCard.rarity,
    subType: card.t || sampleCard.subType,
    market: cardAmount(card) == null ? '--' : String(cardAmount(card)),
    low: card.l == null ? '--' : String(card.l),
    mid: card.mid == null ? '--' : String(card.mid),
    high: card.h == null ? '--' : String(card.h),
    power: sampleCard.power,
  };
}

function normalizeDisplayInfo(status: any): DisplayInfo | undefined {
  const raw = status?.display || status?.screen || status?.epaper;
  const width = Number(raw?.width ?? raw?.w);
  const height = Number(raw?.height ?? raw?.h);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined;
  return {
    width: Math.round(width),
    height: Math.round(height),
    colors: Number(raw?.colors) || undefined,
    model: raw?.model || raw?.name || undefined,
    rotation: Number(raw?.rotation) || 0,
  };
}

function EpaperPreview({ program, card, display, editable, onChange }: { program: RenderCommand[]; card: CardSample; display: DisplayInfo; editable?: boolean; onChange?: (next: RenderCommand[]) => void }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState(0);
  const [scale, setScale] = useState(2);
  const deviceWidth = display.width;
  const deviceHeight = display.height;

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    function updateScale() {
      const width = frame?.clientWidth || deviceWidth;
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
      const dx = Math.round((e.clientX - startX) / scale / 4) * 4;
      const dy = Math.round((e.clientY - startY) / scale / 4) * 4;
      const next = program.map((item, i) => i === index ? { ...item, x: Math.max(0, Math.min(deviceWidth - 1, origin.x + dx)), y: Math.max(0, Math.min(deviceHeight - 1, origin.y + dy)) } : item);
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
      const nextFont = Math.max(0, Math.min(4, Math.round(originFont + dx / 24))) as 0 | 1 | 2 | 3 | 4;
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
          {program.filter((item) => item.visible).map((item, idx) => {
            const originalIndex = program.indexOf(item);
            const isSelected = editable && selected === originalIndex;
            return (
              <div
                key={`${item.value}-${idx}`}
                onPointerDown={(ev) => beginDrag(originalIndex, ev)}
                onClick={() => setSelected(originalIndex)}
                className={`${editable ? 'dragItem' : 'epaperText'} ${item.color === 1 ? 'red' : 'black'} font${item.font} ${isSelected ? 'selected' : ''}`}
                style={{
                  left: item.x,
                  top: item.y,
                }}
              >
                {fitTextToDeviceSlot(renderValue(item.value, card), item.font, item.x, deviceWidth)}
                {isSelected && editable && (
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

function ProgramEditor({ program, card, display, onChange }: { program: RenderCommand[]; card: CardSample; display: DisplayInfo; onChange: (next: RenderCommand[]) => void }) {
  function update(index: number, patch: Partial<RenderCommand>) {
    onChange(program.map((item, i) => i === index ? { ...item, ...patch } : item));
  }
  function removeAt(index: number) {
    onChange(program.filter((_, i) => i !== index));
  }
  function addItem() {
    if (program.length >= MAX_CUSTOM_ITEMS) return;
    const next = makeCustomItem(program.length + 1);
    onChange([...program, { ...next, y: 20 + program.length * 16, x: 8 }]);
  }
  return (
    <div className="editorGrid">
      <EpaperPreview program={program} card={card} display={display} editable onChange={onChange} />
      <div className="fieldList">
        <div className="fieldListHead">
          <span className="muted">元素列表（{program.length}/{MAX_CUSTOM_ITEMS}）· 画布上拖动移动，右下角手柄缩放字号</span>
        </div>
        {program.map((item, index) => {
          const typeId = elementTypeOf(item.value);
          return (
            <div className="fieldPanel" key={index}>
              <label className="visCheck"><input type="checkbox" checked={item.visible} onChange={(e) => update(index, { visible: e.target.checked })} /> 显示</label>
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
              <select aria-label="颜色" value={item.color} onChange={(e) => update(index, { color: Number(e.target.value) as 0 | 1 })}>
                <option value={0}>黑色</option><option value={1}>红色</option>
              </select>
              <button type="button" className="secondary removeBtn" onClick={() => removeAt(index)}>删除</button>
            </div>
          );
        })}
        <button type="button" className="secondary addBtn" onClick={addItem} disabled={program.length >= MAX_CUSTOM_ITEMS}>＋ 添加元素</button>
      </div>
    </div>
  );
}

function ipCandidates() {
  const ranges = ['192.168.31', '192.168.1', '192.168.0', '10.0.0'];
  const preferred = [218, 1, 2, 3, 4, 5, 10, 20, 50, 100, 101, 102, 150, 200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210];
  const all: string[] = [];
  for (const r of ranges) for (const n of preferred) all.push(`${r}.${n}`);
  for (let n = 2; n < 255; n++) all.push(`192.168.31.${n}`);
  return Array.from(new Set(all));
}

async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 900, timeoutMessage?: string) {
  const controller = new AbortController();
  let didTimeout = false;
  const timer = window.setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal, cache: 'no-store', mode: 'cors' });
  } catch (error) {
    if (didTimeout) {
      throw new Error(timeoutMessage || `请求超时：设备 ${Math.round(timeoutMs / 1000)} 秒内没有返回`);
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

export default function Page() {
  const [templateId, setTemplateId] = useState('price');
  const [program, setProgram] = useState<RenderCommand[]>(templatePrograms.price.map((x) => ({ ...x })));
  const [q, setQ] = useState('');
  const [cardMarket, setCardMarket] = useState('pokemon-us');
  const [cards, setCards] = useState<CardSearchRow[]>([]);
  const [selectedCard, setSelectedCard] = useState<CardSearchRow | undefined>();
  const [page, setPage] = useState(1);
  const [lanDevices, setLanDevices] = useState<LanDevice[]>([]);
  const [selectedDeviceIp, setSelectedDeviceIp] = useState('');
  const [scanning, setScanning] = useState(false);
  const [message, setMessage] = useState('');

  const previewCard = useMemo(() => toPreviewCard(selectedCard), [selectedCard]);
  const pagedCards = cards.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const pageCount = Math.max(1, Math.ceil(cards.length / PAGE_SIZE));
  const selectedDevice = lanDevices.find((d) => d.ip === selectedDeviceIp);
  const selectedDisplay = selectedDevice?.display;

  function chooseTemplate(id: string) {
    setTemplateId(id);
    setProgram((id === 'custom' ? program : templatePrograms[id]).map((item) => ({ ...item })));
  }

  async function searchCards(nextPage = 1) {
    const query = q.trim();
    setSelectedCard(undefined);
    if (!query) {
      setCards([]);
      setPage(1);
      return setMessage('请输入卡名、系列或卡牌编号后再搜索');
    }
    const res = await fetch(`/api/cards/search?q=${encodeURIComponent(query)}&market=${encodeURIComponent(cardMarket)}`);
    const data = await res.json();
    const nextCards = data.cards || [];
    setCards(nextCards);
    setPage(nextPage);
    setMessage(nextCards.length ? `找到 ${nextCards.length} 张卡，已按相关性和价格排序；无价格会显示 --，请点击一张卡牌后再更新设备` : `没有找到“${query}”，请检查编号/市场后重搜`);
  }

  function useCard(card: CardSearchRow) {
    setSelectedCard(card);
    setMessage(`已选择 ${card.n}，预览已更新`);
  }

  async function probeIp(ip: string): Promise<LanDevice | null> {
    try {
      const res = await fetchWithTimeout(`http://${ip}/api/status`);
      if (!res.ok) return null;
      const status = await res.json();
      if (!status?.wifi && !status?.config) return null;
      const display = normalizeDisplayInfo(status);
      return { ip, name: status.server?.deviceId || status.wifi?.apSsid || `pokemon-display-${ip.split('.').pop()}`, deviceId: status.server?.deviceId || '', status, display, presence: 'online' };
    } catch {
      return null;
    }
  }

  // 从云端拉取注册设备列表：睡眠中的设备也显示（三态），WebUI 修改走云端异步同步
  async function loadCloudDevices() {
    try {
      const res = await fetch(`/api/devices?currentNetwork=0`);
      const data = await res.json();
      const cloud = (data.devices || [])
        .filter((d: any) => d.deviceId && !d.isDemo)
        .map((d: any) => ({
          ip: d.lanIp || d.deviceId,
          name: d.displayName || d.factoryName || d.deviceId,
          deviceId: d.deviceId,
          status: d.lastStatus || {},
          display: normalizeDisplayInfo(d.lastStatus || {}),
          presence: d.presence || 'offline',
          nextWakeAt: d.nextWakeAt || undefined,
          cloudOnly: true,
        }));
      setLanDevices((prev) => {
        const merged = [...prev];
        for (const c of cloud) {
          const sameIp = merged.find((m) => !m.cloudOnly && m.ip === c.ip);
          if (sameIp) {
            sameIp.presence = 'online';
            sameIp.nextWakeAt = undefined;
            sameIp.cloudOnly = false;
          } else if (!merged.some((m) => m.deviceId === c.deviceId)) {
            merged.push(c);
          }
        }
        return merged;
      });
    } catch {
      // 云端不可达时静默：局域网扫描仍可用
    }
  }

  async function scanLanDevices() {
    setScanning(true);
    setMessage('正在搜索局域网设备，大约需要几秒...');
    const found: LanDevice[] = [];
    const candidates = ipCandidates();
    const concurrency = 24;
    let index = 0;
    async function worker() {
      while (index < candidates.length && found.length < 8) {
        const ip = candidates[index++];
        const hit = await probeIp(ip);
        if (hit && !found.some((d) => d.ip === hit.ip)) {
          found.push(hit);
          setLanDevices([...found]);
          if (!selectedDeviceIp) setSelectedDeviceIp(hit.ip);
        }
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));
    setScanning(false);
    await loadCloudDevices();
    const onlineCount = found.length;
    const sleepingCount = lanDevices.filter((d) => d.presence === 'sleeping').length;
    setMessage(onlineCount
      ? `发现 ${onlineCount} 台局域网设备${sleepingCount ? `，另有 ${sleepingCount} 台注册设备在沉睡中（修改会异步同步，唤醒后生效）` : ''}`
      : `没有发现在线设备${sleepingCount ? `，但有 ${sleepingCount} 台注册设备在沉睡中：修改会保存到云端，设备唤醒后自动更新` : '：请确认手机/电脑和 ESP32 在同一 Wi-Fi，且已烧录新版固件'}`);
  }

  async function updateDevice() {
    if (!selectedDeviceIp) return setMessage('请先搜索并选择一台局域网设备');
    const target = lanDevices.find((d) => d.ip === selectedDeviceIp);
    if (!selectedCard?.cardKey) return setMessage('请先选择一张卡牌');
    // 云端设备（浏览器无法直连 ESP32，可能跨网段/睡眠）：保存到云端，等设备唤醒时拉取。
    // 固件拉取后走 renderProgram 指令路径渲染（方向已修正），位图直连下发仅限局域网设备。
    if (target?.cloudOnly) {
      try {
        setMessage('设备在云端（可能睡眠/跨网段），正在保存到云端，唤醒后自动应用...');
        const res = await fetch(`/api/devices/${encodeURIComponent(target.deviceId)}/config`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ productId: cardProductId(selectedCard.cardKey), templateId, renderProgram: program }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
        setMessage(`已保存到云端：设备 ${target.deviceId} 唤醒后将自动应用（预计 ${target.nextWakeAt ? new Date(target.nextWakeAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '下次唤醒'}）。注意：云端通道走指令渲染（内置字体），如需位图（任意字体/大字号），请让设备与浏览器在同一局域网后直连下发。`);
        return;
      } catch (e) {
        return setMessage(`云端保存失败：${e instanceof Error ? e.message : e}`);
      }
    }
    // 局域网设备：浏览器直连，Web canvas 渲染静态层（任意字体字号）→ 双平面下发；动态槽位固件本地画。
    // 这是设备的默认渲染路径，之后改字体/排版只需重新下发，不用刷固件。
    const payload = framePayload(program, previewCard);
    const body = {
      blackB64: payload.blackB64,
      redB64: payload.redB64,
      slots: JSON.stringify(payload.slots),
      refresh: true,
      cardKey: selectedCard.cardKey,
      productId: cardProductId(selectedCard.cardKey),
    };
    setMessage('正在渲染静态层位图并下发...');
    const res = await fetchWithTimeout(`http://${selectedDeviceIp}/api/frame`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(body),
    }, 90000, '设备正在刷新墨水屏，90 秒内没有返回。请看一下屏幕是否已完成刷新；如果屏幕已更新，可以继续使用。');
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const slotCount = payload.slots.length;
    setMessage(`已更新 ${selectedDeviceIp}：静态层位图（任意字体）已下发，${slotCount} 个动态槽位（价格/时间）由设备本地绘制。`);
  }

  return (
    <main className="shell">
      <section className="hero">
        <div>
          <span className="badge">LAN Bridge WebUI</span>
          <h1>Pokémon Display Manager</h1>
          <p className="muted">公网服务器只负责搜索和排版；浏览器自动搜索同局域网 ESP32，并把最终显示规则直接下发给设备。</p>
        </div>
        <div className="heroActions">
          <button className="primaryAction" onClick={() => updateDevice().catch((e) => setMessage(`更新失败：${e.message}`))}>更新设备显示（位图）</button>
        </div>
      </section>

      <section className="layout">
        <aside className="side stack">
          <div className="card">
            <h2>1、选择显示设备</h2>
            <p className="muted">搜索同一局域网内的显示设备，请先配置设备连上热点。</p>
            <button onClick={scanLanDevices} disabled={scanning}>{scanning ? '搜索中...' : '搜索设备'}</button>
            <details className="helpBlock">
              <summary>如何将设备连接至局域网</summary>
              <ol className="muted helpList">
                <li>给 ESP32 显示设备通电。</li>
                <li>手机连接设备发出的配置热点。</li>
                <li>在配置页选择家里/办公室 Wi-Fi，输入密码并保存。</li>
                <li>设备重启后，手机切回同一个 Wi-Fi，再点击“搜索设备”。</li>
              </ol>
            </details>
            <div className="stack deviceList">
              {lanDevices.map((d) => {
                const presence = d.presence || (d.cloudOnly ? 'offline' : 'online');
                const badge = presence === 'online' ? '🟢 在线' : presence === 'sleeping' ? '💤 沉睡中' : '⚫ 离线';
                const wake = presence === 'sleeping' && d.nextWakeAt ? ` · 预计唤醒 ${new Date(d.nextWakeAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : '';
                return (
                  <button
                    key={d.ip}
                    onClick={() => setSelectedDeviceIp(d.ip)}
                    className={`deviceChoice ${selectedDeviceIp === d.ip ? 'active' : ''}`}
                  >
                    <b>{d.name} <span className={`presence ${presence}`}>{badge}</span></b>
                    <span>{d.ip} · {d.display ? `${d.display.width}×${d.display.height}${d.display.model ? ` · ${d.display.model}` : ''}` : '未返回屏幕信息，需升级固件'}{wake}{d.cloudOnly && presence !== 'online' ? ' · 异步同步' : ''}</span>
                  </button>
                );
              })}
              {!lanDevices.length && <p className="muted">不用输入 IP。点击搜索后，选择发现的 Pokémon Display 设备。</p>}
            </div>
          </div>

          <div className="card">
            <h2>2、卡牌搜索</h2>
            <div className="searchBox">
              <select value={cardMarket} onChange={(e) => { setCardMarket(e.target.value); setCards([]); setSelectedCard(undefined); }} aria-label="卡牌市场">
                <option value="pokemon-us">宝可梦美国</option>
                <option value="pokemon-jp">宝可梦日本</option>
              </select>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="例：Charizard promo / SWSH133 / 103/081" onKeyDown={(e) => { if (e.key === 'Enter') searchCards(); }} />
              <button onClick={() => searchCards()}>搜索</button>
            </div>
            <p className="muted">当前只搜索单卡，盒子、铁盒、补充包等密封产品已先过滤，后续可单独加分类。</p>
            <div className="searchList">
              {pagedCards.map((c) => <button className={`cardRow ${cardVariantKey(selectedCard) === cardVariantKey(c) ? 'active' : ''}`} key={cardVariantKey(c)} onClick={() => useCard(c)}><b>{c.n}</b><span>{c.s || '--'} · {c.num || '--'} · {c.r || '--'} · {c.t || '默认版本'} · Market {cardAmount(c) == null ? '--' : `$${cardAmount(c)}`}</span></button>)}
            </div>
            <p className={selectedCard ? 'selectedCardNotice ok' : 'selectedCardNotice muted'}>{selectedCard ? `当前已选：${selectedCard.n} · ${selectedCard.num || '--'} · ${selectedCard.s || '--'} · ${selectedCard.t || '默认版本'}` : '当前未选择卡牌：搜索后必须点击一条结果，才会下发到设备。'}</p>
            {!cards.length && <p className="muted">输入关键词后搜索；结果会优先按名称/系列/编号相关性排序，其次参考价格。</p>}
            {!!cards.length && <div className="pager"><button className="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button><span>{page} / {pageCount}</span><button className="secondary" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>下一页</button></div>}
          </div>
        </aside>

        <section className="main stack">
          <div className="card">
            <h2>3、显示设置</h2>
            <div className="templateTabs">{Object.entries(templateLabels).map(([id, label]) => <button key={id} className={templateId === id ? 'active' : 'secondary'} onClick={() => chooseTemplate(id)}>{label}</button>)}</div>
          </div>
          <div className="card previewCard">
            <div className="sectionTitle"><h2>4、真实渲染预览</h2><span className="muted">与下发到设备的位图完全一致（122×250 像素，三色）</span></div>
            <div className="realPreviewWrap">
              {selectedCard ? (() => {
                try {
                  const preview = renderPreviewFrame(program, previewCard);
                  return (
                    <>
                      <img src={preview} alt="设备真实渲染预览" style={{ width: LOGICAL_W * 2, height: LOGICAL_H * 2, imageRendering: 'pixelated', border: '1px solid #111', maxWidth: '100%' }} />
                      <div className="muted">与下发位图同源渲染；价格等动态字段在设备上会以固件字体实时更新（位置颜色一致，字形近似）。</div>
                    </>
                  );
                } catch {
                  return <div className="noPreview">渲染失败，请检查布局。</div>;
                }
              })() : <div className="noPreview">请先搜索并选择一张卡牌，此处显示真实渲染效果。</div>}
            </div>
          </div>
          <div className="card previewCard">
            <div className="sectionTitle"><h2>{templateId === 'custom' ? '自定义布局编辑器' : `模板：${templateLabels[templateId]}`}</h2><span className="muted">当前卡牌：{previewCard.name}</span></div>
            {!selectedDeviceIp && <div className="noPreview">请先在第 1 步选择设备。选择设备后，会读取该设备的墨水屏型号和尺寸，再显示排版预览。</div>}
            {selectedDeviceIp && !selectedDisplay && <div className="noPreview">当前设备没有返回墨水屏尺寸信息，因此不显示预览。请升级设备固件后重新搜索。</div>}
            {selectedDisplay && (templateId === 'custom' ? <ProgramEditor program={program} card={previewCard} display={selectedDisplay} onChange={setProgram} /> : <EpaperPreview program={program} card={previewCard} display={selectedDisplay} />)}
          </div>
          <details className="card">
          <summary>高级：下发给设备的显示规则</summary>
          <pre className="code">{JSON.stringify({ templateId, display: selectedDisplay, cardKey: selectedCard?.cardKey, productId: cardProductId(selectedCard?.cardKey), dataUrl: selectedCard?.cardKey ? `/api/prices/latest?cardKey=${selectedCard.cardKey}` : '', renderProgram: program }, null, 2)}</pre>
          </details>
          <div className="message">{message || '流程：搜索设备 → 搜索并选择卡牌 → 选择模板/调整布局 → 更新设备显示。'}</div>
        </section>
      </section>
    </main>
  );
}

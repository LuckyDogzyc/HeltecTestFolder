"use client";

import { useEffect, useMemo, useRef, useState } from 'react';
import { fitTextToDeviceSlot, normalizeTitle, renderValue, sampleCard, templateLabels, templatePrograms } from '@/lib/templates';
import type { CardSample, RenderCommand } from '@/lib/types';

type CardSearchRow = { cardKey: string; sourceId: string; market: string; n: string; s?: string; r?: string; t?: string; m?: number; l?: number; h?: number; mid?: number; num?: string };
type LanDevice = { ip: string; name: string; deviceId: string; status: any };
const PAGE_SIZE = 8;

function cardVariantKey(card?: CardSearchRow) {
  if (!card) return '';
  return card.cardKey;
}

function toPreviewCard(card?: CardSearchRow): CardSample {
  if (!card) return sampleCard;
  return {
    productId: 0,
    cardKey: card.cardKey,
    title: normalizeTitle(card.n || sampleCard.name),
    name: card.n || sampleCard.name,
    set: card.s || sampleCard.set,
    rarity: card.r || sampleCard.rarity,
    subType: card.t || sampleCard.subType,
    market: card.m == null ? sampleCard.market : String(card.m),
    low: card.l == null ? sampleCard.low : String(card.l),
    mid: card.mid == null ? sampleCard.mid : String(card.mid),
    high: card.h == null ? sampleCard.high : String(card.h),
    power: sampleCard.power,
  };
}

function EpaperPreview({ program, card, editable, onChange }: { program: RenderCommand[]; card: CardSample; editable?: boolean; onChange?: (next: RenderCommand[]) => void }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState(0);
  const [scale, setScale] = useState(2);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    function updateScale() {
      const width = frame?.clientWidth || 500;
      const nextScale = Math.max(0.72, Math.min(2, Math.floor((width / 250) * 100) / 100));
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
  }, []);

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
      const next = program.map((item, i) => i === index ? { ...item, x: Math.max(0, Math.min(249, origin.x + dx)), y: Math.max(0, Math.min(121, origin.y + dy)) } : item);
      applyChange(next);
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
      <div className="epaperViewport" style={{ width: 250 * scale, height: 122 * scale }}>
        <div className="epaper" style={{ transform: `scale(${scale})` }}>
          {program.filter((item) => item.visible).map((item, idx) => {
            const originalIndex = program.indexOf(item);
            return (
              <div
                key={`${item.value}-${idx}`}
                onPointerDown={(ev) => beginDrag(originalIndex, ev)}
                onClick={() => setSelected(originalIndex)}
                className={`${editable ? 'dragItem' : 'epaperText'} ${item.color === 1 ? 'red' : 'black'} font${item.font} ${editable && selected === originalIndex ? 'selected' : ''}`}
                style={{
                  left: item.x,
                  top: item.y - (item.font === 2 ? 19 : 14),
                }}
              >
                {fitTextToDeviceSlot(renderValue(item.value, card), item.font, item.x)}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ProgramEditor({ program, card, onChange }: { program: RenderCommand[]; card: CardSample; onChange: (next: RenderCommand[]) => void }) {
  function update(index: number, patch: Partial<RenderCommand>) {
    onChange(program.map((item, i) => i === index ? { ...item, ...patch } : item));
  }
  return (
    <div className="editorGrid">
      <EpaperPreview program={program} card={card} editable onChange={onChange} />
      <div className="fieldList">
        {program.map((item, index) => (
          <div className="fieldPanel" key={index}>
            <label><input type="checkbox" checked={item.visible} onChange={(e) => update(index, { visible: e.target.checked })} /> 显示</label>
            <input aria-label="字段内容" value={item.value} onChange={(e) => update(index, { value: e.target.value })} />
            <input aria-label="X" type="number" value={item.x} min={0} max={249} onChange={(e) => update(index, { x: Number(e.target.value) })} />
            <input aria-label="Y" type="number" value={item.y} min={0} max={121} onChange={(e) => update(index, { y: Number(e.target.value) })} />
            <select value={item.font} onChange={(e) => update(index, { font: Number(e.target.value) as 0 | 1 | 2 })}>
              <option value={0}>小号</option><option value={1}>粗体9</option><option value={2}>标题/价格</option>
            </select>
            <select value={item.color} onChange={(e) => update(index, { color: Number(e.target.value) as 0 | 1 })}>
              <option value={0}>黑色</option><option value={1}>红色</option>
            </select>
          </div>
        ))}
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

  function chooseTemplate(id: string) {
    setTemplateId(id);
    setProgram((id === 'custom' ? program : templatePrograms[id]).map((item) => ({ ...item })));
  }

  async function searchCards(nextPage = 1) {
    const query = q.trim();
    if (!query) {
      setCards([]);
      setSelectedCard(undefined);
      setPage(1);
      return setMessage('请输入卡名、系列或卡牌编号后再搜索');
    }
    const res = await fetch(`/api/cards/search?q=${encodeURIComponent(query)}&market=${encodeURIComponent(cardMarket)}`);
    const data = await res.json();
    setCards(data.cards || []);
    setPage(nextPage);
    setMessage(`找到 ${data.cards?.length || 0} 张卡，已按相关性和价格排序`);
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
      return { ip, name: status.server?.deviceId || status.wifi?.apSsid || `pokemon-display-${ip.split('.').pop()}`, deviceId: status.server?.deviceId || '', status };
    } catch {
      return null;
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
    setMessage(found.length ? `发现 ${found.length} 台局域网设备` : '没有自动发现设备：请确认手机/电脑和 ESP32 在同一 Wi-Fi，且已烧录新版固件');
  }

  async function updateDevice() {
    if (!selectedDeviceIp) return setMessage('请先搜索并选择一台局域网设备');
    if (!selectedCard?.cardKey) return setMessage('请先选择一张卡牌');
    const origin = window.location.origin;
    const dataUrl = `${origin}/api/prices/latest?cardKey=${encodeURIComponent(selectedCard.cardKey)}`;
    const payload = {
      schemaVersion: 1,
      configVersion: Date.now(),
      cardKey: selectedCard.cardKey,
      sourceId: selectedCard.sourceId,
      dataUrl,
      templateId,
      renderProgram: program,
      refresh: true,
    };
    const res = await fetchWithTimeout(`http://${selectedDeviceIp}/api/render-program`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(payload),
    }, 90000, '设备正在刷新墨水屏，90 秒内没有返回。请看一下屏幕是否已完成刷新；如果屏幕已更新，可以继续使用。');
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    setMessage(`已更新 ${selectedDeviceIp}：版式、卡牌和屏幕显示已同步`);
  }

  return (
    <main className="shell">
      <section className="hero">
        <div>
          <span className="badge">LAN Bridge WebUI</span>
          <h1>Pokémon Display Manager</h1>
          <p className="muted">公网服务器只负责搜索和排版；浏览器自动搜索同局域网 ESP32，并把最终显示规则直接下发给设备。</p>
        </div>
        <button className="primaryAction" onClick={() => updateDevice().catch((e) => setMessage(`更新失败：${e.message}`))}>更新设备显示</button>
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
              {lanDevices.map((d) => <button key={d.ip} onClick={() => setSelectedDeviceIp(d.ip)} className={`deviceChoice ${selectedDeviceIp === d.ip ? 'active' : ''}`}><b>{d.name}</b><span>{d.ip}</span></button>)}
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
              {pagedCards.map((c) => <button className={`cardRow ${cardVariantKey(selectedCard) === cardVariantKey(c) ? 'active' : ''}`} key={cardVariantKey(c)} onClick={() => useCard(c)}><b>{c.n}</b><span>{c.s || '--'} · {c.r || '--'} · {c.t || '默认版本'} · Market {c.m == null ? '--' : `$${c.m}`}</span></button>)}
            </div>
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
            <div className="sectionTitle"><h2>{templateId === 'custom' ? '自定义布局编辑器' : `模板：${templateLabels[templateId]}`}</h2><span className="muted">当前卡牌：{previewCard.name}</span></div>
            {templateId === 'custom' ? <ProgramEditor program={program} card={previewCard} onChange={setProgram} /> : <EpaperPreview program={program} card={previewCard} />}
          </div>
          <details className="card">
          <summary>高级：下发给设备的显示规则</summary>
          <pre className="code">{JSON.stringify({ templateId, cardKey: selectedCard?.cardKey, dataUrl: selectedCard?.cardKey ? `/api/prices/latest?cardKey=${selectedCard.cardKey}` : '', renderProgram: program }, null, 2)}</pre>
          </details>
          <div className="message">{message || '流程：搜索设备 → 搜索并选择卡牌 → 选择模板/调整布局 → 更新设备显示。'}</div>
        </section>
      </section>
    </main>
  );
}

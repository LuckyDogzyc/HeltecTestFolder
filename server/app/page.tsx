"use client";

import { useEffect, useMemo, useState } from 'react';
import { renderValue, sampleCard, templateLabels, templatePrograms } from '@/lib/templates';
import type { DeviceRecord, RenderCommand } from '@/lib/types';

type CardSearchRow = { id: number; n: string; s?: string; r?: string; t?: string; m?: number; l?: number; num?: string };

function EpaperPreview({ program, editable, onChange }: { program: RenderCommand[]; editable?: boolean; onChange?: (next: RenderCommand[]) => void }) {
  const [selected, setSelected] = useState(0);
  const scale = editable ? 3 : 1;
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
    <div className={editable ? 'editorWrap' : ''}>
      <div className={editable ? 'epaper big' : 'epaper'} style={editable ? {} : {}}>
        {program.filter((item) => item.visible).map((item, idx) => {
          const originalIndex = program.indexOf(item);
          return (
            <div
              key={`${item.value}-${idx}`}
              onPointerDown={(ev) => beginDrag(originalIndex, ev)}
              onClick={() => setSelected(originalIndex)}
              className={`${editable ? 'dragItem' : 'epaperText'} ${item.color === 1 ? 'red' : 'black'} font${item.font} ${editable && selected === originalIndex ? 'selected' : ''}`}
              style={{ left: item.x * scale, top: item.y * scale - 14, transform: editable ? `scale(${scale})` : undefined, transformOrigin: 'top left' }}
            >
              {renderValue(item.value, sampleCard)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ProgramEditor({ program, onChange }: { program: RenderCommand[]; onChange: (next: RenderCommand[]) => void }) {
  function update(index: number, patch: Partial<RenderCommand>) {
    onChange(program.map((item, i) => i === index ? { ...item, ...patch } : item));
  }
  return (
    <div className="stack">
      <EpaperPreview program={program} editable onChange={onChange} />
      {program.map((item, index) => (
        <div className="fieldPanel" key={index}>
          <label><input type="checkbox" checked={item.visible} onChange={(e) => update(index, { visible: e.target.checked })} /> 显示</label>
          <input value={item.value} onChange={(e) => update(index, { value: e.target.value })} />
          <input type="number" value={item.x} min={0} max={249} onChange={(e) => update(index, { x: Number(e.target.value) })} />
          <input type="number" value={item.y} min={0} max={121} onChange={(e) => update(index, { y: Number(e.target.value) })} />
          <select value={item.font} onChange={(e) => update(index, { font: Number(e.target.value) as 0 | 1 | 2 })}>
            <option value={0}>小号</option><option value={1}>粗体9</option><option value={2}>标题/价格</option>
          </select>
          <select value={item.color} onChange={(e) => update(index, { color: Number(e.target.value) as 0 | 1 })}>
            <option value={0}>黑色</option><option value={1}>红色</option>
          </select>
        </div>
      ))}
    </div>
  );
}

export default function Page() {
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [publicIp, setPublicIp] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [templateId, setTemplateId] = useState('price');
  const [program, setProgram] = useState<RenderCommand[]>(templatePrograms.price);
  const [productId, setProductId] = useState(562018);
  const [q, setQ] = useState('greninja');
  const [cards, setCards] = useState<CardSearchRow[]>([]);
  const [message, setMessage] = useState('');
  const [localIp, setLocalIp] = useState('');
  const [localStatus, setLocalStatus] = useState<any>(null);

  const selected = useMemo(() => devices.find((d) => d.deviceId === selectedId) || devices[0], [devices, selectedId]);

  async function loadDevices() {
    const res = await fetch('/api/devices?currentNetwork=1');
    const data = await res.json();
    setDevices(data.devices || []);
    setPublicIp(data.publicIp || '');
    if (!selectedId && data.devices?.[0]) setSelectedId(data.devices[0].deviceId);
  }

  useEffect(() => { loadDevices(); }, []);
  useEffect(() => {
    if (!selected) return;
    setSelectedId(selected.deviceId);
    setTemplateId(selected.templateId || 'price');
    setProgram(selected.renderProgram || templatePrograms.price);
    setProductId(selected.productId || 562018);
  }, [selected?.deviceId]);

  async function searchCards() {
    const res = await fetch(`/api/cards/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    setCards(data.cards || []);
  }

  function chooseTemplate(id: string) {
    setTemplateId(id);
    setProgram((id === 'custom' ? program : templatePrograms[id]).map((item) => ({ ...item })));
  }

  async function rename(device: DeviceRecord) {
    const displayName = prompt('设备新名称', device.displayName) || device.displayName;
    await fetch(`/api/devices/${device.deviceId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName }) });
    await loadDevices();
  }

  function localBase() {
    return localIp.startsWith('http') ? localIp.replace(/\/$/, '') : `http://${localIp.replace(/\/$/, '')}`;
  }

  async function connectLocalDevice() {
    if (!localIp.trim()) return setMessage('请输入 ESP32 局域网 IP，例如 192.168.31.218');
    const res = await fetch(`${localBase()}/api/status`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    setLocalStatus(data);
    if (data?.card?.productId) setProductId(data.card.productId);
    setMessage(`已直连局域网设备：${data?.server?.deviceId || data?.wifi?.ip || localIp}`);
  }

  async function saveConfig() {
    const payload = { configVersion: Date.now(), productId, templateId, renderProgram: program };
    if (localIp.trim()) {
      const res = await fetch(`${localBase()}/api/render-program`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setLocalStatus(data.status || null);
      setMessage('已通过浏览器局域网直连下发到 ESP32；设备不会定时轮询服务器');
      return;
    }
    if (!selected) return setMessage('没有选择服务器设备；也可以输入 ESP32 局域网 IP 直连下发');
    const res = await fetch(`/api/devices/${selected.deviceId}/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId, templateId, renderProgram: program }),
    });
    const data = await res.json();
    setMessage(data.ok ? `已保存服务器配置 v${data.device.configVersion}；注意新版 ESP32 不会定时 poll，推荐使用局域网直连下发` : `保存失败：${data.error}`);
    await loadDevices();
  }

  async function refreshLocalDevice() {
    if (!localIp.trim()) return setMessage('请先输入 ESP32 局域网 IP');
    const res = await fetch(`${localBase()}/api/refresh`, { method: 'POST' });
    const data = await res.json();
    setLocalStatus(data.status || null);
    setMessage(data.ok ? '已让局域网 ESP32 拉取最新价格并刷新屏幕' : `刷新失败：${data.error || res.status}`);
  }

  async function registerDemo() {
    await fetch('/api/devices', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer demo-device-key' },
      body: JSON.stringify({ deviceId: `esp32-demo-${Math.floor(Math.random()*9000+1000)}`, factoryName: 'PokemonDisplay-DEMO', lanIp: '192.168.31.218', firmware: 'mock-0.1' }),
    });
    await loadDevices();
  }

  return (
    <main className="shell">
      <section className="hero">
        <div><span className="badge">Server WebUI MVP</span><h1>Pokémon Display Manager</h1><p className="muted">公网 WebUI 只提供页面、搜索和排版工具；推荐由浏览器直接把 renderProgram 下发到同局域网 ESP32，设备不定时轮询服务器，只在刷新价格时主动请求数据。</p></div>
        <div className="card"><div className="muted">当前访问公网 IP</div><b>{publicIp || 'loading'}</b></div>
      </section>
      <section className="grid">
        <aside className="stack">
          <div className="card"><h2>局域网直连设备</h2><p className="muted">推荐路径：浏览器从公网服务器加载 WebUI，但保存配置时直接访问 ESP32 的局域网地址。ESP32 不定时访问服务器。</p><div className="row"><input value={localIp} onChange={(e) => setLocalIp(e.target.value)} placeholder="192.168.31.218 或 http://192.168.31.218" /><button onClick={() => connectLocalDevice().catch((e) => setMessage(`直连失败：${e.message}`))}>连接</button><button className="secondary" onClick={() => refreshLocalDevice().catch((e) => setMessage(`刷新失败：${e.message}`))}>让设备拉价格并刷新</button></div>{localStatus && <div className="muted">已连接：{localStatus.wifi?.ip || localIp} · 设备 {localStatus.server?.deviceId || '--'} · 模板 {localStatus.config?.template} · render {localStatus.server?.renderCommandCount || 0}</div>}</div>
          <div className="card"><h2>当前网络设备（服务器记录，可选）</h2><p className="muted">兼容旧路径：只显示主动上报到服务器的设备。新版 ESP32 默认不定时上报，所以主要使用上方局域网直连。</p><div className="stack">
            {devices.map((d) => <div key={d.deviceId} onClick={() => setSelectedId(d.deviceId)} className={`device ${selected?.deviceId === d.deviceId ? 'active' : ''}`}><b>{d.displayName}</b><div className="muted">{d.factoryName}</div><div><span className="pill">LAN {d.lanIp || '--'}</span><span className="pill">v{d.configVersion}</span></div><button className="secondary" onClick={(e) => { e.stopPropagation(); rename(d); }}>改名</button></div>)}
            {!devices.length && <div className="muted">暂无服务器记录。新版 ESP32 默认不定时上报；建议输入局域网 IP 直连。</div>}
            <button className="secondary" onClick={registerDemo}>创建演示设备</button>
          </div></div>
          <div className="card"><h2>卡牌搜索</h2><div className="row"><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Greninja / 132 / productId" /><button onClick={searchCards}>搜索</button></div>{cards.map((c) => <div className="searchResult" key={c.id}><b>{c.n}</b><div className="muted">{c.s} · {c.r} / {c.t}</div><div>ID {c.id} · Market {c.m == null ? '--' : `$${c.m}`}</div><button className="secondary" onClick={() => setProductId(c.id)}>使用这张卡</button></div>)}</div>
        </aside>
        <section className="stack">
          <div className="card"><h2>显示设置：模板预览</h2><div className="previewGrid">{Object.entries(templateLabels).map(([id, label]) => <div key={id} className={`templateCard ${templateId === id ? 'active' : ''}`} onClick={() => chooseTemplate(id)}><b>{label}</b><EpaperPreview program={id === 'custom' ? program : templatePrograms[id]} /></div>)}</div></div>
          <div className="card"><h2>{templateId === 'custom' ? '自定义布局编辑器' : `模板：${templateLabels[templateId]}`}</h2>{templateId === 'custom' ? <ProgramEditor program={program} onChange={setProgram} /> : <EpaperPreview program={program} editable={false} />}<div className="row"><label>Product ID <input type="number" value={productId} onChange={(e) => setProductId(Number(e.target.value))} /></label><button onClick={() => saveConfig().catch((e) => setMessage(`保存失败：${e.message}`))}>{localIp.trim() ? '直连下发到 ESP32' : '保存到服务器记录'}</button></div><p className="muted">选择“自定义布局”时，本区域直接变成拖动编辑器；普通模板只显示渲染预览。</p></div>
          <div className="card"><h2>下发给设备的 renderProgram</h2><pre className="code">{JSON.stringify({ productId, templateId, renderProgram: program }, null, 2)}</pre><div className="muted">{message}</div></div>
        </section>
      </section>
    </main>
  );
}

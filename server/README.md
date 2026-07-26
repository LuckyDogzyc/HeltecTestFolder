# Pokémon Display Server WebUI MVP

公网服务器版管理后台原型，用于把复杂 UI 从 ESP32 固件中迁出。

## 功能

- 当前网络设备列表：按设备上报 public IP 与浏览器 public IP 匹配，显示最近在线设备。
- 设备改名：服务器侧保存 displayName。
- 卡牌搜索：读取仓库 `cards/search_index.min.json`。
- 模板预览：价格优先、收藏展示、行情详情、自定义布局。
- 自定义布局：250×122 模拟墨水屏画布，字段可拖动，4px 网格吸附。
- 设备配置 API：保存 `productId + templateId + renderProgram`，供 ESP32 后续轮询。
- 设备注册 API：支持 Bearer/deviceKey，只有带 key 上报的设备进入设备列表。

## 运行

```bash
cd server
npm install
npm run dev
```

打开：

```text
http://localhost:3200
```

生产构建验证：

```bash
npm run typecheck
npm run build
```

## 关键 API

```http
GET  /api/devices?currentNetwork=1
POST /api/devices
PATCH /api/devices/{deviceId}
GET  /api/devices/{deviceId}/config?version=1
PATCH /api/devices/{deviceId}/config
GET  /api/cards/search?q=greninja
```

设备注册示例：

```bash
curl -X POST http://localhost:3200/api/devices \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer demo-device-key' \
  -d '{"deviceId":"esp32-5628","factoryName":"PokemonDisplay-5628","lanIp":"192.168.31.218","firmware":"0.1.0"}'
```

## 当前说明

当前版本为了快速验证 MVP，设备数据使用 `data/devices.json` 本地持久化，并已加入 `.gitignore`。后续接真实账号/多用户后再迁移到 SQLite。

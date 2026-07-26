# Pokémon Display Server WebUI MVP

公网服务器版管理后台原型，用于把复杂 UI 从 ESP32 固件中迁出。

## 功能

- 局域网直连：浏览器从公网服务器加载 WebUI，但保存配置时直接 POST 到 ESP32 局域网 IP。
- 卡牌搜索：读取仓库 `cards/search_index.min.json`。
- 模板预览：价格优先、收藏展示、行情详情、自定义布局。
- 自定义布局：250×122 模拟墨水屏画布，字段可拖动，4px 网格吸附。
- renderProgram 下发：生成 `productId + templateId + renderProgram`，由浏览器直连 ESP32 的 `/api/render-program`。
- 服务器设备列表/注册 API 仅作为兼容和调试路径；新版 ESP32 默认不定时注册、不定时轮询。

## 运行

```bash
cd server
npm install
npm run dev
```

打开：

```text
http://localhost:2300
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
curl -X POST http://localhost:2300/api/devices \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer demo-device-key' \
  -d '{"deviceId":"esp32-5628","factoryName":"PokemonDisplay-5628","lanIp":"192.168.31.218","firmware":"0.1.0"}'
```

## 当前说明

当前推荐网络路径：

```text
浏览器 -> http://43.162.99.23:2300 加载 WebUI/搜索/模板编辑
浏览器 -> http://ESP32局域网IP/api/render-program 直连下发配置
ESP32 -> GitHub raw bucket 仅在刷新价格时主动请求价格数据
```

服务器不再是 ESP32 的定时轮询目标，`data/devices.json` 只用于演示/调试服务器记录，后续接真实账号/多用户后再迁移到 SQLite。

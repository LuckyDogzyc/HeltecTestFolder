# Pokémon Display 云端管理后台

用于管理 ESP32 墨水屏卡牌价格显示设备的云端 WebUI。

## 当前用户流程

```text
注册 / 登录
→ 使用一次性配对码认领设备
→ 搜索并选择卡牌
→ 免费版选择基础模板；Pro 使用高级自定义布局
→ 保存到云端
→ 设备下次唤醒时自动下载新配置并刷新
```

设备不需要因为用户开通 Pro、修改卡牌或改变布局而重新刷机、OTA 或重新配网。

## 版本权益

| 功能 | 免费版 | Pro |
|---|---|---|
| 账号与设备认领 | 支持 | 支持 |
| 基础卡牌价格模板 | 支持 | 支持 |
| 云端保存与设备下次唤醒同步 | 支持 | 支持 |
| 高级自定义布局 | 不支持 | 支持 |
| 图片素材能力 | 预留 | 后续开放 |

## 设备协议

ESP32 使用 `deviceId + Authorization: Bearer <deviceKey>` 注册和拉取配置：

```text
POST /api/devices
GET  /api/devices/{deviceId}/config?version=N
```

配置未变化时，服务端返回 HTTP `304`；配置或用户权益发生变化时递增 `configVersion`。用户成为 Pro 后，其名下设备会在下次正常唤醒时自动取得新的云端配置。

浏览器从不持有设备密钥。设备详情、配置保存和设备列表均要求登录并校验归属。

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

## 验证

```bash
npm test
npm run typecheck
npm run build
```

## 当前不在范围内

- 真实支付接入；
- 图片文件上传和素材管理；
- 浏览器扫描局域网 IP、直连 ESP32 下发配置。

这些旧 LAN Bridge 路径已从用户 WebUI 移除；现在仅以云端配置和设备低频唤醒同步为准。

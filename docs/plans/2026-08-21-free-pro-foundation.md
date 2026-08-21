# 免费版 / Pro 版账号权益基础 Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** 将 Pokémon Display Server 从演示型 `devices.json` 升级为 SQLite 驱动的账号、设备归属与免费/Pro 权益基础，且不改变 ESP32 配置拉取协议。

**Architecture:** Next.js Route Handlers 使用 SQLite 存储用户、会话、设备、归属、权益和配对码；浏览器使用 HttpOnly 会话 Cookie。设备仍使用自己的 Bearer deviceKey 注册和拉配置。所有用户配置请求先解析会话、验证所有权和权益，再保存最终 frame/configVersion。

**Tech Stack:** Next.js 16、TypeScript、better-sqlite3、Node crypto、node:test。

---

### Task 1: 加入 SQLite 和测试脚本

**Files:** Modify `server/package.json`; create `server/test/*.test.ts`.

1. 增加 `better-sqlite3` 与其类型；增加 `test` 脚本（Node 内建测试执行 TypeScript 编译后的测试或 tsx）。
2. 写一个失败测试：初始化临时数据库后应拥有迁移所需表。
3. 运行测试确认 RED；实现最小 schema 初始化；确认 GREEN。
4. Commit: `chore: add server database test setup`。

### Task 2: 用户、会话和权益存储

**Files:** Create `server/lib/db.ts`, `server/lib/auth.ts`, `server/lib/entitlements.ts`; test `server/test/auth.test.ts`.

1. RED：注册用户会获得默认 `free` 权益；密码以 scrypt hash 保存；错误密码不能建立会话。
2. GREEN：实现唯一 email、scrypt 盐/hash、随机 opaque 会话、过期检查和 `getPlan(userId)`。
3. RED：升级为 Pro 后 `getPlan` 返回 `pro`。
4. GREEN：实现仅服务端可调用的 grant/revoke 权益函数。
5. Commit: `feat: add account sessions and entitlement storage`。

### Task 3: 设备注册、配对和所有权

**Files:** Replace `server/lib/store.ts` persistence; create `server/lib/pairing.ts`; test `server/test/device-ownership.test.ts`.

1. RED：设备首次注册会建立未认领设备和一次性配对码；错误 deviceKey 不能覆盖在线真实设备。
2. GREEN：迁移现有 `data/devices.json` 到 SQLite；保留 deviceId/configVersion/frame/status 字段与现有设备 API 兼容。
3. RED：认领者可读取设备，第二用户读取/保存同设备被拒绝。
4. GREEN：实现配对码哈希、有效期、一次性使用和 owner 查询。
5. Commit: `feat: add device pairing and ownership`。

### Task 4: 认证 Route Handlers 和“我的设备”API

**Files:** Create `server/app/api/auth/register/route.ts`, `login/route.ts`, `logout/route.ts`, `me/route.ts`; create `server/app/api/me/devices/route.ts`; tests for route behavior.

1. RED：未登录请求“我的设备”返回 401；注册后 Cookie 会话可列出空设备列表。
2. GREEN：实现 route、HttpOnly/SameSite cookie、输入校验和所有权过滤。
3. Commit: `feat: expose account auth and owned device APIs`。

### Task 5: 服务端权益门禁

**Files:** Modify `server/app/api/devices/[id]/config/route.ts`; create `server/app/api/me/devices/[id]/config/route.ts`; test `server/test/pro-gating.test.ts`.

1. RED：免费用户提交带图片素材或 `advanced` 模板的保存请求返回 403；Pro 用户可保存。
2. GREEN：定义集中 `requireFeature(plan, feature)`，服务端生成最终 frame，保存成功递增 configVersion。
3. RED：授予 Pro 后用户所属设备的版本号递增，原 ESP32 GET config API 能获取该版本。
4. GREEN：实现版本 bump，保持 `304` 路径。
5. Commit: `feat: gate advanced display configuration by plan`。

### Task 6: WebUI 最小账号和权益状态

**Files:** Modify `server/app/page.tsx`, create login/register page/component, update `server/README.md`.

1. 显示登录态、当前套餐、我的设备；未登录不显示个人设备配置入口。
2. 免费用户显示高级功能锁定提示；Pro 显示高级入口。
3. 运行 `npm run typecheck`、`npm test`、`npm run build`。
4. Commit: `feat: add free and pro account experience`。

### Task 7: 支付接入预留（不实现真实支付）

**Files:** Update `docs/PRD_FREE_PRO.md`, `server/README.md`.

记录支付回调唯一可做的状态变更：验证订单后调用 `grantPro(userId)`，为拥有设备 bump configVersion。不得在 ESP32 固件中新增支付、账号或订阅判断。

## 最终验收命令

```bash
cd /root/HeltecTestFolder/server
npm test
npm run typecheck
npm run build
```

并用 HTTP 验证：注册用户 A/B → A 认领设备 → B 请求设备返回 403 → A 免费保存高级配置返回 403 → 管理授予 A Pro → A 保存成功、设备 `configVersion` 增加、GET config 返回新版本。

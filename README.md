---

# Heltec Wireless Paper（ESP32-S3）宝可梦价格展示 + 左半屏显示图像

本项目在 **Heltec Wireless Paper（ESP32-S3, 2.13" E-Ink）** 上展示宝可梦卡牌价格：
右半屏显示卡牌名称、`marketPrice`（USD）和抓取时间；左半屏显示一张从 GitHub 下载的 **XBM 黑白图**。
设备每次启动：连接 Wi-Fi → NTP 校时 → 下载左半图 → 逐行流式读取 CSV，匹配 `productId` → **全屏刷新** → 深度睡眠 24h。

> 采用流式扫描 CSV，不把整文件读入内存，适合小内存/低功耗场景。

---

## 功能概览

* **CSV 流式匹配**：逐行扫描 `cards/pokemon_cards.csv`，按 `productId`（CSV 第 1 列）匹配目标卡牌。
* **左半屏图像**：从仓库的 `images/Greninja1/Greninja1.xbm` 下载 XBM，缩放至左半区域（约 125×122）。
* **右半屏信息**：显示卡牌名、`marketPrice`（USD）与抓取时间。
* **NTP 校时**：在 HTTPS 之前校时，减少 TLS 问题。
* **每日刷新**：完成展示后深度睡眠 24 小时。
* **镜像支持**：支持通过 `ghfast.top` 访问 GitHub Raw，方便中国大陆网络环境。

---

## 仓库结构

```
HeltecTestFolder/
├─ cards/
│  └─ pokemon_cards.csv                 # 价格 CSV（设备读取）
├─ images/
│  └─ Greninja1/
│     └─ Greninja1.xbm                  # 左半屏 XBM 黑白图（设备读取）
├─ arduino/
│  └─ price_monitor_github_with_xbm_fix3/
│     └─ price_monitor_github_with_xbm_fix3.ino   # 主程序（推荐版本）
├─ scripts/
│  └─ convert_to_xbm.py                 # 将彩色图转为 XBM 的脚本（本地使用）
└─ README.md
```

> 屏幕特性：该 E-Ink 面板仅黑白（不支持灰阶）。旋转后可用像素区域约 **250×122**；本项目的左半区域默认 **125×122**。

---

## CSV 格式

CSV 至少包含如下字段（顺序固定）：

```
productId,setName,productName,rarity,subTypeName,marketPrice,midPrice,lowPrice,highPrice
644279,ME01: Mega Evolution,Mega Evolution Elite Trainer Box [Mega Gardevoir],,Normal,109.38,109.56,109.0,140.0
```

* 程序匹配 **第 1 列 `productId`**（以字符串比较）。
* 屏幕显示的价格来自 **第 6 列 `marketPrice`**，单位 `USD`。

---

## 左半屏图像（XBM）

* 使用仓库内 `scripts/convert_to_xbm.py` 将彩色图转换为 1 位黑白的 XBM，目标尺寸建议 **125×122**（脚本默认会缩放）。
* 转换后将 `.xbm` 放到 `images/Greninja1/Greninja1.xbm`（或按需更换路径与文件名）。
* 如果图像出现全白/全黑或黑白反相，可在 `*.ino` 里调以下开关：

  * `XBM_BIT_LSB_FIRST`（位序：LSB/MSB 在左）
  * `XBM_BLACK_IS_ONE`（位=1 是否代表黑）
  * `INVERT_OUTPUT`（输出整体反相）

---

## 快速开始

### 1) 准备 CSV 与 XBM

* 确保 `cards/pokemon_cards.csv` 已更新并能通过浏览器 Raw 访问。
* 用 `scripts/convert_to_xbm.py` 把图片转为 XBM，放到 `images/Greninja1/Greninja1.xbm`。

  ```bash
  python scripts/convert_to_xbm.py --input path/to/your_image.jpg --outbase images/Greninja1/Greninja1
  ```

  将生成：

  * `images/Greninja1/Greninja1_bw.png`（预览）
  * `images/Greninja1/Greninja1.xbm`（设备下载使用）

### 2) 打开 Arduino 工程并配置

* 用 Arduino IDE 打开：
  `arduino/price_monitor_github_with_xbm_fix3/price_monitor_github_with_xbm_fix3.ino`
* 板卡包：安装 **Heltec ESP32**，选择对应的 **Wireless Paper（ESP32-S3）** 板卡。
* 安装依赖库：`heltec-eink-modules`、`WiFi`、`WiFiClientSecure`、`HTTPClient`（IDE 一般自带后两者）。

在 `*.ino` 顶部按你的环境修改常量（已替换为你的实际仓库路径）：

```cpp
// Wi-Fi 和目标 productId
static const char* WIFI_SSID     = "2604";
static const char* WIFI_PASSWORD = "19980131";
static const char* TARGET_PRODUCT = "562018";

// CSV（使用 ghfast.top 代理的 GitHub Raw）
static const char* CSV_HOST = "ghfast.top";
static const char* CSV_PATH = "/https://raw.githubusercontent.com/LuckyDogzyc/HeltecTestFolder/refs/heads/main/cards/pokemon_cards.csv";

// 左半图（XBM），同样通过 ghfast.top 代理访问
static const char* IMAGE_HOST = "ghfast.top";
static const char* IMAGE_PATH = "/https://raw.githubusercontent.com/LuckyDogzyc/HeltecTestFolder/refs/heads/main/images/Greninja1/Greninja1.xbm";
```

> 也可尝试直连 GitHub Raw：
> `CSV_HOST = "raw.githubusercontent.com"`
> `CSV_PATH = "/LuckyDogzyc/HeltecTestFolder/main/cards/pokemon_cards.csv"`
> `IMAGE_PATH = "/LuckyDogzyc/HeltecTestFolder/main/images/Greninja1/Greninja1.xbm"`
> 若直连不稳定，请继续使用 `ghfast.top` 镜像方式。

### 3) 烧录与运行

* 连上串口监视器（115200），上电或复位。
* 正常日志示例：

  ```
  [BOOT] price_monitor_github_with_xbm_fix3
  [WiFi] ...
  [NTP] synced: 2025-08-17 12:29
  [IMG] begin: https://ghfast.top/https://raw.githubusercontent.com/.../images/Greninja1/Greninja1.xbm
  [IMG] GET code = 200 ()
  [IMG] parsed XBM: 125x122, bytes=1952
  [CSV] try 1 ...
  [HTTP] GET code = 200 ()
  [PARSE] 562018 -> Greninja ex - 132, price=xx.xx
  ```
* 屏幕右半显示文字，左半显示图像。完成后设备进入 **深度睡眠 24 小时**。

---

## 常见问题

* **HTTP code = -1 / connection refused**

  * 先看 `[NTP]` 是否成功（时间不同步可能影响 TLS）。
  * Raw 路径/大小写是否正确；路径中是否包含多余的 `https://`。
  * 直连不通时，维持 `ghfast.top` 镜像方式。

* **左半图纯白/纯黑或反相**

  * 依次尝试调整 `INVERT_OUTPUT`、`XBM_BLACK_IS_ONE`、`XBM_BIT_LSB_FIRST`。
  * 观察串口的 `[IMG] parsed XBM: WxH, bytes=N`，确认字节数合理（`ceil(W/8)*H`）。

* **找不到 productId**

  * 确认 CSV 第一列确为 `productId`，且值与 `TARGET_PRODUCT` 完全一致。
  * CSV 是否带 BOM/引号；代码已做裁剪和去引号处理，仍不行可贴日志排查。

* **只想更新右半内容不刷新左半**

  * 当前驱动不支持局部刷新；绘制会触发全屏刷新。

---

## 许可证

根据你的需求选择（例如 MIT / Apache-2.0）。当前示例代码未附带特定许可证，可自行添加。

---

## 致谢

* Heltec 开源库与硬件
* 开源社区中关于 XBM/ESP32/HTTPS/NTP 的经验与示例

---

### 最后检查清单

* [ ] `WIFI_SSID` / `WIFI_PASSWORD` / `TARGET_PRODUCT` 已改为你的实际值
* [ ] `cards/pokemon_cards.csv` 与 `images/Greninja1/Greninja1.xbm` 可以通过 Raw 链接访问
* [ ] 串口能看到 `[IMG] parsed XBM: ...` 与 `[PARSE] ...`
* [ ] 图像方向/黑白正常；若异常，按“常见问题”调整三个开关

---

/*
  ESP32-WROOM-32E-N16 + QYEG0213RYF661 三色墨水屏
  Pokémon 卡牌价格显示固件 WebUI MVP

  功能：
  - 默认显示 Greninja ex - 132（productId=562018）；
  - 按 productId % 256 下载 GitHub raw 静态分桶 CSV，避免扫描全量数据；
  - 本地 WebUI：状态查看、Wi-Fi 配网反馈、手动刷新、productId 保存、模板切换；
  - 首次/失败配网：启动 AP 热点 PokemonDisplay-XXXX，访问 http://192.168.4.1；
  - 浏览器端从 cards/search_index.min.json 拉取搜索索引并做轻量模糊搜索；
  - 未接锂电池时不再显示 0.28V，改为 USB/--V。

  Arduino IDE 设置：
  - Board: ESP32 Dev Module
  - Flash Size: 16MB
  - PSRAM: Disabled
  - Serial Monitor: 115200 baud

  依赖库：GxEPD2、Adafruit GFX Library
*/

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <Preferences.h>
#include <SPI.h>
#include <FS.h>
#include <SPIFFS.h>
#include <GxEPD2_3C.h>
#include <Fonts/FreeMonoBold9pt7b.h>
#include <Fonts/FreeMonoBold12pt7b.h>

// NTP：用于 {time} 占位符（更新时间），无 NTP 时回退到编译时间/--。
static const char* NTP_SERVER_1 = "pool.ntp.org";
static const char* NTP_SERVER_2 = "time.nist.gov";
static constexpr long NTP_TZ_OFFSET_SEC = 8 * 3600;      // 北京时间 UTC+8
static constexpr int NTP_DST_OFFSET_SEC = 0;

// ===== 出厂默认值；客户后续通过 WebUI/AP 配网覆盖到 NVS =====
const char* DEFAULT_WIFI_SSID = "你的WiFi";
const char* DEFAULT_WIFI_PASS = "你的密码";

// 调试模式：设为 true 后忽略 NVS 里保存的 Wi-Fi，直接使用下面两行。
// 注意：仓库是 public，正式提交不要写真实客户 Wi-Fi 密码。
static constexpr bool DEBUG_USE_CODE_WIFI = false;
const char* DEBUG_WIFI_SSID = "你的调试WiFi";
const char* DEBUG_WIFI_PASS = "你的调试密码";

// 当前是常开/WebUI 调试阶段：即使已保存 Wi-Fi，也始终开启 AP Setup Portal。
// 这样手机总能连 PokemonDisplay-XXXX 做首次配网；家庭 Wi-Fi 下访问 STA IP 进入管理后台。
// 未来接入物理开关/deep sleep 后，可在省电模式关闭此项。
static constexpr bool ALWAYS_START_SETUP_AP = true;

// 深睡眠：每次唤醒完成"心跳+取价+刷屏"后进入 esp_deep_sleep。
// 唤醒周期 sleepMin 存 NVS（默认 60 分钟，0 = 禁用深睡，保持常连调试）。
// 复位键（EN）= 强制回到通电状态，走完整 setup（配网/更新入口）。
static constexpr int DEFAULT_SLEEP_MIN = 60;
static constexpr int MAX_SLEEP_MIN = 24 * 60; // 最多一天

// WebUI 调试阶段默认不开机自动刷新：先保证手机 AP 配网页和管理后台立刻可访问。
// 否则 HTTP/墨水屏刷新会阻塞 loop()，手机连上 AP 后 captive portal 没法响应。
static constexpr bool BOOT_AUTO_REFRESH = false;

static constexpr long DEFAULT_PRODUCT_ID = 562018; // Greninja ex - 132, SV Promo
static constexpr int PRODUCT_BUCKET_COUNT = 256;
static const char* PRODUCT_BUCKET_BASE_URL =
  "https://raw.githubusercontent.com/LuckyDogzyc/HeltecTestFolder/main/cards/product_id_buckets/";
static const char* SEARCH_INDEX_URL =
  "https://raw.githubusercontent.com/LuckyDogzyc/HeltecTestFolder/main/cards/search_index.min.json";

// 公网/远程 Server WebUI 只提供浏览器页面；ESP32 默认不主动轮询服务器。
// 配置下发优先走“浏览器 -> ESP32 局域网直连”。如需调试服务器注册，可通过 /api/server 手动设置。
static const char* DEFAULT_SERVER_BASE_URL = "";
static constexpr uint32_t SERVER_HEARTBEAT_INTERVAL_MS = 30000;

static constexpr int PIN_BAT_ADC = 34;
static constexpr int EPD_BUSY = 25;
static constexpr int EPD_RST  = 26;
static constexpr int EPD_DC   = 27;
static constexpr int EPD_MOSI = 14;
static constexpr int EPD_SCLK = 13;
static constexpr int EPD_CS   = 15;
static constexpr float DIVIDER_RATIO = 2.0f;
static constexpr float MIN_VALID_BATTERY_V = 2.50f;

GxEPD2_3C<GxEPD2_213_Z98c, GxEPD2_213_Z98c::HEIGHT> display(
  GxEPD2_213_Z98c(EPD_CS, EPD_DC, EPD_RST, EPD_BUSY)
);

struct CardPrice {
  bool found = false;
  long productId = 0;
  String cardKey;
  String setName;
  String productName;
  String rarity;
  String subTypeName;
  String marketPrice;
  String midPrice;
  String lowPrice;
  String highPrice;
  uint32_t scannedLines = 0;
  int bucket = -1;
};

struct PowerState {
  float voltage = 0;
  uint32_t raw = 0;
  uint32_t adcMv = 0;
  bool batteryValid = false;
};

static constexpr int LAYOUT_ITEM_COUNT = 8;
struct LayoutItem {
  bool visible;
  uint8_t x;
  uint8_t y;
  uint8_t font;  // 0 small, 1 bold9, 2 bold12
  uint8_t color; // 0 black, 1 red
};

const char* LAYOUT_FIELDS[LAYOUT_ITEM_COUNT] = {"name", "set", "market", "low", "mid", "high", "pid", "power"};
const char* LAYOUT_LABELS[LAYOUT_ITEM_COUNT] = {"Card Name", "Set", "Market", "Low", "Mid", "High", "Product ID", "Power"};
LayoutItem customLayout[LAYOUT_ITEM_COUNT];
const LayoutItem DEFAULT_LAYOUT[LAYOUT_ITEM_COUNT] = {
  {true, 8, 18, 2, 1},   // name
  {true, 8, 42, 0, 0},   // set
  {true, 8, 72, 2, 0},   // market
  {true, 150, 92, 0, 1}, // low
  {false, 8, 102, 0, 0}, // mid
  {false, 92, 102, 0, 0},// high
  {true, 8, 112, 0, 0},  // product id
  {true, 182, 112, 0, 1} // power
};

static constexpr int RENDER_CMD_MAX = 20;
struct RenderCommand {
  bool visible;
  uint8_t x;
  uint8_t y;
  uint8_t font;      // 0 内置6x8, 1 9pt, 2 12pt, 3 18pt, 4 24pt
  uint8_t color;     // 0 black, 1 red
  bool wrap;         // true: 超宽自动换行
  String value; // e.g. "{title}", "${market}", "ID {productId}"
  String valueFrom; // e.g. "price.label" or "card.localizedName"
  String fallback;  // pipe-separated paths, e.g. "card.localizedName|card.name"
};
RenderCommand renderProgram[RENDER_CMD_MAX];
int renderProgramCount = 0;

// ===== 位图帧（Web canvas 渲染的静态层 + 动态槽位）=====
// 静态层：Web 端把非动态元素（标题/装饰/自定义文本，任意字体）渲染成 122×250 双平面 1bpp，
//         black 4000B + red 4000B，存 SPIFFS /frame.bin，固件 drawNative 整帧绘制。
// 动态槽位：价格/时间等实时字段由固件用内置字体叠加绘制（slots JSON 存 NVS）。
static constexpr int FRAME_PLANE_BYTES = 4000;          // 122×250 / 8 每平面
static constexpr int FRAME_SLOT_MAX = 8;
struct FrameSlot {
  bool valid;
  uint8_t x;
  uint8_t y;
  uint8_t font;
  uint8_t color;
  String value;  // 占位符模板，如 "${market}"、"L ${low}"、"HH:MM {time}"
};
FrameSlot frameSlots[FRAME_SLOT_MAX];
int frameSlotCount = 0;
bool hasFrame = false;

Preferences prefs;
WebServer server(80);
DNSServer dnsServer;
CardPrice currentCard;
PowerState powerState;
String lastError;
String lastStage = "boot";
int lastHttpStatus = 0;
String lastHttpError;
uint32_t lastRefreshMs = 0;
bool refreshInProgress = false;
bool apRunning = false;
String apSsid;

long selectedProductId = DEFAULT_PRODUCT_ID;
int selectedTemplate = 0; // 0 price focus, 1 collector, 2 market detail
bool showBattery = true;
int sleepMin = DEFAULT_SLEEP_MIN; // 深睡眠唤醒周期（分钟），0=禁用深睡
String savedSsid;
String savedPass;

String serverBaseUrl;
String deviceId;
String deviceKey;
int serverConfigVersion = 0;
String serverTemplateId;
String selectedCardKey;
String selectedSourceId;
String selectedDataUrl;
uint32_t lastServerHeartbeatMs = 0;
String lastServerError;
int lastServerHttpStatus = 0;
String lastDataJson;

static void setStage(const String& stage) {
  lastStage = stage;
  Serial.print("[STAGE] ");
  Serial.println(stage);
}

static String jsonEscape(const String& s) {
  String out;
  out.reserve(s.length() + 8);
  for (uint32_t i = 0; i < s.length(); ++i) {
    char c = s[i];
    if (c == '"') out += "\\\"";
    else if (c == '\\') out += "\\\\";
    else if (c == '\n') out += "\\n";
    else if (c == '\r') out += "";
    else out += c;
  }
  return out;
}

// 轻量 base64 解码（无依赖）。返回解码后字节数，-1 表示输入非法。
static int base64Decode(const String& in, uint8_t* out, int maxOut) {
  static const int8_t T[256] = {
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,62,-1,-1,-1,63,
    52,53,54,55,56,57,58,59,60,61,-1,-1,-1,-1,-1,-1,
    -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9,10,11,12,13,14,
    15,16,17,18,19,20,21,22,23,24,25,-1,-1,-1,-1,-1,
    -1,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,
    41,42,43,44,45,46,47,48,49,50,51,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1
  };
  int len = in.length();
  int o = 0, acc = 0, bits = 0;
  for (int i = 0; i < len && o < maxOut; ++i) {
    char c = in.charAt(i);
    if (c == '=' || c == '\n' || c == '\r' || c == ' ') continue;
    int8_t v = T[(uint8_t)c];
    if (v < 0) return -1;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (uint8_t)((acc >> bits) & 0xFF);
    }
  }
  return o;
}

static void sendJson(int code, const String& body) {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  server.send(code, "application/json; charset=utf-8", body);
}

static void loadConfig() {
  prefs.begin("pdisplay", false);
  selectedProductId = prefs.getLong("productId", DEFAULT_PRODUCT_ID);
  selectedTemplate = prefs.getInt("template", 0);
  showBattery = prefs.getBool("showBat", true);
  savedSsid = prefs.getString("ssid", DEFAULT_WIFI_SSID);
  savedPass = prefs.getString("pass", DEFAULT_WIFI_PASS);
  serverBaseUrl = prefs.getString("srvUrl", DEFAULT_SERVER_BASE_URL);
  deviceId = prefs.getString("devId", "");
  deviceKey = prefs.getString("devKey", "");
  serverConfigVersion = prefs.getInt("srvVer", 0);
  serverTemplateId = prefs.getString("srvTpl", "");
  selectedCardKey = prefs.getString("cardKey", "");
  selectedSourceId = prefs.getString("srcId", "");
  selectedDataUrl = prefs.getString("dataUrl", "");
  loadLayoutConfig();
  loadRenderProgramConfig();
  sleepMin = constrain(prefs.getInt("sleepMin", DEFAULT_SLEEP_MIN), 0, MAX_SLEEP_MIN);
  loadFrameSlots();
  initFrameStorage();
  if (savedSsid == "你的WiFi") savedSsid = "";
  if (DEBUG_USE_CODE_WIFI) {
    savedSsid = DEBUG_WIFI_SSID;
    savedPass = DEBUG_WIFI_PASS;
    Serial.println("DEBUG_USE_CODE_WIFI enabled: using firmware Wi-Fi credentials");
  }
}

static void saveCardConfig() {
  prefs.putLong("productId", selectedProductId);
}

static void saveDisplayConfig() {
  prefs.putInt("template", selectedTemplate);
  prefs.putBool("showBat", showBattery);
  prefs.putInt("sleepMin", sleepMin);
}

static void loadLayoutConfig() {
  for (int i = 0; i < LAYOUT_ITEM_COUNT; ++i) {
    customLayout[i] = DEFAULT_LAYOUT[i];
    customLayout[i].visible = prefs.getBool((String("l") + i + "v").c_str(), DEFAULT_LAYOUT[i].visible);
    customLayout[i].x = (uint8_t)constrain(prefs.getUChar((String("l") + i + "x").c_str(), DEFAULT_LAYOUT[i].x), 0, 249);
    customLayout[i].y = (uint8_t)constrain(prefs.getUChar((String("l") + i + "y").c_str(), DEFAULT_LAYOUT[i].y), 0, 121);
    customLayout[i].font = (uint8_t)constrain(prefs.getUChar((String("l") + i + "f").c_str(), DEFAULT_LAYOUT[i].font), 0, 2);
    customLayout[i].color = (uint8_t)constrain(prefs.getUChar((String("l") + i + "c").c_str(), DEFAULT_LAYOUT[i].color), 0, 1);
  }
}

static void saveLayoutConfig() {
  for (int i = 0; i < LAYOUT_ITEM_COUNT; ++i) {
    prefs.putBool((String("l") + i + "v").c_str(), customLayout[i].visible);
    prefs.putUChar((String("l") + i + "x").c_str(), customLayout[i].x);
    prefs.putUChar((String("l") + i + "y").c_str(), customLayout[i].y);
    prefs.putUChar((String("l") + i + "f").c_str(), customLayout[i].font);
    prefs.putUChar((String("l") + i + "c").c_str(), customLayout[i].color);
  }
}

static void loadRenderProgramConfig() {
  renderProgramCount = constrain(prefs.getInt("rpCount", 0), 0, RENDER_CMD_MAX);
  for (int i = 0; i < renderProgramCount; ++i) {
    renderProgram[i].visible = prefs.getBool((String("rp") + i + "v").c_str(), true);
    renderProgram[i].x = (uint8_t)constrain(prefs.getUChar((String("rp") + i + "x").c_str(), 0), 0, 249);
    renderProgram[i].y = (uint8_t)constrain(prefs.getUChar((String("rp") + i + "y").c_str(), 0), 0, 121);
    renderProgram[i].font = (uint8_t)constrain(prefs.getUChar((String("rp") + i + "f").c_str(), 0), 0, 4);
    renderProgram[i].color = (uint8_t)constrain(prefs.getUChar((String("rp") + i + "c").c_str(), 0), 0, 1);
    renderProgram[i].wrap = prefs.getBool((String("rp") + i + "w").c_str(), false);
    renderProgram[i].value = prefs.getString((String("rp") + i + "t").c_str(), "");
    renderProgram[i].valueFrom = prefs.getString((String("rp") + i + "vf").c_str(), "");
    renderProgram[i].fallback = prefs.getString((String("rp") + i + "fb").c_str(), "");
  }
}

static void saveRenderProgramConfig() {
  prefs.putInt("rpCount", renderProgramCount);
  for (int i = 0; i < renderProgramCount; ++i) {
    prefs.putBool((String("rp") + i + "v").c_str(), renderProgram[i].visible);
    prefs.putUChar((String("rp") + i + "x").c_str(), renderProgram[i].x);
    prefs.putUChar((String("rp") + i + "y").c_str(), renderProgram[i].y);
    prefs.putUChar((String("rp") + i + "f").c_str(), renderProgram[i].font);
    prefs.putUChar((String("rp") + i + "c").c_str(), renderProgram[i].color);
    prefs.putBool((String("rp") + i + "w").c_str(), renderProgram[i].wrap);
    prefs.putString((String("rp") + i + "t").c_str(), renderProgram[i].value.substring(0, 96));
    prefs.putString((String("rp") + i + "vf").c_str(), renderProgram[i].valueFrom.substring(0, 48));
    prefs.putString((String("rp") + i + "fb").c_str(), renderProgram[i].fallback.substring(0, 96));
  }
}

static String macSuffix() {
  uint64_t mac = ESP.getEfuseMac();
  char buf[7];
  snprintf(buf, sizeof(buf), "%06X", (uint32_t)(mac & 0xFFFFFF));
  return String(buf);
}

static String randomHexKey() {
  char buf[25];
  uint32_t a = esp_random();
  uint32_t b = esp_random();
  uint32_t c = esp_random();
  snprintf(buf, sizeof(buf), "%08X%08X%08X", a, b, c);
  return String(buf);
}

static void ensureDeviceIdentity() {
  String preferredId = String("pokemon-display-") + macSuffix();
  if (!deviceId.length() || deviceId.startsWith("esp32-")) {
    deviceId = preferredId;
    prefs.putString("devId", deviceId);
  }
  if (!deviceKey.length()) {
    deviceKey = randomHexKey();
    prefs.putString("devKey", deviceKey);
  }
}

static bool serverSyncConfigured() {
  return serverBaseUrl.startsWith("http://") || serverBaseUrl.startsWith("https://");
}

static PowerState readBatteryVoltage() {
  PowerState ps;
  pinMode(PIN_BAT_ADC, INPUT);
  analogReadResolution(12);
  analogSetPinAttenuation(PIN_BAT_ADC, ADC_11db);
  uint32_t rawSum = 0;
  uint32_t mvSum = 0;
  for (int i = 0; i < 24; ++i) {
    rawSum += analogRead(PIN_BAT_ADC);
    mvSum += analogReadMilliVolts(PIN_BAT_ADC);
    delay(2);
  }
  ps.raw = rawSum / 24;
  ps.adcMv = mvSum / 24;
  ps.voltage = ((float)ps.adcMv / 1000.0f) * DIVIDER_RATIO;
  ps.batteryValid = ps.voltage >= MIN_VALID_BATTERY_V;
  Serial.printf("BAT GPIO34 raw=%lu adc=%lumV vbat=%.3fV valid=%s\n",
                (unsigned long)ps.raw, (unsigned long)ps.adcMv, ps.voltage,
                ps.batteryValid ? "yes" : "no/usb");
  return ps;
}

static bool connectWiFiWithFeedback(const String& ssid, const String& pass, uint32_t timeoutMs) {
  if (!ssid.length()) {
    lastError = "WiFi SSID empty";
    return false;
  }
  setStage("wifi-connect");
  WiFi.mode(apRunning ? WIFI_AP_STA : WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(ssid.c_str(), pass.c_str());
  Serial.printf("Connecting WiFi SSID=%s", ssid.c_str());
  const uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < timeoutMs) {
    Serial.print('.');
    delay(250);
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    lastError = "";
    Serial.printf("WiFi connected in %lums, IP=%s, RSSI=%d dBm\n",
                  (unsigned long)(millis() - start), WiFi.localIP().toString().c_str(), WiFi.RSSI());
    return true;
  }
  lastError = "WiFi connect failed";
  Serial.println(lastError);
  return false;
}

static void startConfigAP() {
  if (apRunning) return;
  uint64_t chipid = ESP.getEfuseMac();
  char suffix[8];
  snprintf(suffix, sizeof(suffix), "%04X", (uint16_t)(chipid & 0xFFFF));
  apSsid = String("PokemonDisplay-") + suffix;
  WiFi.mode(WIFI_AP_STA);
  bool ok = WiFi.softAP(apSsid.c_str(), "12345678");
  apRunning = ok;
  if (ok) dnsServer.start(53, "*", WiFi.softAPIP());
  Serial.printf("Config AP %s: SSID=%s PASS=12345678 IP=%s\n", ok ? "started" : "failed", apSsid.c_str(), WiFi.softAPIP().toString().c_str());
}

static void stopConfigAP() {
  if (!apRunning) return;
  dnsServer.stop();
  WiFi.softAPdisconnect(true);
  apRunning = false;
  apSsid = "";
  Serial.println("Config AP stopped");
}

static bool parseCsvLine(const String& line, String fields[], const int maxFields) {
  int fieldIndex = 0;
  String current;
  bool inQuotes = false;
  for (uint32_t i = 0; i < line.length(); ++i) {
    char c = line[i];
    if (c == '"') {
      if (inQuotes && i + 1 < line.length() && line[i + 1] == '"') {
        current += '"';
        ++i;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c == ',' && !inQuotes) {
      if (fieldIndex < maxFields) fields[fieldIndex] = current;
      ++fieldIndex;
      current = "";
    } else if (c != '\r') {
      current += c;
    }
  }
  if (fieldIndex < maxFields) fields[fieldIndex] = current;
  ++fieldIndex;
  return fieldIndex >= maxFields;
}

static int selectedBucket() {
  long value = selectedProductId % PRODUCT_BUCKET_COUNT;
  if (value < 0) value += PRODUCT_BUCKET_COUNT;
  return (int)value;
}

static String selectedBucketUrl() {
  char filename[16];
  snprintf(filename, sizeof(filename), "%03d.csv", selectedBucket());
  return String(PRODUCT_BUCKET_BASE_URL) + filename;
}

static bool csvLineMatchesSelectedId(const String& line) {
  String prefix = String(selectedProductId) + ",";
  return line.startsWith(prefix);
}

static bool fetchSelectedCardFromBucket(CardPrice& card) {
  card = CardPrice();
  if (WiFi.status() != WL_CONNECTED) {
    lastError = "No WiFi";
    return false;
  }
  setStage("http-bucket-begin");
  WiFiClientSecure client;
  client.setInsecure();
  client.setTimeout(15000);
  HTTPClient http;
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  http.setConnectTimeout(8000);
  http.setTimeout(15000);
  http.useHTTP10(true);

  const int bucket = selectedBucket();
  const String url = selectedBucketUrl();
  Serial.printf("Fetching bucket=%03d for productId=%ld: %s\n", bucket, selectedProductId, url.c_str());
  const uint32_t start = millis();
  if (!http.begin(client, url)) {
    lastError = "HTTP begin failed";
    lastHttpStatus = -1;
    return false;
  }
  http.addHeader("User-Agent", "LuckyDog-ESP32-ProductPriceDisplay/1.2");
  int code = http.GET();
  lastHttpStatus = code;
  lastHttpError = code < 0 ? http.errorToString(code) : "";
  Serial.printf("HTTP status=%d size=%d err=%s freeHeap=%lu\n", code, http.getSize(), lastHttpError.c_str(), (unsigned long)ESP.getFreeHeap());
  if (code < 0) {
    Serial.println("HTTP failed once; retrying after Wi-Fi reconnect...");
    http.end();
    connectWiFiWithFeedback(savedSsid, savedPass, 12000);
    delay(300);
    if (!http.begin(client, url)) {
      lastError = "HTTP begin failed after retry";
      lastHttpStatus = -1;
      return false;
    }
    http.addHeader("User-Agent", "LuckyDog-ESP32-ProductPriceDisplay/1.3");
    code = http.GET();
    lastHttpStatus = code;
    lastHttpError = code < 0 ? http.errorToString(code) : "";
    Serial.printf("HTTP retry status=%d size=%d err=%s freeHeap=%lu\n", code, http.getSize(), lastHttpError.c_str(), (unsigned long)ESP.getFreeHeap());
  }
  if (code != HTTP_CODE_OK) {
    lastError = code < 0 ? String("HTTP ") + code + " " + lastHttpError : String("HTTP ") + code;
    http.end();
    return false;
  }

  setStage("http-bucket-read");
  WiFiClient* stream = http.getStreamPtr();
  bool headerSkipped = false;
  uint32_t lines = 0;
  while (http.connected() || stream->available()) {
    if (!stream->available()) {
      delay(2);
      if (millis() - start > 20000) {
        lastError = "Bucket read timeout";
        http.end();
        return false;
      }
      continue;
    }
    String line = stream->readStringUntil('\n');
    line.trim();
    if (line.length() == 0) continue;
    if (!headerSkipped) {
      headerSkipped = true;
      Serial.println("Bucket CSV header skipped");
      continue;
    }
    ++lines;
    if (lines == 1 || lines == 50 || lines == 100 || lines == 150 || lines == 200) {
      Serial.printf("Bucket scan line=%lu\n", (unsigned long)lines);
    }
    if (!csvLineMatchesSelectedId(line)) continue;

    String f[9];
    if (!parseCsvLine(line, f, 9)) {
      lastError = "CSV parse failed";
      http.end();
      return false;
    }
    card.found = true;
    card.productId = f[0].toInt();
    card.setName = f[1];
    card.productName = f[2];
    card.rarity = f[3];
    card.subTypeName = f[4];
    card.marketPrice = f[5].length() ? f[5] : "--";
    card.midPrice = f[6].length() ? f[6] : "--";
    card.lowPrice = f[7].length() ? f[7] : "--";
    card.highPrice = f[8].length() ? f[8] : "--";
    card.scannedLines = lines;
    card.bucket = bucket;
    lastError = "";
    Serial.printf("Found productId=%ld in bucket=%03d after %lu lines in %lums: %s market=%s\n",
                  card.productId, bucket, (unsigned long)lines, (unsigned long)(millis() - start),
                  card.productName.c_str(), card.marketPrice.c_str());
    http.end();
    return true;
  }

  lastError = "ProductId not in bucket";
  Serial.printf("Not found in bucket=%03d after %lu lines, elapsed=%lums\n", bucket, (unsigned long)lines, (unsigned long)(millis() - start));
  http.end();
  return false;
}

static void drawCenteredText(const String& text, int16_t y, const GFXfont* font, uint16_t color) {
  display.setFont(font);
  display.setTextColor(color);
  int16_t x1, y1;
  uint16_t w, h;
  display.getTextBounds(text, 0, y, &x1, &y1, &w, &h);
  int16_t x = max(0, (display.width() - (int16_t)w) / 2);
  display.setCursor(x, y);
  display.print(text);
}

static String displayTitle(const CardPrice& card) {
  String t = card.productName;
  int dash = t.indexOf(" - ");
  if (dash > 0) t = t.substring(0, dash);
  t.trim();
  t.toUpperCase();
  return t;
}

static String powerLabel() {
  if (!showBattery) return "";
  if (!powerState.batteryValid) return "USB";
  String s = "B ";
  s += String(powerState.voltage, 2);
  s += "V";
  return s;
}

static String priceDisplayValue(const String& raw);
static String prefixedPriceDisplay(const String& prefix, const String& raw);

static void drawTemplatePriceFocus(const CardPrice& card) {
  drawCenteredText(displayTitle(card), 18, &FreeMonoBold12pt7b, GxEPD_RED);
  display.setFont(&FreeMonoBold12pt7b);
  display.setTextColor(GxEPD_BLACK);
  display.setCursor(8, 64);
  display.print(priceDisplayValue(card.marketPrice));
  display.setFont(&FreeMonoBold9pt7b);
  display.setTextColor(GxEPD_BLACK);
  display.setCursor(8, 92);
  display.print(card.rarity.length() ? card.rarity : "Card");
  display.print(" / "); display.print(card.subTypeName.length() ? card.subTypeName : "Price");
  display.setTextColor(GxEPD_RED);
  display.setCursor(150, 92);
  display.print(prefixedPriceDisplay("L ", card.lowPrice));
  String p = powerLabel();
  if (p.length()) { display.setCursor(150, 112); display.print(p); }
}

static void drawTemplateCollector(const CardPrice& card) {
  drawCenteredText(displayTitle(card), 18, &FreeMonoBold12pt7b, GxEPD_RED);
  display.setFont(&FreeMonoBold9pt7b);
  display.setTextColor(GxEPD_BLACK);
  display.setCursor(8, 42);
  if (card.productId == 562018) display.print("SV Promo #132");
  else { display.print("ID "); display.print(card.productId); }
  display.setCursor(8, 61);
  display.print(card.rarity.length() ? card.rarity : "Card");
  display.print(" / "); display.print(card.subTypeName.length() ? card.subTypeName : "Price");
  display.setFont(&FreeMonoBold12pt7b);
  display.setTextColor(GxEPD_BLACK);
  display.setCursor(8, 90);
  display.print(priceDisplayValue(card.marketPrice));
  display.setFont(&FreeMonoBold9pt7b);
  display.setTextColor(GxEPD_RED);
  display.setCursor(140, 85);
  display.print(prefixedPriceDisplay("L ", card.lowPrice));
  String p = powerLabel();
  if (p.length()) { display.setCursor(140, 105); display.print(p); }
}

static void drawTemplateMarketDetail(const CardPrice& card) {
  drawCenteredText(displayTitle(card), 18, &FreeMonoBold12pt7b, GxEPD_RED);
  display.setFont(&FreeMonoBold9pt7b);
  display.setTextColor(GxEPD_BLACK);
  display.setCursor(8, 42); display.print(prefixedPriceDisplay("M ", card.marketPrice));
  display.setCursor(8, 62); display.print(prefixedPriceDisplay("Low ", card.lowPrice));
  display.setCursor(8, 82); display.print(prefixedPriceDisplay("Mid ", card.midPrice));
  display.setCursor(8, 102); display.print(prefixedPriceDisplay("High ", card.highPrice));
  String p = powerLabel();
  if (p.length()) { display.setTextColor(GxEPD_RED); display.setCursor(160, 102); display.print(p); }
}

static const GFXfont* layoutFont(uint8_t font) {
  // WebUI 下发的 renderProgram 统一使用 FreeMonoBold 字族，避免预览字体和设备字体宽度差异过大。
  // 档位：0/1=9pt, 2=12pt；更大字号由 Web 端 canvas 位图通道提供（固件不再内置大字体）。
  if (font == 2) return &FreeMonoBold12pt7b;
  return &FreeMonoBold9pt7b;
}

static uint8_t layoutFontSize(uint8_t font) {
  // 返回字体像素高度近似值，用于换行行高与预览对齐。
  if (font == 2) return 15;
  return 12; // 9pt
}

static String currentTimeLabel() {
  // 返回 "HH:MM"（北京时间）；NTP 未同步时返回 "--:--"
  struct tm t;
  if (!getLocalTime(&t, 1000)) return "--:--";
  char buf[8];
  snprintf(buf, sizeof(buf), "%02d:%02d", t.tm_hour, t.tm_min);
  return String(buf);
}

static uint16_t layoutColor(uint8_t color) {
  return color == 1 ? GxEPD_RED : GxEPD_BLACK;
}

static String layoutValue(int index, const CardPrice& card) {
  if (index == 0) return displayTitle(card);
  if (index == 1) { String v = card.setName; if (v.length() > 28) v = v.substring(0, 28); return v; }
  if (index == 2) return priceDisplayValue(card.marketPrice);
  if (index == 3) return prefixedPriceDisplay("L ", card.lowPrice);
  if (index == 4) return prefixedPriceDisplay("M ", card.midPrice);
  if (index == 5) return prefixedPriceDisplay("H ", card.highPrice);
  if (index == 6) return String("ID ") + card.productId;
  if (index == 7) {
    if (!powerState.batteryValid) return "USB";
    return String("B ") + String(powerState.voltage, 2) + "V";
  }
  return "";
}


static String renderFieldValue(const CardPrice& card, const String& key) {
  if (key == "title") return displayTitle(card);
  if (key == "name") return card.productName;
  if (key == "set") { String v = card.setName; if (v.length() > 28) v = v.substring(0, 28); return v; }
  if (key == "rarity") return card.rarity;
  if (key == "subType") return card.subTypeName;
  if (key == "productId") return String(card.productId);
  if (key == "market") return card.marketPrice;
  if (key == "low") return card.lowPrice;
  if (key == "mid") return card.midPrice;
  if (key == "high") return card.highPrice;
  if (key == "power") {
    if (!powerState.batteryValid) return "USB";
    return String("B ") + String(powerState.voltage, 2) + "V";
  }
  return "";
}

static String compactDisplayText(String value) {
  value.replace("Double Rare", "Dbl Rare");
  value.replace("Ultra Rare", "Ultra");
  value.replace("Illustration Rare", "Illus Rare");
  value.replace("Special Illustration Rare", "SIR");
  value.replace("Hyper Rare", "Hyper");
  value.replace("Holofoil", "Holo");
  value.replace("Reverse Holofoil", "Rev Holo");
  value.replace(" / ", "/");
  return value;
}

static uint8_t approxCharWidth(uint8_t font) {
  if (font == 2) return 14; // 12pt
  return 11; // 9pt
}

static String fitTextToSlot(String value, uint8_t font, uint8_t x) {
  value = compactDisplayText(value);
  uint8_t cw = approxCharWidth(font);
  int maxChars = (250 - x) / cw;
  if (maxChars < 4) maxChars = 4;
  if ((int)value.length() > maxChars) value = value.substring(0, maxChars);
  return value;
}

static String priceDisplayValue(const String& raw) {
  String v = raw;
  v.trim();
  if (!v.length() || v == "--") return "--";
  if (v.startsWith("$")) return v;
  return String("$") + v;
}

static String prefixedPriceDisplay(const String& prefix, const String& raw) {
  String price = priceDisplayValue(raw);
  if (price == "--") return prefix + "--";
  return prefix + price;
}

static String applyRenderPlaceholders(String value, const CardPrice& card) {
  const char* keys[] = {"title", "name", "set", "rarity", "subType", "productId", "market", "low", "mid", "high", "power"};
  for (uint8_t i = 0; i < sizeof(keys) / sizeof(keys[0]); ++i) {
    String k = keys[i];
    String v = renderFieldValue(card, k);
    value.replace(String("{") + k + "}", v);
    value.replace(String("${") + k + "}", priceDisplayValue(v));
  }
  value.replace("{time}", currentTimeLabel());
  return value;
}

static String jsonValueAtPath(const String& json, const String& path);
static String firstJsonPathValue(const String& json, const String& paths);

static void drawRenderProgram(const CardPrice& card) {
  for (int i = 0; i < renderProgramCount; ++i) {
    const RenderCommand& item = renderProgram[i];
    if (!item.visible) continue;
    String value;
    if (item.valueFrom.length() && lastDataJson.length()) value = jsonValueAtPath(lastDataJson, item.valueFrom);
    if (!value.length() && item.fallback.length() && lastDataJson.length()) value = firstJsonPathValue(lastDataJson, item.fallback);
    if (!value.length()) value = item.value;
    if (!value.length()) continue;
    value = applyRenderPlaceholders(value, card);
    if (!value.length()) continue;

    if (item.wrap) {
      // 换行模式：按字符宽度切行，逐行绘制（x 固定，y 按行高递增）。
      uint8_t lineH = layoutFontSize(item.font);
      uint8_t x = item.x, y = item.y;
      const GFXfont* f = layoutFont(item.font);
      display.setFont(f);
      display.setTextColor(layoutColor(item.color));
      while (value.length()) {
        display.setCursor(x, y);
        String line = fitTextToSlot(value, item.font, x);
        if (!line.length()) break;
        display.print(line);
        value = value.substring(line.length());
        y += lineH;
        if (y > 250) break; // 屏幕高度保护
      }
    } else {
      value = fitTextToSlot(value, item.font, item.x);
      if (!value.length()) continue;
      display.setFont(layoutFont(item.font));
      display.setTextColor(layoutColor(item.color));
      display.setCursor(item.x, item.y);
      display.print(value);
    }
  }
}

static void drawCustomLayout(const CardPrice& card) {
  for (int i = 0; i < LAYOUT_ITEM_COUNT; ++i) {
    const LayoutItem& item = customLayout[i];
    if (!item.visible) continue;
    String value = layoutValue(i, card);
    if (!value.length()) continue;
    display.setFont(layoutFont(item.font));
    display.setTextColor(layoutColor(item.color));
    display.setCursor(item.x, item.y);
    display.print(value);
  }
}

static void drawScreen(const CardPrice& card) {
  setStage("epd-init");
  SPI.begin(EPD_SCLK, -1, EPD_MOSI, EPD_CS);
  display.init(115200, true, 2, false);
  display.setRotation(1);
  display.setFullWindow();
  setStage("epd-refresh-start");
  display.firstPage();
  do {
    display.fillScreen(GxEPD_WHITE);
    if (card.found) {
      if (selectedTemplate == 1) drawTemplateCollector(card);
      else if (selectedTemplate == 2) drawTemplateMarketDetail(card);
      else if (selectedTemplate == 3) drawCustomLayout(card);
      else if (selectedTemplate == 4 && renderProgramCount > 0) drawRenderProgram(card);
      else if (selectedTemplate == 5 && hasFrame) drawFrameWithSlots(card);
      else drawTemplatePriceFocus(card);
    } else {
      drawCenteredText("NO DATA", 35, &FreeMonoBold12pt7b, GxEPD_RED);
      display.setFont(&FreeMonoBold9pt7b);
      display.setTextColor(GxEPD_BLACK);
      display.setCursor(8, 65); display.print(lastError.substring(0, 28));
      display.setCursor(8, 95); display.print("ID "); display.print(selectedProductId);
      String p = powerLabel();
      if (p.length()) { display.print(" "); display.print(p); }
    }
  } while (display.nextPage());
  display.hibernate();
  setStage("epd-done");
}


static String serverUrl(const String& path) {
  String base = serverBaseUrl;
  while (base.endsWith("/")) base.remove(base.length() - 1);
  return base + path;
}

static String jsonStringField(const String& json, const String& key, int from = 0) {
  String needle = String("\"") + key + "\":\"";
  int p = json.indexOf(needle, from);
  if (p < 0) return "";
  p += needle.length();
  String out;
  bool esc = false;
  for (int i = p; i < (int)json.length(); ++i) {
    char c = json[i];
    if (esc) {
      if (c == 'n') out += '\n';
      else out += c;
      esc = false;
    } else if (c == '\\') esc = true;
    else if (c == '"') break;
    else out += c;
  }
  return out;
}

static int jsonIntField(const String& json, const String& key, int def, int from = 0) {
  String needle = String("\"") + key + "\":";
  int p = json.indexOf(needle, from);
  if (p < 0) return def;
  p += needle.length();
  while (p < (int)json.length() && json[p] == ' ') ++p;
  int e = p;
  while (e < (int)json.length() && (isDigit(json[e]) || json[e] == '-')) ++e;
  if (e <= p) return def;
  return json.substring(p, e).toInt();
}

static bool jsonBoolField(const String& json, const String& key, bool def, int from = 0) {
  String needle = String("\"") + key + "\":";
  int p = json.indexOf(needle, from);
  if (p < 0) return def;
  p += needle.length();
  if (json.substring(p, p + 4) == "true") return true;
  if (json.substring(p, p + 5) == "false") return false;
  return def;
}

static int jsonClosingIndex(const String& json, int start, char openCh, char closeCh);

static String jsonValueAtPath(const String& json, const String& path) {
  int start = 0;
  int dot = -1;
  String current = json;
  String remaining = path;
  while (true) {
    dot = remaining.indexOf('.');
    String key = dot >= 0 ? remaining.substring(0, dot) : remaining;
    if (!key.length()) return "";
    String quoted = jsonStringField(current, key);
    if (dot < 0) {
      if (quoted.length()) return quoted;
      String needle = String("\"") + key + "\":";
      int p = current.indexOf(needle);
      if (p < 0) return "";
      p += needle.length();
      while (p < (int)current.length() && current[p] == ' ') ++p;
      int e = p;
      while (e < (int)current.length() && current[e] != ',' && current[e] != '}' && current[e] != ']') ++e;
      String raw = current.substring(p, e);
      raw.trim();
      if (raw == "null") return "";
      return raw;
    }
    String needle = String("\"") + key + "\":";
    int p = current.indexOf(needle);
    if (p < 0) return "";
    p += needle.length();
    while (p < (int)current.length() && current[p] == ' ') ++p;
    if (p >= (int)current.length() || current[p] != '{') return "";
    int close = jsonClosingIndex(current, p, '{', '}');
    if (close < 0) return "";
    current = current.substring(p, close + 1);
    remaining = remaining.substring(dot + 1);
  }
}

static String firstJsonPathValue(const String& json, const String& paths) {
  int start = 0;
  while (start < (int)paths.length()) {
    int sep = paths.indexOf('|', start);
    String path = sep >= 0 ? paths.substring(start, sep) : paths.substring(start);
    path.trim();
    String value = jsonValueAtPath(json, path);
    if (value.length()) return value;
    if (sep < 0) break;
    start = sep + 1;
  }
  return "";
}

static int jsonClosingIndex(const String& json, int start, char openCh, char closeCh) {
  if (start < 0 || start >= (int)json.length() || json[start] != openCh) return -1;
  bool inString = false;
  bool esc = false;
  int depth = 0;
  for (int i = start; i < (int)json.length(); ++i) {
    char c = json[i];
    if (esc) { esc = false; continue; }
    if (inString) {
      if (c == '\\') esc = true;
      else if (c == '"') inString = false;
      continue;
    }
    if (c == '"') { inString = true; continue; }
    if (c == openCh) ++depth;
    else if (c == closeCh) {
      --depth;
      if (depth == 0) return i;
    }
  }
  return -1;
}

static bool applyServerConfigJson(const String& body) {
  int newVersion = jsonIntField(body, "configVersion", serverConfigVersion);
  long newProductId = jsonIntField(body, "productId", selectedProductId);
  String newCardKey = jsonStringField(body, "cardKey");
  String newSourceId = jsonStringField(body, "sourceId");
  String newDataUrl = jsonStringField(body, "dataUrl");
  String newTemplateId = jsonStringField(body, "templateId");
  int rp = body.indexOf("\"renderProgram\"");
  if (rp < 0) { lastServerError = "No renderProgram"; return false; }
  int arrStart = body.indexOf('[', rp);
  int arrEnd = jsonClosingIndex(body, arrStart, '[', ']');
  if (arrStart < 0 || arrEnd < 0) { lastServerError = "Bad renderProgram"; return false; }
  int count = 0;
  int pos = arrStart;
  while (count < RENDER_CMD_MAX) {
    int os = body.indexOf('{', pos);
    if (os < 0 || os > arrEnd) break;
    int oe = jsonClosingIndex(body, os, '{', '}');
    if (oe < 0 || oe > arrEnd) break;
    String obj = body.substring(os, oe + 1);
    String type = jsonStringField(obj, "type");
    String value = jsonStringField(obj, "value");
    String valueFrom = jsonStringField(obj, "valueFrom");
    String fallback = jsonStringField(obj, "fallback");
    if (type == "text" && (value.length() || valueFrom.length())) {
      renderProgram[count].visible = jsonBoolField(obj, "visible", true);
      renderProgram[count].x = (uint8_t)constrain(jsonIntField(obj, "x", 0), 0, 249);
      renderProgram[count].y = (uint8_t)constrain(jsonIntField(obj, "y", 0), 0, 121);
      renderProgram[count].font = (uint8_t)constrain(jsonIntField(obj, "font", 0), 0, 4);
      renderProgram[count].color = (uint8_t)constrain(jsonIntField(obj, "color", 0), 0, 1);
      renderProgram[count].wrap = jsonBoolField(obj, "wrap", false);
      renderProgram[count].value = value.substring(0, 96);
      renderProgram[count].valueFrom = valueFrom.substring(0, 48);
      renderProgram[count].fallback = fallback.substring(0, 96);
      ++count;
    }
    pos = oe + 1;
  }
  if (count <= 0) { lastServerError = "No text commands"; return false; }
  renderProgramCount = count;
  selectedProductId = newProductId;
  selectedCardKey = newCardKey;
  selectedSourceId = newSourceId;
  selectedDataUrl = newDataUrl;
  selectedTemplate = 4;
  serverConfigVersion = newVersion;
  serverTemplateId = newTemplateId.length() ? newTemplateId : "server";
  prefs.putLong("productId", selectedProductId);
  prefs.putString("cardKey", selectedCardKey);
  prefs.putString("srcId", selectedSourceId);
  prefs.putString("dataUrl", selectedDataUrl);
  prefs.putInt("template", selectedTemplate);
  prefs.putInt("srvVer", serverConfigVersion);
  prefs.putString("srvTpl", serverTemplateId);
  saveRenderProgramConfig();
  lastServerError = "";
  Serial.printf("Applied server config v%d cardKey=%s dataUrl=%s commands=%d template=%s\n", serverConfigVersion, selectedCardKey.c_str(), selectedDataUrl.c_str(), renderProgramCount, serverTemplateId.c_str());
  return true;
}

static bool httpBeginAny(HTTPClient& http, WiFiClient& client, WiFiClientSecure& secureClient, const String& url) {
  if (url.startsWith("https://")) {
    secureClient.setInsecure();
    secureClient.setTimeout(12000);
    return http.begin(secureClient, url);
  }
  return http.begin(client, url);
}

static bool serverRegisterOrHeartbeat() {
  if (!serverSyncConfigured() || WiFi.status() != WL_CONNECTED) return false;
  ensureDeviceIdentity();
  HTTPClient http;
  WiFiClient client;
  WiFiClientSecure secureClient;
  String url = serverUrl("/api/devices");
  if (!httpBeginAny(http, client, secureClient, url)) { lastServerError = "server begin failed"; return false; }
  http.setTimeout(12000);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", String("Bearer ") + deviceKey);
  String payload = "{";
  payload += "\"deviceId\":\"" + jsonEscape(deviceId) + "\",";
  payload += "\"factoryName\":\"PokemonDisplay-" + macSuffix() + "\",";
  payload += "\"lanIp\":\"" + WiFi.localIP().toString() + "\",";
  payload += "\"firmware\":\"product-price-display-0.2\",";
  payload += "\"status\":{";
  payload += "\"stage\":\"" + jsonEscape(lastStage) + "\",";
  payload += "\"productId\":" + String(selectedProductId) + ",";
  payload += "\"configVersion\":" + String(serverConfigVersion) + ",";
  payload += "\"sleepMin\":" + String(sleepMin) + "}}";
  int code = http.POST(payload);
  lastServerHttpStatus = code;
  if (code < 200 || code >= 300) lastServerError = String("register HTTP ") + code;
  else lastServerError = "";
  http.end();
  lastServerHeartbeatMs = millis();
  Serial.printf("Server heartbeat status=%d url=%s\n", code, url.c_str());
  return code >= 200 && code < 300;
}

static bool pollServerConfig() {
  if (!serverSyncConfigured() || WiFi.status() != WL_CONNECTED) return false;
  ensureDeviceIdentity();
  HTTPClient http;
  WiFiClient client;
  WiFiClientSecure secureClient;
  String url = serverUrl(String("/api/devices/") + deviceId + "/config?version=" + serverConfigVersion);
  if (!httpBeginAny(http, client, secureClient, url)) { lastServerError = "config begin failed"; return false; }
  http.setTimeout(12000);
  http.addHeader("Authorization", String("Bearer ") + deviceKey);
  int code = http.GET();
  lastServerHttpStatus = code;
  if (code == 304) {
    lastServerError = "";
    http.end();
    Serial.println("Server config unchanged (304)");
    return false;
  }
  if (code != 200) {
    lastServerError = String("config HTTP ") + code;
    http.end();
    Serial.printf("Server config failed status=%d\n", code);
    return false;
  }
  String body = http.getString();
  http.end();
  return applyServerConfigJson(body);
}

static bool fetchSelectedCardFromDataUrl(CardPrice& card) {
  card = CardPrice();
  if (!selectedDataUrl.startsWith("http://") && !selectedDataUrl.startsWith("https://")) return false;
  if (WiFi.status() != WL_CONNECTED) {
    lastError = "No WiFi";
    return false;
  }
  setStage("http-dataurl-begin");
  HTTPClient http;
  WiFiClient client;
  WiFiClientSecure secureClient;
  if (!httpBeginAny(http, client, secureClient, selectedDataUrl)) {
    lastError = "DataUrl begin failed";
    lastHttpStatus = -1;
    return false;
  }
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  http.setConnectTimeout(8000);
  http.setTimeout(15000);
  http.addHeader("User-Agent", "LuckyDog-ESP32-ProductPriceDisplay/2.0");
  int code = http.GET();
  lastHttpStatus = code;
  lastHttpError = code < 0 ? http.errorToString(code) : "";
  if (code != HTTP_CODE_OK) {
    lastError = code < 0 ? String("HTTP ") + code + " " + lastHttpError : String("HTTP ") + code;
    http.end();
    return false;
  }
  lastDataJson = http.getString();
  http.end();
  if (jsonValueAtPath(lastDataJson, "status") != "ok") {
    lastError = "Data status not ok";
    return false;
  }
  card.found = true;
  card.productId = selectedProductId;
  card.cardKey = jsonValueAtPath(lastDataJson, "card.cardKey");
  if (!card.cardKey.length()) card.cardKey = selectedCardKey;
  card.productName = firstJsonPathValue(lastDataJson, "card.localizedName|card.name");
  card.setName = jsonValueAtPath(lastDataJson, "card.setName");
  card.rarity = jsonValueAtPath(lastDataJson, "card.rarity");
  card.subTypeName = jsonValueAtPath(lastDataJson, "card.variant");
  card.marketPrice = jsonValueAtPath(lastDataJson, "price.amount");
  card.lowPrice = jsonValueAtPath(lastDataJson, "price.low");
  card.midPrice = "--";
  card.highPrice = "--";
  String label = jsonValueAtPath(lastDataJson, "price.label");
  if (label.startsWith("$")) label.remove(0, 1);
  if (label.length()) card.marketPrice = label;
  if (!card.marketPrice.length()) card.marketPrice = "--";
  if (!card.lowPrice.length()) card.lowPrice = "--";
  lastError = "";
  Serial.printf("Fetched dataUrl cardKey=%s name=%s price=%s\n", card.cardKey.c_str(), card.productName.c_str(), card.marketPrice.c_str());
  return true;
}

static bool refreshCardAndScreen(bool drawEvenIfFail) {
  if (refreshInProgress) {
    lastError = "Refresh already running";
    return false;
  }
  refreshInProgress = true;
  const uint32_t start = millis();
  setStage("refresh-start");
  powerState = readBatteryVoltage();
  bool ok = false;
  if (WiFi.status() != WL_CONNECTED && savedSsid.length()) {
    connectWiFiWithFeedback(savedSsid, savedPass, 15000);
  }
  if (WiFi.status() == WL_CONNECTED) {
    if (selectedDataUrl.length()) {
      ok = fetchSelectedCardFromDataUrl(currentCard);
    } else {
      ok = fetchSelectedCardFromBucket(currentCard);
    }
  } else {
    lastError = "No WiFi";
  }
  if (ok || drawEvenIfFail) drawScreen(currentCard);
  lastRefreshMs = millis();
  Serial.printf("Refresh %s in %lums\n", ok ? "OK" : "FAILED", (unsigned long)(millis() - start));
  setStage(ok ? "refresh-ok" : "refresh-failed");
  refreshInProgress = false;
  return ok;
}

// ===== 深睡眠 =====
// 唤醒流程：RTC 定时唤醒 -> setup() 重跑 -> 连 WiFi -> 心跳 -> 取价刷屏 -> 再次深睡。
// 复位键（EN）触发完整重启 = 回到通电状态，是"强制唤醒 + 重新配置"入口。
static bool canDeepSleep() {
  return sleepMin > 0 && !apRunning && WiFi.status() == WL_CONNECTED && !refreshInProgress;
}

static void enterDeepSleep() {
  if (!canDeepSleep()) return;
  Serial.printf("Entering deep sleep for %d min\n", sleepMin);
  // 先发心跳，让云端 lastSeen 保持新鲜（WebUI 显示"在线/沉睡"判断依据）
  serverRegisterOrHeartbeat();
  Serial.flush();
  esp_sleep_enable_timer_wakeup((uint64_t)sleepMin * 60ULL * 1000000ULL);
  esp_deep_sleep_start();
  // 不返回
}

static void initFrameStorage() {
  if (!SPIFFS.begin(true)) Serial.println("SPIFFS mount failed");
  hasFrame = SPIFFS.exists("/frame.bin");
  Serial.printf("Frame storage: hasFrame=%d\n", hasFrame ? 1 : 0);
}

// 保存位图帧 + 槽位（槽位同时写 NVS 持久化）
static bool saveFrame(const uint8_t* black, const uint8_t* red, const String& slotsJson) {
  if (!SPIFFS.begin(true)) { lastError = "SPIFFS mount failed"; return false; }
  File f = SPIFFS.open("/frame.bin", "w");
  if (!f) { lastError = "frame open failed"; return false; }
  f.write(black, FRAME_PLANE_BYTES);
  f.write(red, FRAME_PLANE_BYTES);
  f.close();
  // 解析槽位 JSON: [{"x":8,"y":64,"font":2,"color":0,"value":"${market}"},...]
  // 用 from 偏移顺序扫描（value 可能含 {time} 花括号，不能用 {} 配对拆分）
  frameSlotCount = 0;
  int pos = 0;
  while (frameSlotCount < FRAME_SLOT_MAX) {
    int kx = slotsJson.indexOf("\"x\":", pos);
    if (kx < 0) break;
    FrameSlot& s = frameSlots[frameSlotCount];
    s.valid = true;
    s.x = (uint8_t)constrain(jsonIntField(slotsJson, "x", 0, kx), 0, 249);
    s.y = (uint8_t)constrain(jsonIntField(slotsJson, "y", 0, kx), 0, 121);
    s.font = (uint8_t)constrain(jsonIntField(slotsJson, "font", 0, kx), 0, 2);
    s.color = (uint8_t)constrain(jsonIntField(slotsJson, "color", 0, kx), 0, 1);
    s.value = jsonStringField(slotsJson, "value", kx);
    ++frameSlotCount;
    pos = kx + 8; // 推进到下一个槽位
  }
  prefs.putInt("frameSlots", frameSlotCount);
  for (int i = 0; i < frameSlotCount; ++i) {
    String kx = String("fs") + i + "x";
    String ky = String("fs") + i + "y";
    String kf = String("fs") + i + "f";
    String kc = String("fs") + i + "c";
    String kv = String("fs") + i + "v";
    prefs.putUChar(kx.c_str(), frameSlots[i].x);
    prefs.putUChar(ky.c_str(), frameSlots[i].y);
    prefs.putUChar(kf.c_str(), frameSlots[i].font);
    prefs.putUChar(kc.c_str(), frameSlots[i].color);
    prefs.putString(kv.c_str(), frameSlots[i].value.substring(0, 48));
  }
  hasFrame = true;
  lastError = "";
  Serial.printf("Frame saved: slots=%d\n", frameSlotCount);
  return true;
}

static void loadFrameSlots() {
  frameSlotCount = constrain(prefs.getInt("frameSlots", 0), 0, FRAME_SLOT_MAX);
  for (int i = 0; i < frameSlotCount; ++i) {
    FrameSlot& s = frameSlots[i];
    s.valid = true;
    String kx = String("fs") + i + "x";
    String ky = String("fs") + i + "y";
    String kf = String("fs") + i + "f";
    String kc = String("fs") + i + "c";
    String kv = String("fs") + i + "v";
    s.x = (uint8_t)constrain(prefs.getUChar(kx.c_str(), 0), 0, 249);
    s.y = (uint8_t)constrain(prefs.getUChar(ky.c_str(), 0), 0, 121);
    s.font = (uint8_t)constrain(prefs.getUChar(kf.c_str(), 0), 0, 2);
    s.color = (uint8_t)constrain(prefs.getUChar(kc.c_str(), 0), 0, 1);
    frameSlots[i].value = prefs.getString(kv.c_str(), "");
  }
}

// 位图 + 动态槽位渲染（selectedTemplate == 5）
static void drawFrameWithSlots(const CardPrice& card) {
  if (!hasFrame) return;
  File f = SPIFFS.open("/frame.bin", "r");
  if (!f) return;
  uint8_t* black = (uint8_t*)malloc(FRAME_PLANE_BYTES);
  uint8_t* red = (uint8_t*)malloc(FRAME_PLANE_BYTES);
  if (!black || !red) { free(black); free(red); f.close(); return; }
  f.read(black, FRAME_PLANE_BYTES);
  f.read(red, FRAME_PLANE_BYTES);
  f.close();
  // 整帧绘制（0x24=black, 0x26=red，数据为 1bpp 行 16 字节）
  display.drawNative(black, red, 0, 0, GxEPD2_213_Z98c::WIDTH_VISIBLE, GxEPD2_213_Z98c::HEIGHT, false, false, false);
  // 叠加动态槽位
  for (int i = 0; i < frameSlotCount; ++i) {
    const FrameSlot& s = frameSlots[i];
    if (!s.valid || !s.value.length()) continue;
    String v = applyRenderPlaceholders(s.value, card);
    v = fitTextToSlot(v, s.font, s.x);
    if (!v.length()) continue;
    display.setFont(layoutFont(s.font));
    display.setTextColor(layoutColor(s.color));
    display.setCursor(s.x, s.y);
    display.print(v);
  }
  free(black);
  free(red);
}

// 前向声明：这些工具函数定义在本文件后半部分，但位图通道/API 处理在前面引用
static String jsonStringField(const String& json, const String& key, int from);
static int jsonIntField(const String& json, const String& key, int def, int from);
static String applyRenderPlaceholders(String value, const CardPrice& card);
static String fitTextToSlot(String value, uint8_t font, uint8_t x);
static uint16_t layoutColor(uint8_t color);
static const GFXfont* layoutFont(uint8_t font);


static String statusJson() {
  String body = "{";
  body += "\"wifi\":{";
  body += "\"connected\":" + String(WiFi.status() == WL_CONNECTED ? "true" : "false") + ",";
  body += "\"ssid\":\"" + jsonEscape(WiFi.SSID()) + "\",";
  body += "\"ip\":\"" + (WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString() : String("")) + "\",";
  body += "\"rssi\":" + String(WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0) + ",";
  body += "\"apRunning\":" + String(apRunning ? "true" : "false") + ",";
  body += "\"apSsid\":\"" + jsonEscape(apSsid) + "\",";
  body += "\"apIp\":\"" + WiFi.softAPIP().toString() + "\"},";
  body += "\"power\":{";
  body += "\"source\":\"" + String(powerState.batteryValid ? "battery" : "usb") + "\",";
  body += "\"batteryValid\":" + String(powerState.batteryValid ? "true" : "false") + ",";
  body += "\"voltage\":" + String(powerState.voltage, 3) + ",";
  body += "\"raw\":" + String(powerState.raw) + "},";
  body += "\"card\":{";
  body += "\"found\":" + String(currentCard.found ? "true" : "false") + ",";
  body += "\"productId\":" + String(selectedProductId) + ",";
  body += "\"name\":\"" + jsonEscape(currentCard.productName) + "\",";
  body += "\"setName\":\"" + jsonEscape(currentCard.setName) + "\",";
  body += "\"rarity\":\"" + jsonEscape(currentCard.rarity) + "\",";
  body += "\"subTypeName\":\"" + jsonEscape(currentCard.subTypeName) + "\",";
  body += "\"marketPrice\":\"" + jsonEscape(currentCard.marketPrice) + "\",";
  body += "\"lowPrice\":\"" + jsonEscape(currentCard.lowPrice) + "\",";
  body += "\"midPrice\":\"" + jsonEscape(currentCard.midPrice) + "\",";
  body += "\"highPrice\":\"" + jsonEscape(currentCard.highPrice) + "\"},";
  body += "\"feed\":{";
  body += "\"bucket\":" + String(selectedBucket()) + ",";
  body += "\"bucketUrl\":\"" + jsonEscape(selectedBucketUrl()) + "\",";
  body += "\"searchIndexUrl\":\"" + jsonEscape(SEARCH_INDEX_URL) + "\",";
  body += "\"httpStatus\":" + String(lastHttpStatus) + ",";
  body += "\"scannedLines\":" + String(currentCard.scannedLines) + ",";
  body += "\"lastError\":\"" + jsonEscape(lastError) + "\",";
  body += "\"httpError\":\"" + jsonEscape(lastHttpError) + "\",";
  body += "\"stage\":\"" + jsonEscape(lastStage) + "\"},";
  body += "\"display\":{";
  body += "\"model\":\"QYEG0213RYF661\",";
  body += "\"width\":" + String(GxEPD2_213_Z98c::WIDTH_VISIBLE) + ",";
  body += "\"height\":" + String(GxEPD2_213_Z98c::HEIGHT) + ",";
  body += "\"colors\":3,";
  body += "\"rotation\":" + String(display.getRotation()) + "},";
  body += "\"config\":{";
  body += "\"template\":" + String(selectedTemplate) + ",";
  body += "\"showBattery\":" + String(showBattery ? "true" : "false") + ",";
  body += "\"sleepMin\":" + String(sleepMin) + ",";
  body += "\"refreshInProgress\":" + String(refreshInProgress ? "true" : "false") + ",";
  body += "\"debugWifi\":" + String(DEBUG_USE_CODE_WIFI ? "true" : "false") + "},";
  body += "\"server\":{";
  body += "\"configured\":" + String(serverSyncConfigured() ? "true" : "false") + ",";
  body += "\"baseUrl\":\"" + jsonEscape(serverBaseUrl) + "\",";
  body += "\"deviceId\":\"" + jsonEscape(deviceId) + "\",";
  body += "\"configVersion\":" + String(serverConfigVersion) + ",";
  body += "\"templateId\":\"" + jsonEscape(serverTemplateId) + "\",";
  body += "\"renderCommandCount\":" + String(renderProgramCount) + ",";
  body += "\"httpStatus\":" + String(lastServerHttpStatus) + ",";
  body += "\"lastError\":\"" + jsonEscape(lastServerError) + "\"},";
  body += "\"layout\":{";
  body += "\"items\":[";
  for (int i = 0; i < LAYOUT_ITEM_COUNT; ++i) {
    if (i) body += ",";
    body += "{\"i\":" + String(i) + ",\"field\":\"" + LAYOUT_FIELDS[i] + "\",\"label\":\"" + LAYOUT_LABELS[i] + "\",";
    body += "\"v\":" + String(customLayout[i].visible ? "true" : "false") + ",\"x\":" + String(customLayout[i].x) + ",\"y\":" + String(customLayout[i].y) + ",";
    body += "\"f\":" + String(customLayout[i].font) + ",\"c\":" + String(customLayout[i].color) + "}";
  }
  body += "]}";
  body += "}";
  return body;
}

static const char SETUP_HTML[] PROGMEM = R"HTML(
<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pokemon Display Setup</title><style>
body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif;margin:0;background:#f5f5f5;color:#171717}.wrap{max-width:640px;margin:auto;padding:16px}.card{background:white;border-radius:16px;padding:16px;margin:12px 0;box-shadow:0 2px 12px #0001}h1{font-size:24px}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}input,select,button{font-size:16px;padding:10px;border-radius:10px;border:1px solid #ddd}input,select{flex:1;min-width:180px}button{background:#111;color:white;border:0}.secondary{background:#eee;color:#111}.muted{color:#666;font-size:14px}.ok{color:#087f23}.bad{color:#b00020}.step{font-weight:700}</style></head><body><div class="wrap"><h1>Pokémon Display Setup</h1><div class="card"><div class="step">第一步：连接家庭 Wi-Fi</div><p class="muted">当前页面只负责配网。设备热点 PokemonDisplay-XXXX 不提供互联网；配网成功后，请手机切回家庭 Wi-Fi，再打开设备地址进入完整管理后台。</p><div class="row"><select id="ssidSelect"><option value="">扫描后选择 Wi-Fi</option></select><button class="secondary" onclick="scanWifi()">扫描 Wi-Fi</button></div><div class="row"><input id="ssid" placeholder="手动输入 SSID / 隐藏网络"><input id="pass" type="password" placeholder="Wi-Fi 密码"></div><div class="row"><button onclick="saveWifi()">保存并连接</button></div><div id="result" class="muted"></div></div><div class="card"><div class="step">第二步：进入管理后台</div><div id="next" class="muted">连接成功后这里会显示设备局域网地址。</div></div></div><script>
const $=id=>document.getElementById(id);async function api(p,opt){const r=await fetch(p,opt);const j=await r.json();if(!r.ok)throw new Error(j.error||j.message||r.status);return j;}async function scanWifi(){const out=$('result');out.className='muted';out.textContent='扫描中...';try{const j=await api('/api/wifi/scan');const sel=$('ssidSelect');sel.innerHTML='<option value="">选择扫描到的 Wi-Fi</option>';(j.networks||[]).forEach(n=>{const o=document.createElement('option');o.value=n.ssid;o.textContent=`${n.ssid} (${n.rssi} dBm${n.secure?' 🔒':''})`;sel.appendChild(o);});out.textContent=`扫描完成：${(j.networks||[]).length} 个网络`; }catch(e){out.className='bad';out.textContent='扫描失败：'+e.message;}}$('ssidSelect').onchange=()=>{if($('ssidSelect').value)$('ssid').value=$('ssidSelect').value};async function saveWifi(){const ssid=$('ssid').value||$('ssidSelect').value, pass=$('pass').value;const out=$('result');out.className='muted';out.textContent='连接中，约 5-20 秒...';try{const j=await api('/api/wifi',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:`ssid=${encodeURIComponent(ssid)}&pass=${encodeURIComponent(pass)}`});out.className='ok';out.innerHTML=`连接成功：${j.ip} RSSI ${j.rssi}`;$('next').innerHTML=`请将手机切回家庭 Wi-Fi，然后打开：<br><b>http://${j.ip}</b>`;}catch(e){out.className='bad';out.textContent='连接失败：'+e.message;}}scanWifi();
</script></body></html>
)HTML";

static const char MANAGEMENT_HTML[] PROGMEM = R"HTML(
<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pokemon Display</title><style>
body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif;margin:0;background:#f5f5f5;color:#171717}.wrap{max-width:880px;margin:auto;padding:16px}.card{background:white;border-radius:16px;padding:16px;margin:12px 0;box-shadow:0 2px 12px #0001}h1{font-size:24px}h2{font-size:18px;margin:0 0 12px}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}input,select,button{font-size:16px;padding:10px;border-radius:10px;border:1px solid #ddd}input{flex:1;min-width:180px}button{background:#111;color:white;border:0}button.secondary{background:#eee;color:#111}.danger{background:#b00020}.muted{color:#666;font-size:14px}.ok{color:#087f23}.bad{color:#b00020}.result{border:1px solid #eee;border-radius:12px;padding:10px;margin:8px 0}.price{font-size:28px;font-weight:700}.pill{display:inline-block;background:#eee;border-radius:99px;padding:4px 8px;margin:2px}details summary{cursor:pointer;font-weight:600}pre{white-space:pre-wrap;background:#111;color:#eee;padding:12px;border-radius:12px;max-height:240px;overflow:auto}</style></head><body><div class="wrap">
<h1>Pokémon Price Display</h1><div id="msg" class="muted">Loading...</div>
<div class="card"><h2>当前显示</h2><div id="current"></div><div class="row"><button onclick="refreshScreen()">立即刷新屏幕</button><button class="secondary" onclick="loadStatus()">刷新状态</button></div></div>
<div class="card"><h2>搜索卡牌</h2><div class="muted">浏览器从 GitHub 加载搜索索引，ESP32 只保存选中的 productId。</div><div class="row"><input id="q" placeholder="输入 Greninja / 132 / promo / productId" oninput="searchCards()"><button class="secondary" onclick="loadIndex()">加载索引</button></div><div id="searchInfo" class="muted"></div><div id="results"></div></div>
<div class="card"><h2>手动输入 productId</h2><div class="row"><input id="pid" type="number" placeholder="562018"><button onclick="saveProduct(false)">保存</button><button onclick="saveProduct(true)">保存并刷新</button></div></div>
<div class="card"><h2>显示设置</h2><div class="row"><select id="tpl"><option value="0">价格优先模板</option><option value="1">收藏展示模板</option><option value="2">行情详情模板</option><option value="3">自定义布局</option></select><label><input id="showBat" type="checkbox"> 显示供电/电池</label><button onclick="saveConfig()">保存显示设置</button></div></div>
<div class="card"><details open><summary>自定义布局 MVP（表单版）</summary><p class="muted">先用表单验证排版引擎；模板选择“自定义布局”后生效。坐标范围：x 0-249，y 0-121。</p><div id="layoutEditor"></div><div class="row"><button onclick="saveLayout(false)">保存布局</button><button onclick="saveLayout(true)">保存布局并刷新屏幕</button></div><div id="layoutResult" class="muted"></div></details></div>
<div class="card"><details><summary>高级设置 / Wi-Fi / Debug</summary><p class="muted">Wi-Fi 初次配置在设备热点 Setup Portal 完成。这里仅保留清除 Wi-Fi 和诊断。</p><div class="row"><button class="danger" onclick="clearWifi()">清除 Wi-Fi 设置并进入配网模式</button></div><div id="advancedResult" class="muted"></div><pre id="diag"></pre></details></div>
</div><script>
let statusData=null,indexData=null,cards=[]; const $=id=>document.getElementById(id);function setMsg(t,cls='muted'){const e=$('msg');e.className=cls;e.textContent=t;} async function api(path,opt){const r=await fetch(path,opt);const j=await r.json();if(!r.ok)throw new Error(j.error||j.message||r.status);return j;}async function loadStatus(){try{statusData=await api('/api/status');renderStatus();setMsg('状态已更新','ok');}catch(e){setMsg('状态读取失败：'+e.message,'bad');}}
function renderStatus(){const s=statusData,c=s.card,w=s.wifi,p=s.power,f=s.feed; $('pid').value=c.productId; $('tpl').value=s.config.template; $('showBat').checked=s.config.showBattery; $('current').innerHTML=`<div class="price">${c.found?'$'+c.marketPrice:'NO DATA'}</div><div><b>${c.name||'未找到卡牌'}</b></div><div class="muted">ID ${c.productId} · Bucket ${f.bucket} · HTTP ${f.httpStatus} ${f.httpError||''} · ${f.stage}</div><div><span class="pill">Wi-Fi ${w.connected?'已连接 '+w.ip:'未连接'}</span><span class="pill">RSSI ${w.rssi}</span><span class="pill">${p.source==='battery'?(p.voltage.toFixed(2)+'V'):'USB/未接电池'}</span>${s.config.debugWifi?'<span class="pill">DEBUG Wi-Fi</span>':''}</div><div class="muted">${c.setName||''} ${c.rarity||''} ${c.subTypeName||''}</div><div class="bad">${f.lastError||''}</div>`; $('diag').textContent=JSON.stringify(s,null,2);renderLayoutEditor(s.layout.items||[]);}
async function refreshScreen(){setMsg('刷新中，请等待墨水屏完成刷新...');try{const j=await api('/api/refresh',{method:'POST'});statusData=j.status;renderStatus();setMsg(j.ok?'刷新完成':'刷新失败：'+j.error,j.ok?'ok':'bad');}catch(e){setMsg('刷新失败：'+e.message,'bad');await loadStatus();}}
async function saveProduct(doRefresh){const id=parseInt($('pid').value,10);if(!id)return setMsg('请输入有效 productId','bad');try{await api('/api/card',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'productId='+encodeURIComponent(id)});setMsg('productId 已保存'+(doRefresh?'，开始刷新':''),'ok'); if(doRefresh) await refreshScreen(); else await loadStatus();}catch(e){setMsg('保存失败：'+e.message,'bad');}}
async function saveConfig(){const body=`template=${$('tpl').value}&showBattery=${$('showBat').checked?'1':'0'}`;try{await api('/api/config',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});setMsg('显示设置已保存','ok');await loadStatus();}catch(e){setMsg('保存失败：'+e.message,'bad');}}
function renderLayoutEditor(items){$('layoutEditor').innerHTML=items.map(it=>`<div class="result"><b>${it.label}</b> <span class="muted">${it.field}</span><div class="row"><label><input id="lv${it.i}" type="checkbox" ${it.v?'checked':''}>显示</label><input id="lx${it.i}" type="number" min="0" max="249" value="${it.x}" placeholder="x"><input id="ly${it.i}" type="number" min="0" max="121" value="${it.y}" placeholder="y"><select id="lf${it.i}"><option value="0">小号</option><option value="1">粗体9</option><option value="2">标题12</option></select><select id="lc${it.i}"><option value="0">黑色</option><option value="1">红色</option></select></div></div>`).join('');items.forEach(it=>{const f=$('lf'+it.i),c=$('lc'+it.i);if(f)f.value=it.f;if(c)c.value=it.c;});}
async function saveLayout(doRefresh){const items=(statusData&&statusData.layout&&statusData.layout.items)||[];let body=items.map(it=>`v${it.i}=${$('lv'+it.i).checked?'1':'0'}&x${it.i}=${$('lx'+it.i).value}&y${it.i}=${$('ly'+it.i).value}&f${it.i}=${$('lf'+it.i).value}&c${it.i}=${$('lc'+it.i).value}`).join('&');$('layoutResult').textContent='保存中...';try{await api('/api/layout',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});$('tpl').value='3';$('layoutResult').className='ok';$('layoutResult').textContent='布局已保存，并已自动切换为自定义布局模板';await loadStatus();if(doRefresh)await refreshScreen();}catch(e){$('layoutResult').className='bad';$('layoutResult').textContent='保存失败：'+e.message;}}
async function clearWifi(){if(!confirm('确认清除 Wi-Fi 设置？设备会开启 PokemonDisplay 热点用于重新配网。'))return;try{const j=await api('/api/wifi/clear',{method:'POST'});$('advancedResult').className='ok';$('advancedResult').textContent=j.message+' 请连接 PokemonDisplay 热点并打开 http://192.168.4.1';await loadStatus();}catch(e){$('advancedResult').className='bad';$('advancedResult').textContent=e.message;}}
function norm(s){return (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim();} function lev(a,b,max=2){if(Math.abs(a.length-b.length)>max)return max+1;let prev=[...Array(b.length+1).keys()];for(let i=1;i<=a.length;i++){let cur=[i],best=i;for(let j=1;j<=b.length;j++){let v=Math.min(prev[j]+1,cur[j-1]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1));cur[j]=v;if(v<best)best=v;}if(best>max)return max+1;prev=cur;}return prev[b.length];}
function score(c,q){if(!q)return 0;const nq=norm(q),terms=nq.split(/\s+/).filter(Boolean),hay=c.q||norm(`${c.id} ${c.n} ${c.s} ${c.r} ${c.t} ${c.num}`);if(String(c.id)===nq)return 2000;let sc=0;if(norm(c.n).includes(nq))sc+=1000;if(hay.includes(nq))sc+=700;let all=true;for(const t of terms){if(hay.includes(t))sc+=120;else all=false;}if(all&&terms.length>1)sc+=500;if(c.num&&norm(c.num)===nq)sc+=900;for(const word of hay.split(' ')){for(const t of terms){if(t.length>=4&&lev(t,word,2)<=1)sc+=60;}}return sc;}
async function loadIndex(){if(indexData)return; $('searchInfo').textContent='加载搜索索引中...';try{const url=(statusData&&statusData.feed.searchIndexUrl)||'https://raw.githubusercontent.com/LuckyDogzyc/HeltecTestFolder/main/cards/search_index.min.json';const r=await fetch(url,{cache:'force-cache'});if(!r.ok)throw new Error('HTTP '+r.status);indexData=await r.json();cards=indexData.cards||[];$('searchInfo').textContent=`索引已加载：${cards.length} 张卡`;searchCards();}catch(e){$('searchInfo').textContent='索引加载失败：'+e.message;}}
function searchCards(){const q=$('q').value;if(!cards.length){$('results').innerHTML='<div class="muted">请先加载索引</div>';return;}const res=cards.map(c=>[score(c,q),c]).filter(x=>x[0]>0).sort((a,b)=>b[0]-a[0]).slice(0,20).map(x=>x[1]);$('results').innerHTML=res.map(c=>`<div class="result"><b>${c.n}</b><div class="muted">${c.s}</div><div>${c.r||''} / ${c.t||''} · ID ${c.id} ${c.num?'· #'+c.num:''}</div><div>Market ${c.m==null?'--':'$'+c.m} · Low ${c.l==null?'--':'$'+c.l}</div><button onclick="chooseCard(${c.id},false)">选择</button> <button onclick="chooseCard(${c.id},true)">选择并刷新屏幕</button></div>`).join('')||'<div class="muted">没有结果</div>';}
async function chooseCard(id,rf){$('pid').value=id;await saveProduct(rf);} loadStatus();
</script></body></html>
)HTML";

static bool isApRequest() {
  return apRunning && server.client().localIP() == WiFi.softAPIP();
}

static void handleSetup() {
  server.send_P(200, "text/html; charset=utf-8", SETUP_HTML);
}

static void handleManagement() {
  server.send_P(200, "text/html; charset=utf-8", MANAGEMENT_HTML);
}

static void handleRoot() {
  if (isApRequest() || WiFi.status() != WL_CONNECTED) handleSetup();
  else handleManagement();
}

static void handleCaptivePortal() {
  server.sendHeader("Location", String("http://") + WiFi.softAPIP().toString() + "/", true);
  server.send(302, "text/plain", "");
}

static void setupRoutes() {
  server.on("/", HTTP_GET, handleRoot);
  server.on("/generate_204", HTTP_GET, handleCaptivePortal);
  server.on("/gen_204", HTTP_GET, handleCaptivePortal);
  server.on("/hotspot-detect.html", HTTP_GET, handleSetup);
  server.on("/library/test/success.html", HTTP_GET, handleSetup);
  server.on("/connecttest.txt", HTTP_GET, []() { server.send(200, "text/plain", "Microsoft Connect Test"); });
  server.on("/api/wifi/scan", HTTP_GET, []() {
    int n = WiFi.scanNetworks(false, true);
    String body = "{\"networks\":[";
    int added = 0;
    for (int i = 0; i < n; ++i) {
      String ssid = WiFi.SSID(i);
      if (!ssid.length()) continue;
      if (added++) body += ",";
      body += "{\"ssid\":\"" + jsonEscape(ssid) + "\",\"rssi\":" + String(WiFi.RSSI(i)) + ",\"secure\":" + String(WiFi.encryptionType(i) == WIFI_AUTH_OPEN ? "false" : "true") + "}";
    }
    body += "]}";
    sendJson(200, body);
  });
  server.on("/api/status", HTTP_GET, []() { sendJson(200, statusJson()); });
  server.on("/api/card", HTTP_POST, []() {
    if (!server.hasArg("productId")) { sendJson(400, "{\"error\":\"missing productId\"}"); return; }
    long id = server.arg("productId").toInt();
    if (id <= 0) { sendJson(400, "{\"error\":\"invalid productId\"}"); return; }
    selectedProductId = id;
    saveCardConfig();
    sendJson(200, String("{\"ok\":true,\"productId\":") + selectedProductId + "}");
  });
  server.on("/api/config", HTTP_POST, []() {
    if (server.hasArg("template")) selectedTemplate = constrain(server.arg("template").toInt(), 0, 3);
    if (server.hasArg("showBattery")) showBattery = server.arg("showBattery") == "1" || server.arg("showBattery") == "true";
    if (server.hasArg("sleepMin")) sleepMin = constrain(server.arg("sleepMin").toInt(), 0, MAX_SLEEP_MIN);
    saveDisplayConfig();
    sendJson(200, "{\"ok\":true}");
  });
  server.on("/api/layout", HTTP_GET, []() { sendJson(200, statusJson()); });
  server.on("/api/render-program", HTTP_OPTIONS, []() { sendJson(204, ""); });
  server.on("/api/refresh", HTTP_OPTIONS, []() { sendJson(204, ""); });
  server.on("/api/render-program", HTTP_POST, []() {
    String body = server.arg("plain");
    if (!body.length()) body = server.arg("json");
    if (!body.length()) { sendJson(400, "{\"ok\":false,\"error\":\"empty render program body\"}"); return; }
    bool ok = applyServerConfigJson(body);
    bool refreshNow = ok && jsonBoolField(body, "refresh", false);
    if (refreshNow) ok = refreshCardAndScreen(true);
    String err = refreshNow ? lastError : lastServerError;
    String resp = String("{\"ok\":") + (ok ? "true" : "false") + ",\"refreshed\":" + (refreshNow ? "true" : "false") + ",\"error\":\"" + jsonEscape(err) + "\",\"status\":" + statusJson() + "}";
    sendJson(ok ? 200 : 400, resp);
  });

  // 位图帧通道：Web canvas 渲染的静态层（黑/红双平面 base64）+ 动态槽位 JSON。
  // 固件存 SPIFFS /frame.bin，后续唤醒只拉价格、叠加槽位，不再依赖固件内置大字体。
  server.on("/api/frame", HTTP_POST, []() {
    String body = server.arg("plain");
    if (!body.length()) body = server.arg("json");
    if (!body.length()) { sendJson(400, "{\"ok\":false,\"error\":\"empty frame body\"}"); return; }
    String blackB64 = jsonStringField(body, "blackB64");
    String redB64 = jsonStringField(body, "redB64");
    String slots = jsonStringField(body, "slots");
    if (!blackB64.length() || !redB64.length()) { sendJson(400, "{\"ok\":false,\"error\":\"missing blackB64/redB64\"}"); return; }
    uint8_t* black = (uint8_t*)malloc(FRAME_PLANE_BYTES);
    uint8_t* red = (uint8_t*)malloc(FRAME_PLANE_BYTES);
    if (!black || !red) { free(black); free(red); sendJson(500, "{\"ok\":false,\"error\":\"alloc failed\"}"); return; }
    int nb = base64Decode(blackB64, black, FRAME_PLANE_BYTES);
    int nr = base64Decode(redB64, red, FRAME_PLANE_BYTES);
    if (nb != FRAME_PLANE_BYTES || nr != FRAME_PLANE_BYTES) {
      free(black); free(red);
      sendJson(400, String("{\"ok\":false,\"error\":\"bad frame size black=") + nb + " red=" + nr + "\"}");
      return;
    }
    bool ok = saveFrame(black, red, slots);
    free(black); free(red);
    if (ok) {
      selectedTemplate = 5; // 位图模式
      prefs.putInt("template", 5);
      bool refreshNow = jsonBoolField(body, "refresh", false);
      if (refreshNow) ok = refreshCardAndScreen(true);
      String err = refreshNow ? lastError : "";
      sendJson(ok ? 200 : 400, String("{\"ok\":") + (ok ? "true" : "false") + ",\"refreshed\":" + (refreshNow ? "true" : "false") + ",\"error\":\"" + jsonEscape(err) + "\",\"status\":" + statusJson() + "}");
    } else {
      sendJson(400, String("{\"ok\":false,\"error\":\"") + jsonEscape(lastError) + "\"}");
    }
  });
  server.on("/api/server", HTTP_POST, []() {
    serverBaseUrl = server.arg("url");
    serverBaseUrl.trim();
    prefs.putString("srvUrl", serverBaseUrl);
    if (server.arg("resetVersion") == "1") {
      serverConfigVersion = 0;
      prefs.putInt("srvVer", 0);
    }
    bool ok = false;
    if (serverSyncConfigured() && WiFi.status() == WL_CONNECTED) {
      ok = serverRegisterOrHeartbeat();
      pollServerConfig();
    }
    String body = String("{\"ok\":") + (serverSyncConfigured() ? "true" : "false") + ",\"registered\":" + (ok ? "true" : "false") + ",\"status\":" + statusJson() + "}";
    sendJson(200, body);
  });
  server.on("/api/server/poll", HTTP_POST, []() {
    bool heartbeat = serverRegisterOrHeartbeat();
    bool changed = pollServerConfig();
    String body = String("{\"heartbeat\":") + (heartbeat ? "true" : "false") + ",\"changed\":" + (changed ? "true" : "false") + ",\"status\":" + statusJson() + "}";
    sendJson(200, body);
  });
  server.on("/api/layout", HTTP_POST, []() {
    for (int i = 0; i < LAYOUT_ITEM_COUNT; ++i) {
      customLayout[i].visible = server.arg(String("v") + i) == "1" || server.arg(String("v") + i) == "true";
      customLayout[i].x = (uint8_t)constrain(server.arg(String("x") + i).toInt(), 0, 249);
      customLayout[i].y = (uint8_t)constrain(server.arg(String("y") + i).toInt(), 0, 121);
      customLayout[i].font = (uint8_t)constrain(server.arg(String("f") + i).toInt(), 0, 2);
      customLayout[i].color = (uint8_t)constrain(server.arg(String("c") + i).toInt(), 0, 1);
    }
    saveLayoutConfig();
    selectedTemplate = 3;
    saveDisplayConfig();
    sendJson(200, "{\"ok\":true,\"template\":3}");
  });
  server.on("/api/refresh", HTTP_POST, []() {
    bool ok = refreshCardAndScreen(true);
    String body = String("{\"ok\":") + (ok ? "true" : "false") + ",\"error\":\"" + jsonEscape(lastError) + "\",\"status\":" + statusJson() + "}";
    sendJson(ok ? 200 : 500, body);
  });
  server.on("/api/wifi", HTTP_POST, []() {
    String ssid = server.arg("ssid");
    String pass = server.arg("pass");
    if (!ssid.length()) { sendJson(400, "{\"connected\":false,\"error\":\"SSID empty\"}"); return; }
    prefs.putString("ssid", ssid);
    prefs.putString("pass", pass);
    savedSsid = ssid;
    savedPass = pass;
    bool ok = connectWiFiWithFeedback(savedSsid, savedPass, 20000);
    if (!ok) startConfigAP();
    String body = String("{\"connected\":") + (ok ? "true" : "false") + ",\"ip\":\"" + (ok ? WiFi.localIP().toString() : String("")) + "\",\"rssi\":" + (ok ? String(WiFi.RSSI()) : String(0)) + ",\"error\":\"" + jsonEscape(lastError) + "\",\"nextStep\":\"" + (ok ? String("If you are on the AP, switch your phone/computer back to the same home Wi-Fi and open http://") + WiFi.localIP().toString() : String("Stay on AP and correct Wi-Fi")) + "\"}";
    sendJson(ok ? 200 : 500, body);
  });
  server.on("/api/wifi/clear", HTTP_POST, []() {
    prefs.remove("ssid");
    prefs.remove("pass");
    savedSsid = "";
    savedPass = "";
    WiFi.disconnect(true, true);
    startConfigAP();
    sendJson(200, "{\"ok\":true,\"message\":\"Wi-Fi settings cleared. Connect to AP and configure again.\"}");
  });
  server.onNotFound([]() {
    if (server.uri().startsWith("/api/")) sendJson(404, "{\"error\":\"not found\"}");
    else handleRoot(); // captive portal probes and arbitrary paths
  });
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println();
  Serial.println("Product price display WebUI MVP: productId -> GitHub bucket -> e-paper");
  loadConfig();
  ensureDeviceIdentity();
  Serial.printf("Config productId=%ld template=%d showBattery=%s savedSsid=%s alwaysSetupAP=%s server=%s deviceId=%s\n", selectedProductId, selectedTemplate, showBattery ? "true" : "false", savedSsid.c_str(), ALWAYS_START_SETUP_AP ? "true" : "false", serverBaseUrl.c_str(), deviceId.c_str());

  powerState = readBatteryVoltage();
  bool wifiOk = false;
  if (ALWAYS_START_SETUP_AP) startConfigAP();
  if (savedSsid.length()) wifiOk = connectWiFiWithFeedback(savedSsid, savedPass, 20000);
  if (!wifiOk) startConfigAP();
  if (WiFi.status() == WL_CONNECTED) {
    configTime(NTP_TZ_OFFSET_SEC, NTP_DST_OFFSET_SEC, NTP_SERVER_1, NTP_SERVER_2);
    Serial.println("NTP started");
  }

  setupRoutes();
  server.begin();
  Serial.printf("WebUI started. STA IP=%s AP=%s AP IP=%s bootAutoRefresh=%s\n",
                WiFi.localIP().toString().c_str(),
                apRunning ? apSsid.c_str() : "off",
                WiFi.softAPIP().toString().c_str(),
                BOOT_AUTO_REFRESH ? "true" : "false");
  setStage("webui-ready");

  if (BOOT_AUTO_REFRESH) {
    if (WiFi.status() == WL_CONNECTED) refreshCardAndScreen(true);
    else drawScreen(currentCard);
    setStage("webui-ready");
  } else {
    Serial.println("Boot auto refresh disabled; use WebUI button to refresh screen.");
  }

  // 深睡模式：唤醒后自动取价刷屏，完成后立即入睡；AP 配网模式/未连 WiFi 时保持常开。
  if (sleepMin > 0 && !apRunning && WiFi.status() == WL_CONNECTED) {
    if (!BOOT_AUTO_REFRESH) refreshCardAndScreen(true); // 深睡循环必须开机刷新
    enterDeepSleep();
  }
}

void loop() {
  if (apRunning) dnsServer.processNextRequest();
  server.handleClient();
  delay(2);
}

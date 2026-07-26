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
#include <GxEPD2_3C.h>
#include <Fonts/FreeMonoBold9pt7b.h>
#include <Fonts/FreeMonoBold12pt7b.h>
#include <Fonts/FreeSans9pt7b.h>

// ===== 出厂默认值；客户后续通过 WebUI/AP 配网覆盖到 NVS =====
const char* DEFAULT_WIFI_SSID = "你的WiFi";
const char* DEFAULT_WIFI_PASS = "你的密码";

// 调试模式：设为 true 后忽略 NVS 里保存的 Wi-Fi，直接使用下面两行。
// 注意：仓库是 public，正式提交不要写真实客户 Wi-Fi 密码。
static constexpr bool DEBUG_USE_CODE_WIFI = false;
const char* DEBUG_WIFI_SSID = "你的调试WiFi";
const char* DEBUG_WIFI_PASS = "你的调试密码";

static constexpr long DEFAULT_PRODUCT_ID = 562018; // Greninja ex - 132, SV Promo
static constexpr int PRODUCT_BUCKET_COUNT = 256;
static const char* PRODUCT_BUCKET_BASE_URL =
  "https://raw.githubusercontent.com/LuckyDogzyc/HeltecTestFolder/main/cards/product_id_buckets/";
static const char* SEARCH_INDEX_URL =
  "https://raw.githubusercontent.com/LuckyDogzyc/HeltecTestFolder/main/cards/search_index.min.json";

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
String savedSsid;
String savedPass;

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

static void sendJson(int code, const String& body) {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.send(code, "application/json; charset=utf-8", body);
}

static void loadConfig() {
  prefs.begin("pdisplay", false);
  selectedProductId = prefs.getLong("productId", DEFAULT_PRODUCT_ID);
  selectedTemplate = prefs.getInt("template", 0);
  showBattery = prefs.getBool("showBat", true);
  savedSsid = prefs.getString("ssid", DEFAULT_WIFI_SSID);
  savedPass = prefs.getString("pass", DEFAULT_WIFI_PASS);
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
  if (card.productName.indexOf("Greninja") >= 0) return "GRENINJA EX";
  String t = card.productName;
  int dash = t.indexOf(" - ");
  if (dash > 0) t = t.substring(0, dash);
  t.toUpperCase();
  if (t.length() > 18) t = t.substring(0, 18);
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

static void drawTemplatePriceFocus(const CardPrice& card) {
  drawCenteredText(displayTitle(card), 18, &FreeMonoBold12pt7b, GxEPD_RED);
  display.setFont(&FreeMonoBold12pt7b);
  display.setTextColor(GxEPD_BLACK);
  display.setCursor(8, 64);
  display.print("$"); display.print(card.marketPrice);
  display.setFont(&FreeSans9pt7b);
  display.setTextColor(GxEPD_BLACK);
  display.setCursor(8, 92);
  display.print(card.rarity.length() ? card.rarity : "Card");
  display.print(" / "); display.print(card.subTypeName.length() ? card.subTypeName : "Price");
  display.setTextColor(GxEPD_RED);
  display.setCursor(150, 92);
  display.print("L $"); display.print(card.lowPrice);
  String p = powerLabel();
  if (p.length()) { display.setCursor(150, 112); display.print(p); }
}

static void drawTemplateCollector(const CardPrice& card) {
  drawCenteredText(displayTitle(card), 18, &FreeMonoBold12pt7b, GxEPD_RED);
  display.setFont(&FreeSans9pt7b);
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
  display.print("$"); display.print(card.marketPrice);
  display.setFont(&FreeSans9pt7b);
  display.setTextColor(GxEPD_RED);
  display.setCursor(140, 85);
  display.print("L $"); display.print(card.lowPrice);
  String p = powerLabel();
  if (p.length()) { display.setCursor(140, 105); display.print(p); }
}

static void drawTemplateMarketDetail(const CardPrice& card) {
  drawCenteredText(displayTitle(card), 18, &FreeMonoBold12pt7b, GxEPD_RED);
  display.setFont(&FreeSans9pt7b);
  display.setTextColor(GxEPD_BLACK);
  display.setCursor(8, 42); display.print("M $"); display.print(card.marketPrice);
  display.setCursor(8, 62); display.print("Low $"); display.print(card.lowPrice);
  display.setCursor(8, 82); display.print("Mid $"); display.print(card.midPrice);
  display.setCursor(8, 102); display.print("High $"); display.print(card.highPrice);
  String p = powerLabel();
  if (p.length()) { display.setTextColor(GxEPD_RED); display.setCursor(160, 102); display.print(p); }
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
      else drawTemplatePriceFocus(card);
    } else {
      drawCenteredText("NO DATA", 35, &FreeMonoBold12pt7b, GxEPD_RED);
      display.setFont(&FreeSans9pt7b);
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
    ok = fetchSelectedCardFromBucket(currentCard);
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
  body += "\"config\":{";
  body += "\"template\":" + String(selectedTemplate) + ",";
  body += "\"showBattery\":" + String(showBattery ? "true" : "false") + ",";
  body += "\"refreshInProgress\":" + String(refreshInProgress ? "true" : "false") + ",";
  body += "\"debugWifi\":" + String(DEBUG_USE_CODE_WIFI ? "true" : "false") + "}";
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
<div class="card"><h2>显示设置</h2><div class="row"><select id="tpl"><option value="0">价格优先模板</option><option value="1">收藏展示模板</option><option value="2">行情详情模板</option></select><label><input id="showBat" type="checkbox"> 显示供电/电池</label><button onclick="saveConfig()">保存显示设置</button></div></div>
<div class="card"><details><summary>高级设置 / Wi-Fi / Debug</summary><p class="muted">Wi-Fi 初次配置在设备热点 Setup Portal 完成。这里仅保留清除 Wi-Fi 和诊断。</p><div class="row"><button class="danger" onclick="clearWifi()">清除 Wi-Fi 设置并进入配网模式</button></div><div id="advancedResult" class="muted"></div><pre id="diag"></pre></details></div>
</div><script>
let statusData=null,indexData=null,cards=[]; const $=id=>document.getElementById(id);function setMsg(t,cls='muted'){const e=$('msg');e.className=cls;e.textContent=t;} async function api(path,opt){const r=await fetch(path,opt);const j=await r.json();if(!r.ok)throw new Error(j.error||j.message||r.status);return j;}async function loadStatus(){try{statusData=await api('/api/status');renderStatus();setMsg('状态已更新','ok');}catch(e){setMsg('状态读取失败：'+e.message,'bad');}}
function renderStatus(){const s=statusData,c=s.card,w=s.wifi,p=s.power,f=s.feed; $('pid').value=c.productId; $('tpl').value=s.config.template; $('showBat').checked=s.config.showBattery; $('current').innerHTML=`<div class="price">${c.found?'$'+c.marketPrice:'NO DATA'}</div><div><b>${c.name||'未找到卡牌'}</b></div><div class="muted">ID ${c.productId} · Bucket ${f.bucket} · HTTP ${f.httpStatus} ${f.httpError||''} · ${f.stage}</div><div><span class="pill">Wi-Fi ${w.connected?'已连接 '+w.ip:'未连接'}</span><span class="pill">RSSI ${w.rssi}</span><span class="pill">${p.source==='battery'?(p.voltage.toFixed(2)+'V'):'USB/未接电池'}</span>${s.config.debugWifi?'<span class="pill">DEBUG Wi-Fi</span>':''}</div><div class="muted">${c.setName||''} ${c.rarity||''} ${c.subTypeName||''}</div><div class="bad">${f.lastError||''}</div>`; $('diag').textContent=JSON.stringify(s,null,2);}
async function refreshScreen(){setMsg('刷新中，请等待墨水屏完成刷新...');try{const j=await api('/api/refresh',{method:'POST'});statusData=j.status;renderStatus();setMsg(j.ok?'刷新完成':'刷新失败：'+j.error,j.ok?'ok':'bad');}catch(e){setMsg('刷新失败：'+e.message,'bad');await loadStatus();}}
async function saveProduct(doRefresh){const id=parseInt($('pid').value,10);if(!id)return setMsg('请输入有效 productId','bad');try{await api('/api/card',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'productId='+encodeURIComponent(id)});setMsg('productId 已保存'+(doRefresh?'，开始刷新':''),'ok'); if(doRefresh) await refreshScreen(); else await loadStatus();}catch(e){setMsg('保存失败：'+e.message,'bad');}}
async function saveConfig(){const body=`template=${$('tpl').value}&showBattery=${$('showBat').checked?'1':'0'}`;try{await api('/api/config',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});setMsg('显示设置已保存','ok');await loadStatus();}catch(e){setMsg('保存失败：'+e.message,'bad');}}
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
    if (server.hasArg("template")) selectedTemplate = constrain(server.arg("template").toInt(), 0, 2);
    if (server.hasArg("showBattery")) showBattery = server.arg("showBattery") == "1" || server.arg("showBattery") == "true";
    saveDisplayConfig();
    sendJson(200, "{\"ok\":true}");
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
  Serial.printf("Config productId=%ld template=%d showBattery=%s savedSsid=%s\n", selectedProductId, selectedTemplate, showBattery ? "true" : "false", savedSsid.c_str());

  powerState = readBatteryVoltage();
  bool wifiOk = false;
  if (savedSsid.length()) wifiOk = connectWiFiWithFeedback(savedSsid, savedPass, 20000);
  if (!wifiOk) startConfigAP();

  if (WiFi.status() == WL_CONNECTED) refreshCardAndScreen(true);
  else drawScreen(currentCard);

  setupRoutes();
  server.begin();
  Serial.printf("WebUI started. STA IP=%s AP=%s AP IP=%s\n",
                WiFi.localIP().toString().c_str(),
                apRunning ? apSsid.c_str() : "off",
                WiFi.softAPIP().toString().c_str());
  setStage("webui-ready");
}

void loop() {
  if (apRunning) dnsServer.processNextRequest();
  server.handleClient();
  delay(2);
}

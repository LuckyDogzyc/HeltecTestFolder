/*
 * price_monitor_github_with_xbm_fix3.ino
 * Heltec Wireless Paper (ESP32-S3)
 * - 左半：GitHub Raw 下载 XBM，自适应缩放逐像素绘制（黑/白都写）
 * - 右半：显示卡名、marketPrice(USD)、时间
 * - CSV 流式查找 productId；完成后深睡 24h
 */

#include <heltec-eink-modules.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <time.h>

// ================= 用户配置 =================
static const char* WIFI_SSID     = "2604";
static const char* WIFI_PASSWORD = "19980131";
static const char* TARGET_PRODUCT = "562018";

// CSV（经 ghfast.top 代理的 GitHub Raw）
static const char* CSV_HOST = "ghfast.top";
static const char* CSV_PATH = "/https://raw.githubusercontent.com/LuckyDogzyc/HeltecTestFolder/refs/heads/main/cards/pokemon_cards.csv";

// XBM 图像（把 .xbm 放在仓库里，这里写 Raw 路径）
static const char* IMAGE_HOST = "ghfast.top";
static const char* IMAGE_PATH = "/https://raw.githubusercontent.com/LuckyDogzyc/HeltecTestFolder/refs/heads/main/images/Greninja2/Greninja2.xbm";

// ===== XBM/输出 兼容性开关 =====
// Pillow 默认：LSB-first、位=1 为黑
static const bool XBM_BIT_LSB_FIRST = true;  // true: LSB 是最左像素；false: MSB 是最左像素
static const bool XBM_BLACK_IS_ONE  = true;  // true: 位=1 表示黑色；false: 位=0 表示黑色
// 如果成像反黑白（底图颠倒），把它改为 true
static const bool INVERT_OUTPUT     = false; // true: 输出黑白整体反相

// 右半文字布局 & 左半区域大小（旋转 setRotation(3)）
static const int16_t RIGHT_X = 130;
static const int16_t NAME_Y  = 0;
static const int16_t PRICE_Y = 45;
static const int16_t TIME_Y  = 100;

static const int16_t LEFT_W  = 125;
static const int16_t LEFT_H  = 122;

// ================ 全局对象与图像状态 ================
LCMEN2R13EFC1 display;

static bool     gImageLoaded = false;
static uint8_t* gXbmBits     = nullptr;
static uint16_t gXbmW        = 0;
static uint16_t gXbmH        = 0;

// ================ 小工具 ================
static String trimLine(const String& s) {
  int i = 0, j = s.length();
  while (i < j && isspace((unsigned char)s[i])) i++;
  while (j > i && isspace((unsigned char)s[j - 1])) j--;
  return s.substring(i, j);
}
static String stripQuotes(const String& s) {
  String res = s;
  if (res.length() > 0 && res.charAt(0) == 0xFEFF) res = res.substring(1);
  if (res.length() >= 2 && res.charAt(0) == '"' && res.charAt(res.length()-1) == '"')
    res = res.substring(1, res.length()-1);
  return res;
}

// ================ CSV 解析 ================
static bool parseCsvLineForId(const String& line, const char* productId, String& outName, String& outPrice) {
  if (line.length() == 0 || line[0] == '#') return false;
  int c0 = line.indexOf(','); if (c0 < 0) return false;
  String idField = stripQuotes(trimLine(line.substring(0, c0)));
  if (idField != String(productId)) return false;

  int c1 = line.indexOf(',', c0 + 1); if (c1 < 0) return false;
  int c2 = line.indexOf(',', c1 + 1); if (c2 < 0) return false;
  int c3 = line.indexOf(',', c2 + 1); if (c3 < 0) return false;
  int c4 = line.indexOf(',', c3 + 1); if (c4 < 0) return false;
  int c5 = line.indexOf(',', c4 + 1); if (c5 < 0) c5 = line.length();

  outName  = stripQuotes(trimLine(line.substring(c1 + 1, c2)));
  outPrice = stripQuotes(trimLine(line.substring(c4 + 1, c5)));
  return true;
}

static bool fetchPriceStreaming(const char* host, const char* path,
                                int& httpCodeOut, const char* productId,
                                String& outName, String& outPrice) {
  WiFiClientSecure client; client.setInsecure(); client.setTimeout(15000);
  HTTPClient http; http.setTimeout(15000); http.setConnectTimeout(15000);
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  http.useHTTP10(true);
  http.setUserAgent("ESP32S3-Heltec/price-monitor");
  Serial.printf("[HTTP] begin: https://%s%s\n", host, path);
  if (!http.begin(client, host, 443, String(path), true)) {
    httpCodeOut = -1; Serial.println("[HTTP] begin() failed"); return false;
  }
  int code = http.GET(); httpCodeOut = code;
  Serial.printf("[HTTP] GET code = %d (%s)\n", code, HTTPClient::errorToString(code).c_str());
  bool found = false;
  if (code == HTTP_CODE_OK) {
    WiFiClient* s = http.getStreamPtr(); String line;
    while (http.connected() || s->available()) {
      if (!s->available()) { delay(1); continue; }
      char c = s->read();
      if (c == '\r') continue;
      if (c == '\n') {
        String t = trimLine(line);
        if (parseCsvLineForId(t, productId, outName, outPrice)) { found = true; break; }
        line = "";
      } else line += c;
    }
  }
  http.end();
  return found;
}

// ================ XBM 处理 ================
static void clearXbm() {
  if (gXbmBits) { delete[] gXbmBits; gXbmBits = nullptr; }
  gXbmW = gXbmH = 0; gImageLoaded = false;
}
static bool parseDefineInt(const String& text, const char* suffix, int& out) {
  int pos = text.indexOf(suffix);
  if (pos < 0) return false;
  pos += strlen(suffix);
  while (pos < (int)text.length() && !isDigit(text[pos]) && text[pos] != '-') pos++;
  int start = pos;
  while (pos < (int)text.length() && isDigit(text[pos])) pos++;
  if (start == pos) return false;
  out = text.substring(start, pos).toInt();
  return true;
}
static int extractHexBytes(const String& block, uint8_t* out, int maxOut) {
  int count = 0, n = block.length();
  for (int i = 0; i + 3 < n && count < maxOut; ++i) {
    if (block[i] == '0' && (block[i+1] == 'x' || block[i+1] == 'X')) {
      int j = i + 2, val = 0, nd = 0;
      while (j < n) {
        char ch = block[j]; int v = -1;
        if (ch >= '0' && ch <= '9') v = ch - '0';
        else if (ch >= 'a' && ch <= 'f') v = ch - 'a' + 10;
        else if (ch >= 'A' && ch <= 'F') v = ch - 'A' + 10;
        else break;
        val = (val << 4) | v; nd++; j++;
      }
      if (nd > 0) { out[count++] = (uint8_t)(val & 0xFF); i = j - 1; }
    }
  }
  return count;
}

static bool fetchAndParseXbm(const char* host, const char* path) {
  clearXbm();
  WiFiClientSecure client; client.setInsecure(); client.setTimeout(15000);
  HTTPClient http; http.setTimeout(15000); http.setConnectTimeout(15000);
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  http.useHTTP10(true);
  http.setUserAgent("ESP32S3-Heltec/xbm-loader");
  Serial.printf("[IMG] begin: https://%s%s\n", host, path);
  if (!http.begin(client, host, 443, String(path), true)) {
    Serial.println("[IMG] begin() failed"); return false;
  }
  int code = http.GET();
  Serial.printf("[IMG] GET code = %d (%s)\n", code, HTTPClient::errorToString(code).c_str());
  if (code != HTTP_CODE_OK) { http.end(); return false; }

  String txt = http.getString(); http.end();

  int w = 0, h = 0;
  if (!parseDefineInt(txt, "_width",  w) || !parseDefineInt(txt, "_height", h) || w<=0 || h<=0) {
    Serial.println("[IMG] parse width/height failed"); return false;
  }
  int openB = txt.indexOf('{'); int closeB = txt.indexOf('}', openB+1);
  if (openB < 0 || closeB < 0) { Serial.println("[IMG] missing braces"); return false; }
  String hexBlock = txt.substring(openB+1, closeB);

  int stride = (w + 7) / 8;
  int need = stride * h;
  uint8_t* buf = new (std::nothrow) uint8_t[need];
  if (!buf) { Serial.println("[IMG] OOM"); return false; }
  memset(buf, 0x00, need);
  int got = extractHexBytes(hexBlock, buf, need);
  if (got <= 0) { delete[] buf; Serial.println("[IMG] no hex bytes"); return false; }

  gXbmBits = buf; gXbmW = (uint16_t)w; gXbmH = (uint16_t)h; gImageLoaded = true;
  Serial.printf("[IMG] parsed XBM: %dx%d, bytes=%d\n", w, h, got);
  return true;
}

// 取某像素是否“黑”
static inline bool xbmIsBlack(uint16_t x, uint16_t y) {
  if (!gXbmBits || x >= gXbmW || y >= gXbmH) return false;
  int stride = (gXbmW + 7) / 8;
  int idx = y * stride + (x >> 3);
  uint8_t b = gXbmBits[idx];
  int bitIndex = XBM_BIT_LSB_FIRST ? (x & 7) : (7 - (x & 7));
  bool bitVal  = ((b >> bitIndex) & 0x01) != 0;        // 原始位值
  bool isBlack = XBM_BLACK_IS_ONE ? bitVal : !bitVal;  // 位语义到“黑”
  return INVERT_OUTPUT ? !isBlack : isBlack;           // 可选整体反相
}

// 绘制左半（最近邻缩放，黑白都写）
static void drawImageScaledLeft() {
  if (!gImageLoaded) return;
  for (int16_t dy = 0; dy < LEFT_H; ++dy) {
    uint32_t sy = (uint32_t)dy * gXbmH / LEFT_H;
    for (int16_t dx = 0; dx < LEFT_W; ++dx) {
      uint32_t sx = (uint32_t)dx * gXbmW / LEFT_W;
      uint8_t col = xbmIsBlack((uint16_t)sx, (uint16_t)sy) ? 1 : 0; // 1=黑, 0=白
      display.drawPixel(dx, dy, col);
    }
  }
}

// 右半 + 左半合成刷新
static void showPrice(const String& productName, const String& priceWithUnit, const String& timeStamp) {
  display.clear();
  display.setRotation(3);

  // 左半图
  drawImageScaledLeft();

  // 右半文字
  display.setTextSize(2);
  display.setCursor(RIGHT_X, NAME_Y);
  display.println(productName);

  display.setTextSize(3);
  display.setCursor(RIGHT_X, PRICE_Y);
  display.println(priceWithUnit);

  display.setTextSize(1);
  display.setCursor(RIGHT_X, TIME_Y);
  display.println(timeStamp);

  display.update();
}

static void showError(const String& title, const String& message) {
  display.clear();
  display.setRotation(3);
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.println(title);
  display.println(message);
  display.update();
}

// ================= 主流程 =================
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n[BOOT] price_monitor_github_with_xbm_fix3");

  // Wi-Fi
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("[WiFi] connecting");
  for (int i = 0; i < 60 && WiFi.status() != WL_CONNECTED; ++i) { delay(500); Serial.print("."); }
  Serial.println();
  if (WiFi.status() != WL_CONNECTED) { Serial.println("[WiFi] FAILED"); showError("WiFi", "FAILED"); return; }
  Serial.printf("[WiFi] OK, IP: %s\n", WiFi.localIP().toString().c_str());

  // NTP
  configTime(0, 0, "pool.ntp.org", "time.google.com");
  time_t now = 0; int tries = 0;
  while (now < 1700000000 && tries++ < 30) { delay(500); time(&now); }
  if (now >= 1700000000) {
    struct tm tmnow; localtime_r(&now, &tmnow);
    char buf[32];
    snprintf(buf, sizeof(buf), "%04d-%02d-%02d %02d:%02d",
             tmnow.tm_year+1900, tmnow.tm_mon+1, tmnow.tm_mday, tmnow.tm_hour, tmnow.tm_min);
    Serial.printf("[NTP] synced: %s\n", buf);
  } else {
    Serial.println("[NTP] sync failed (continue)");
  }

  // 先下载 XBM（失败不致命）
  fetchAndParseXbm(IMAGE_HOST, IMAGE_PATH);

  // CSV
  int httpCode = -1; String prodName, marketPrice; bool found = false;
  for (int attempt = 1; attempt <= 3; ++attempt) {
    Serial.printf("[CSV] try %d ...\n", attempt);
    found = fetchPriceStreaming(CSV_HOST, CSV_PATH, httpCode, TARGET_PRODUCT, prodName, marketPrice);
    if (httpCode == HTTP_CODE_OK) break;
    delay(800);
  }
  if (httpCode != HTTP_CODE_OK) { Serial.printf("[CSV] fail code=%d\n", httpCode); showError("HTTP ERR", String("code: ")+httpCode); clearXbm(); return; }

  Serial.printf("[PARSE] %s -> %s, price=%s\n", TARGET_PRODUCT,
                found ? prodName.c_str() : "(not found)",
                found ? marketPrice.c_str() : "--");

  if (found) {
    String priceWithUnit = (marketPrice.length() > 0 && marketPrice != "null") ? (marketPrice + " USD") : "N/A";
    time_t t; time(&t); struct tm tmnow; localtime_r(&t, &tmnow);
    char tsbuf[32];
    snprintf(tsbuf, sizeof(tsbuf), "%04d-%02d-%02d %02d:%02d",
             tmnow.tm_year+1900, tmnow.tm_mon+1, tmnow.tm_mday, tmnow.tm_hour, tmnow.tm_min);
    showPrice(prodName, priceWithUnit, String(tsbuf));
  } else {
    showError("Not found", "Card not found");
  }

  clearXbm();

  // 深睡 24h
  const uint64_t oneDayUs = 24ULL * 60ULL * 60ULL * 1000000ULL;
  esp_sleep_enable_timer_wakeup(oneDayUs);
  esp_deep_sleep_start();
}

void loop() {}

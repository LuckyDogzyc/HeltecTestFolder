/*
  ESP32-WROOM-32E-N16 + QYEG0213RYF661 三色墨水屏
  Pokémon 卡牌价格显示固件 MVP

  正确数据口径：
  - GitHub Action 每天只运行一次，生成全量 cards/pokemon_cards.csv 和 cards/epaper_cards.json；
  - 设备持有者后续通过 WebUI 搜索卡牌并保存 productId；
  - ESP32 开机联网读取全量 CSV，按本机保存的 productId 流式查找对应行，找到后立即停止下载；
  - 不为某一张卡生成固定单卡文件，不把价格硬编码到固件里。

  说明：GitHub raw 是静态文件服务，不提供“按 id 查询”的服务端接口。
  所以设备端的“搜索 id”实现为 HTTP 流式读取 CSV：不把 3.8MB 文件放进内存，匹配到 productId 就断开。

  Arduino IDE 设置：
  - Board: ESP32 Dev Module
  - Flash Size: 16MB
  - PSRAM: Disabled
  - Serial Monitor: 115200 baud

  依赖库：
  - GxEPD2
  - Adafruit GFX Library

  硬件引脚：
  - BUSY      -> GPIO25
  - RES/RST   -> GPIO26
  - DC        -> GPIO27
  - SDI/MOSI  -> GPIO14
  - SCLK      -> GPIO13
  - CS        -> GPIO15
  - Battery ADC -> GPIO34, 默认常开分压，DIVIDER_RATIO=2.0
*/

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <SPI.h>
#include <GxEPD2_3C.h>
#include <Fonts/FreeMonoBold9pt7b.h>
#include <Fonts/FreeMonoBold12pt7b.h>
#include <Fonts/FreeSans9pt7b.h>

// ===== 用户/后续 WebUI 只需要改这里 =====
const char* WIFI_SSID = "你的WiFi";
const char* WIFI_PASS = "你的密码";

// 首版默认值。后续 WebUI 搜索卡牌后，把选择结果保存到 NVS，再替换这个运行时值。
static long SELECTED_PRODUCT_ID = 562018; // Greninja ex - 132, SV Promo

// GitHub 仓库里的全量卡牌 CSV；GitHub Action 每天更新一次。
static const char* FULL_CSV_URL =
  "https://raw.githubusercontent.com/LuckyDogzyc/HeltecTestFolder/main/cards/pokemon_cards.csv";

static constexpr int PIN_BAT_ADC = 34;
static constexpr int EPD_BUSY = 25;
static constexpr int EPD_RST  = 26;
static constexpr int EPD_DC   = 27;
static constexpr int EPD_MOSI = 14;
static constexpr int EPD_SCLK = 13;
static constexpr int EPD_CS   = 15;
static constexpr float DIVIDER_RATIO = 2.0f;

// QYEG0213RYF661 需按供应商确认控制器。
// 若显示花屏/无红色，可尝试把 GxEPD2_213_Z98c 改为 GxEPD2_213c 或 GxEPD2_213_Z19c。
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
};

static String lastError;

static float readBatteryVoltage() {
  pinMode(PIN_BAT_ADC, INPUT);
  analogReadResolution(12);
  analogSetPinAttenuation(PIN_BAT_ADC, ADC_11db);

  uint32_t raw_sum = 0;
  uint32_t mv_sum = 0;
  for (int i = 0; i < 24; ++i) {
    raw_sum += analogRead(PIN_BAT_ADC);
    mv_sum += analogReadMilliVolts(PIN_BAT_ADC);
    delay(2);
  }
  const uint32_t raw = raw_sum / 24;
  const float adc_mv = (float)mv_sum / 24.0f;
  const float bat_v = (adc_mv / 1000.0f) * DIVIDER_RATIO;
  Serial.printf("BAT GPIO34 raw=%lu adc=%.0fmV vbat=%.3fV\n", (unsigned long)raw, adc_mv, bat_v);
  return bat_v;
}

static void connectWiFi() {
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  Serial.printf("Connecting WiFi SSID=%s", WIFI_SSID);
  const uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) {
    Serial.print('.');
    delay(250);
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("WiFi connected in %lums, IP=%s, RSSI=%d dBm\n",
                  (unsigned long)(millis() - start),
                  WiFi.localIP().toString().c_str(),
                  WiFi.RSSI());
  } else {
    lastError = "WiFi connect failed";
    Serial.println(lastError);
  }
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

static bool csvLineMatchesSelectedId(const String& line) {
  String prefix = String(SELECTED_PRODUCT_ID) + ",";
  return line.startsWith(prefix);
}

static bool fetchSelectedCardFromFullCsv(CardPrice& card) {
  if (WiFi.status() != WL_CONNECTED) {
    lastError = "No WiFi";
    return false;
  }

  WiFiClientSecure client;
  client.setInsecure(); // GitHub raw HTTPS；量产版可替换为根证书校验。

  HTTPClient http;
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  http.setConnectTimeout(8000);
  http.setTimeout(45000);
  http.useHTTP10(true); // 读取流更稳定，避免 chunked 处理差异。

  Serial.printf("Fetching full CSV and searching productId=%ld\n", SELECTED_PRODUCT_ID);
  const uint32_t start = millis();
  if (!http.begin(client, FULL_CSV_URL)) {
    lastError = "HTTP begin failed";
    return false;
  }
  http.addHeader("User-Agent", "LuckyDog-ESP32-ProductPriceDisplay/1.0");

  const int code = http.GET();
  Serial.printf("HTTP status=%d size=%d\n", code, http.getSize());
  if (code != HTTP_CODE_OK) {
    lastError = String("HTTP ") + code;
    http.end();
    return false;
  }

  WiFiClient* stream = http.getStreamPtr();
  bool headerSkipped = false;
  uint32_t lines = 0;

  while (http.connected() || stream->available()) {
    if (!stream->available()) {
      delay(5);
      if (millis() - start > 60000) {
        lastError = "CSV read timeout";
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
      Serial.printf("CSV header ok\n");
      continue;
    }

    ++lines;
    if (!csvLineMatchesSelectedId(line)) {
      continue;
    }

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

    Serial.printf("Found productId=%ld after %lu lines in %lums: %s market=%s\n",
                  card.productId,
                  (unsigned long)lines,
                  (unsigned long)(millis() - start),
                  card.productName.c_str(),
                  card.marketPrice.c_str());
    http.end();
    return true;
  }

  lastError = "ProductId not found";
  Serial.printf("Not found after %lu lines, elapsed=%lums\n", (unsigned long)lines, (unsigned long)(millis() - start));
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

static void drawScreen(const CardPrice& card, float batV) {
  Serial.println("EPD init/refresh start");
  SPI.begin(EPD_SCLK, -1, EPD_MOSI, EPD_CS);
  display.init(115200, true, 2, false);
  display.setRotation(1); // 横屏：约 250x122
  display.setFullWindow();

  display.firstPage();
  do {
    display.fillScreen(GxEPD_WHITE);

    if (card.found) {
      drawCenteredText(displayTitle(card), 18, &FreeMonoBold12pt7b, GxEPD_RED);

      display.setFont(&FreeSans9pt7b);
      display.setTextColor(GxEPD_BLACK);
      display.setCursor(8, 42);
      if (card.productId == 562018) {
        display.print("SV Promo #132");
      } else {
        display.print("ID ");
        display.print(card.productId);
      }
      display.setCursor(8, 61);
      display.print(card.rarity.length() ? card.rarity : "Card");
      display.print(" / ");
      display.print(card.subTypeName.length() ? card.subTypeName : "Price");

      display.setFont(&FreeMonoBold12pt7b);
      display.setTextColor(GxEPD_BLACK);
      display.setCursor(8, 90);
      display.print("$");
      display.print(card.marketPrice);

      display.setFont(&FreeSans9pt7b);
      display.setTextColor(GxEPD_RED);
      display.setCursor(140, 85);
      display.print("L $");
      display.print(card.lowPrice);
      display.setCursor(140, 105);
      display.print("B ");
      display.print(batV, 2);
      display.print("V");
    } else {
      drawCenteredText("NO DATA", 35, &FreeMonoBold12pt7b, GxEPD_RED);
      display.setFont(&FreeSans9pt7b);
      display.setTextColor(GxEPD_BLACK);
      display.setCursor(8, 65);
      display.print(lastError.substring(0, 28));
      display.setCursor(8, 95);
      display.print("ID ");
      display.print(SELECTED_PRODUCT_ID);
      display.print(" B ");
      display.print(batV, 2);
      display.print("V");
    }
  } while (display.nextPage());

  display.hibernate();
  Serial.println("EPD refresh done; hibernate");
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println();
  Serial.println("Product price display: configured productId -> GitHub full CSV stream search -> e-paper");

  const uint32_t bootStart = millis();
  const float batV = readBatteryVoltage();
  connectWiFi();

  CardPrice card;
  if (WiFi.status() == WL_CONNECTED) {
    fetchSelectedCardFromFullCsv(card);
  }

  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);
  Serial.printf("Network phase done at %lums\n", (unsigned long)(millis() - bootStart));

  drawScreen(card, batV);
  Serial.printf("Setup done at %lums\n", (unsigned long)(millis() - bootStart));
}

void loop() {
  // 首版 MVP 不做自动刷新/深睡眠循环，避免误判耗电和屏幕频繁刷新。
  delay(60000);
}

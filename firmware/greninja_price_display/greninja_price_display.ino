/*
  ESP32-WROOM-32E-N16 + QYEG0213RYF661 三色墨水屏
  Greninja ex 价格显示固件 MVP

  设计口径：
  - GitHub 仓库继续保存全量卡牌 CSV/JSON 数据；
  - GitHub Action 额外生成一个小型直取文件 cards/by_product_id/562018.json；
  - ESP32 开机只下载这个约几百字节的 JSON，不扫描全量 CSV，缩短联网和解析时间；
  - 不把价格硬编码到固件里，价格仍来自 GitHub 数据文件。

  Arduino IDE 设置：
  - Board: ESP32 Dev Module
  - Flash Size: 16MB
  - PSRAM: Disabled
  - Serial Monitor: 115200 baud

  依赖库：
  - GxEPD2
  - Adafruit GFX Library
  - ArduinoJson

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
#include <ArduinoJson.h>
#include <SPI.h>
#include <GxEPD2_3C.h>
#include <Fonts/FreeMonoBold9pt7b.h>
#include <Fonts/FreeMonoBold12pt7b.h>
#include <Fonts/FreeSans9pt7b.h>

// ===== 用户只需要改这里 =====
const char* WIFI_SSID = "你的WiFi";
const char* WIFI_PASS = "你的密码";

// 小型直取 JSON：GitHub 仓库仍保留全量 cards/pokemon_cards.csv 和 cards/epaper_cards.json。
static const char* CARD_JSON_URL =
  "https://raw.githubusercontent.com/LuckyDogzyc/HeltecTestFolder/main/cards/by_product_id/562018.json";

static constexpr long TARGET_PRODUCT_ID = 562018; // Greninja ex - 132, SV Promo

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
  String sourceUpdatedAt;
};

static String lastError;

static String priceToString(JsonVariant value) {
  if (value.isNull()) return "--";
  char buf[16];
  snprintf(buf, sizeof(buf), "%.2f", value.as<float>());
  return String(buf);
}

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

static bool fetchGreninjaDirectJson(CardPrice& card) {
  if (WiFi.status() != WL_CONNECTED) {
    lastError = "No WiFi";
    return false;
  }

  WiFiClientSecure client;
  client.setInsecure(); // GitHub raw HTTPS；量产版可替换为根证书校验。

  HTTPClient http;
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  http.setConnectTimeout(8000);
  http.setTimeout(12000);

  Serial.printf("Fetching card JSON: %s\n", CARD_JSON_URL);
  const uint32_t start = millis();
  if (!http.begin(client, CARD_JSON_URL)) {
    lastError = "HTTP begin failed";
    return false;
  }
  http.addHeader("User-Agent", "LuckyDog-ESP32-Greninja-Epaper/1.1");

  const int code = http.GET();
  const int size = http.getSize();
  Serial.printf("HTTP status=%d size=%d elapsed=%lums\n", code, size, (unsigned long)(millis() - start));
  if (code != HTTP_CODE_OK) {
    lastError = String("HTTP ") + code;
    http.end();
    return false;
  }

  String payload = http.getString();
  http.end();
  Serial.printf("Downloaded %u bytes\n", payload.length());

  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, payload);
  if (err) {
    lastError = String("JSON ") + err.c_str();
    Serial.println(lastError);
    return false;
  }

  if (!doc["found"].as<bool>() || doc["productId"].as<long>() != TARGET_PRODUCT_ID) {
    lastError = "Card not found";
    return false;
  }

  JsonObject c = doc["card"].as<JsonObject>();
  card.found = true;
  card.productId = c["id"].as<long>();
  card.setName = c["set"] | "";
  card.productName = c["name"] | "";
  card.rarity = c["rarity"] | "";
  card.subTypeName = c["type"] | "";
  card.marketPrice = priceToString(c["market"]);
  card.midPrice = priceToString(c["mid"]);
  card.lowPrice = priceToString(c["low"]);
  card.highPrice = priceToString(c["high"]);
  card.sourceUpdatedAt = doc["sourceUpdatedAt"] | "";

  Serial.printf("Card ready: %s market=%s low=%s high=%s\n",
                card.productName.c_str(),
                card.marketPrice.c_str(),
                card.lowPrice.c_str(),
                card.highPrice.c_str());
  return true;
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
      drawCenteredText("GRENINJA EX", 18, &FreeMonoBold12pt7b, GxEPD_RED);

      display.setFont(&FreeSans9pt7b);
      display.setTextColor(GxEPD_BLACK);
      display.setCursor(8, 42);
      display.print("SV Promo #132");
      display.setCursor(8, 61);
      display.print(card.rarity);
      display.print(" / ");
      display.print(card.subTypeName);

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
      display.print("Battery ");
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
  Serial.println("Greninja price display: GitHub tiny product JSON -> e-paper");

  const uint32_t bootStart = millis();
  const float batV = readBatteryVoltage();
  connectWiFi();

  CardPrice card;
  if (WiFi.status() == WL_CONNECTED) {
    fetchGreninjaDirectJson(card);
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

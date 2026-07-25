/*
  ESP32-WROOM-32E-N16 + QYEG0213RYF661 三色墨水屏
  Pokémon Greninja ex 价格显示 MVP

  设计口径：
  - GitHub 仓库继续保存全量卡牌 CSV/JSON 数据；
  - ESP32 固件联网从 GitHub raw 全量 CSV 读取；
  - 固件暂时只筛选并显示 productId=562018 的 Greninja ex - 132；
  - 不把价格硬编码到固件里，价格来自 GitHub 数据文件。

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

// ===== 用户只需要改这里 =====
const char* WIFI_SSID = "你的WiFi";
const char* WIFI_PASS = "你的密码";

// 如果仓库保持 Private，ESP32 访问 raw.githubusercontent.com 会 404。
// 方案一：把数据仓库或 cards 文件发布为 Public / GitHub Pages；
// 方案二：这里填一个只读 fine-grained token。注意：写进固件的 token 不适合量产外发。
const char* GITHUB_TOKEN = "";

// GitHub 仓库里的全量卡牌 CSV，不是单卡文件。
static const char* FULL_CSV_URL =
  "https://raw.githubusercontent.com/LuckyDogzyc/HeltecTestFolder/main/cards/pokemon_cards.csv";

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
  String updatedAt;
};

static String lastError;

static float readBatteryVoltage() {
  pinMode(PIN_BAT_ADC, INPUT);
  analogReadResolution(12);
  analogSetPinAttenuation(PIN_BAT_ADC, ADC_11db);

  uint32_t raw_sum = 0;
  uint32_t mv_sum = 0;
  for (int i = 0; i < 32; ++i) {
    raw_sum += analogRead(PIN_BAT_ADC);
    mv_sum += analogReadMilliVolts(PIN_BAT_ADC);
    delay(3);
  }
  const uint32_t raw = raw_sum / 32;
  const float adc_mv = (float)mv_sum / 32.0f;
  const float bat_v = (adc_mv / 1000.0f) * DIVIDER_RATIO;
  Serial.printf("BAT GPIO34 raw=%lu adc=%.0fmV vbat=%.3fV\n", (unsigned long)raw, adc_mv, bat_v);
  return bat_v;
}

static void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  Serial.printf("Connecting WiFi SSID=%s", WIFI_SSID);
  const uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 30000) {
    Serial.print('.');
    delay(500);
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("WiFi connected, IP=%s, RSSI=%d dBm\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
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

static bool fetchGreninjaFromFullCsv(CardPrice& card) {
  if (WiFi.status() != WL_CONNECTED) {
    lastError = "No WiFi";
    return false;
  }

  WiFiClientSecure client;
  client.setInsecure(); // GitHub raw HTTPS；量产版可替换为根证书校验。

  HTTPClient http;
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  http.setConnectTimeout(15000);
  http.setTimeout(45000);
  http.useHTTP10(true); // 读取流更稳定，避免 chunked 处理差异。

  Serial.printf("Fetching full CSV from GitHub: %s\n", FULL_CSV_URL);
  if (!http.begin(client, FULL_CSV_URL)) {
    lastError = "HTTP begin failed";
    return false;
  }
  http.addHeader("User-Agent", "LuckyDog-ESP32-Greninja-Epaper/1.0");
  if (strlen(GITHUB_TOKEN) > 0) {
    http.addHeader("Authorization", String("Bearer ") + GITHUB_TOKEN);
    http.addHeader("Accept", "text/plain");
  }

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
  const uint32_t start = millis();

  while (http.connected() || stream->available()) {
    if (!stream->available()) {
      delay(10);
      if (millis() - start > 90000) {
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
      Serial.printf("CSV header: %s\n", line.c_str());
      continue;
    }

    ++lines;
    if (!line.startsWith("562018,")) {
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
    card.marketPrice = f[5];
    card.midPrice = f[6];
    card.lowPrice = f[7];
    card.highPrice = f[8];
    card.updatedAt = String(__DATE__) + " " + String(__TIME__); // 固件刷新时间；源更新时间在 GitHub Action 文件提交里。

    Serial.printf("Found after %lu data lines: %s market=%s low=%s high=%s\n",
                  (unsigned long)lines,
                  card.productName.c_str(),
                  card.marketPrice.c_str(),
                  card.lowPrice.c_str(),
                  card.highPrice.c_str());
    http.end();
    return true;
  }

  lastError = "Greninja not found in CSV";
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
      display.print(card.marketPrice.length() ? card.marketPrice : "--");

      display.setFont(&FreeSans9pt7b);
      display.setTextColor(GxEPD_RED);
      display.setCursor(140, 85);
      display.print("L $");
      display.print(card.lowPrice.length() ? card.lowPrice : "--");
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
  delay(1000);
  Serial.println();
  Serial.println("Greninja e-paper MVP: GitHub full CSV -> filter productId 562018 -> display");

  const float batV = readBatteryVoltage();
  connectWiFi();

  CardPrice card;
  if (WiFi.status() == WL_CONNECTED) {
    fetchGreninjaFromFullCsv(card);
  }

  drawScreen(card, batV);
  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);
}

void loop() {
  // 首版 MVP 不做自动刷新/深睡眠循环，避免误判耗电和屏幕频繁刷新。
  delay(60000);
}

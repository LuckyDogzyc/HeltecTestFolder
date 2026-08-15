/*
 * low_battery_test.ino — 低压告警压力测试固件（高功耗放电版）
 * 目标板：宝可梦价格牌（ESP32-WROOM-32E-N16 + GxEPD2_213_Z98c 2.13" 三色墨水屏）
 *
 * 干什么：
 *  1) 高功耗放电：双核满频浮点忙循环 + 周期 Wi-Fi 扫描（RF 全开），
 *     让电池电压快速下降（比正常深睡快几十倍）。
 *  2) 持续监测 GPIO33（实机电池直连脚）：电压掉出 ADC 饱和（<~3.1V）
 *     且连续 5 次确认后，判定"低压"。
 *  3) 低压触发后：刷新屏幕显示 LOW BATTERY + 实时电压，之后每 30s
 *     反复刷新（电压 <2.9V 时加速到每 10s），用屏幕播报直到断电。
 *
 * 测试条件（关键！）：
 *  - 必须拔掉 USB，纯电池供电！插着 USB 时充电器会把电压钉在 4.2V，永远测不到低压。
 *  - 电池越大掉电越慢：2000mAh 约 3~5 小时到 3.1V；想快就开 WIFI_BURN_INTERVAL_MS=5000
 *    或换小容量/旧电池。
 *
 * Arduino IDE 参数：ESP32 Dev Module / QIO / 16MB / 16M Flash (3MB APP/9.9MB FATFS)
 * PSRAM Disabled / 921600 / Serial Monitor 115200
 */

#include <SPI.h>
#include <WiFi.h>
#include <GxEPD2_3C.h>
#include <Fonts/FreeMonoBold9pt7b.h>
#include <Fonts/FreeMonoBold12pt7b.h>
#include <Fonts/FreeMonoBold18pt7b.h>

// ============ 测试旋钮 ============
static constexpr uint32_t SAMPLE_MS = 5000;            // 正常阶段电压采样间隔
static constexpr uint32_t LOW_REFRESH_MS = 30000;      // 低压阶段刷屏间隔
static constexpr uint32_t CRITICAL_REFRESH_MS = 10000; // 电压<2900mV 时加速刷屏
static constexpr uint32_t CRITICAL_MV = 2900;
static constexpr uint32_t LOW_MV_THRESHOLD = 3100;     // 掉出 11dB 饱和 ≈ 3.1V
static constexpr uint32_t LOW_RAW_THRESHOLD = 4070;    // 饱和 raw=4095
static constexpr int    CONFIRM_STRIKES = 5;           // 连续 5 次低压才触发（防抖）
static constexpr bool   ENABLE_WIFI_BURN = true;       // 用 Wi-Fi 扫描加大放电
static constexpr uint32_t WIFI_BURN_INTERVAL_MS = 15000;
static constexpr uint32_t EPAPER_SETTLE_MS = 25000;    // busy 兜底（与生产一致）

// ============ 硬件（与生产固件一致） ============
static constexpr int EPD_BUSY = 25, EPD_RST = 26, EPD_DC = 27;
static constexpr int EPD_MOSI = 14, EPD_SCLK = 13, EPD_CS = 15;
static constexpr int BAT_PIN = 33;   // 实机确认：电池直连 GPIO33（无分压）

GxEPD2_3C<GxEPD2_213_Z98c, GxEPD2_213_Z98c::HEIGHT> display(
  GxEPD2_213_Z98c(EPD_CS, EPD_DC, EPD_RST, EPD_BUSY)
);

// 全局采样状态（不用自定义类型做函数签名，避开 Arduino 预处理器坑）
static uint32_t gRaw = 0;
static uint32_t gMv = 0;
static int    gLowStrikes = 0;
static bool   gLowActive = false;
static uint32_t gRefreshes = 0;
static uint32_t gLastSample = 0;
static uint32_t gLastRefresh = 0;
static uint32_t gLastWifiBurn = 0;

// core 0 专职烧电：双核满载把电流拉到 ~200mA 级。
// 注意：不能无限忙循环不放手——core0 的 idle 任务会被饿死，触发 Task WDT 复位循环
// （症状：屏幕反复闪、永远画不出字、每 ~5s 重启一次）。
// 每烧 200ms 让出 10ms，idle 有机会喂狗；烧电效率 ~95%。
static void burnCpuTask(void*) {
  for (;;) {
    volatile float x = 3.14159f;
    uint32_t end = millis() + 200;
    while (millis() < end) {
      x = x * 1.0000001f + 0.0000001f;
    }
    vTaskDelay(1);   // 让位 10ms：core0 idle 运行并喂 WDT
  }
}

// 24 次平均采样（与生产固件 readBatteryVoltage 同参数）
static void readBattery() {
  pinMode(BAT_PIN, INPUT);
  analogSetPinAttenuation(BAT_PIN, ADC_11db);
  uint32_t rawSum = 0, mvSum = 0;
  for (int i = 0; i < 24; ++i) {
    rawSum += analogRead(BAT_PIN);
    mvSum += analogReadMilliVolts(BAT_PIN);
    delay(2);
  }
  gRaw = rawSum / 24;
  gMv = mvSum / 24;
}

// 与生产固件同款的 BUSY 墙钟兜底：刷新耗时 <3s 视为 busy 未生效，强制等满波形时间
static void waitEpaperSettle(uint32_t refreshStartMs) {
  uint32_t elapsed = millis() - refreshStartMs;
  if (elapsed < 3000) {
    Serial.printf("Epaper busy NOT engaged (refresh took %lums) -> settling %lums for waveform\n",
                  (unsigned long)elapsed, (unsigned long)EPAPER_SETTLE_MS);
    delay(EPAPER_SETTLE_MS);
  } else {
    Serial.printf("Epaper refresh took %lums (busy engaged)\n", (unsigned long)elapsed);
  }
}

// 低压告警屏：大号红字 + 实时电压 + 刷新计数
static void drawLowScreen() {
  char buf[48];
  gRefreshes++;
  float vBat = (float)gMv / 1000.0f;
  uint32_t rStart = millis();
  SPI.begin(EPD_SCLK, -1, EPD_MOSI, EPD_CS);
  display.init(115200, true, 10, false);
  display.setRotation(1);
  display.setFullWindow();
  display.firstPage();
  do {
    display.fillScreen(GxEPD_WHITE);
    display.setTextColor(GxEPD_RED);
    display.setFont(&FreeMonoBold18pt7b);
    display.setCursor(6, 28);
    display.print("LOW BATTERY");
    display.setTextColor(GxEPD_BLACK);
    display.setFont(&FreeMonoBold18pt7b);
    snprintf(buf, sizeof(buf), "%.2fV", vBat);
    display.setCursor(70, 58);
    display.print(buf);
    display.setFont(&FreeMonoBold9pt7b);
    snprintf(buf, sizeof(buf), "raw=%lu mv=%lumV", (unsigned long)gRaw, (unsigned long)gMv);
    display.setCursor(6, 80);
    display.print(buf);
    display.setTextColor(GxEPD_RED);
    display.setFont(&FreeMonoBold12pt7b);
    display.setCursor(6, 100);
    display.print("CHARGE NOW");
    display.setTextColor(GxEPD_BLACK);
    display.setFont(&FreeMonoBold9pt7b);
    snprintf(buf, sizeof(buf), "screen refresh #%lu", (unsigned long)gRefreshes);
    display.setCursor(6, 117);
    display.print(buf);
  } while (display.nextPage());
  waitEpaperSettle(rStart);
  display.hibernate();
}

void setup() {
  Serial.begin(115200);
  delay(200);
  analogReadResolution(12);
  setCpuFrequencyMhz(240);

  Serial.println();
  Serial.println("==============================================");
  Serial.println("Low-Battery Alarm Stress Test (high power burn)");
  Serial.printf("freq=%luMHz  freeHeap=%lu\n",
                (unsigned long)getCpuFrequencyMhz(), (unsigned long)ESP.getFreeHeap());
  Serial.println("Burning battery: dual-core busy loop" + String(ENABLE_WIFI_BURN ? " + wifi scan" : ""));
  Serial.printf("Low threshold: mv<%lu raw<%lu, %d strikes to confirm\n",
                (unsigned long)LOW_MV_THRESHOLD, (unsigned long)LOW_RAW_THRESHOLD, CONFIRM_STRIKES);
  Serial.println("WARNING: run on BATTERY ONLY (unplug USB), or voltage stays at 4.2V charging!");

  // core 0 专职烧电任务
  xTaskCreatePinnedToCore(burnCpuTask, "burn", 4096, NULL, 2, NULL, 0);

  // 开机先读一次并画一屏（即使电压还正常，也留个"测试已开始"的证据）
  readBattery();
  Serial.printf("BAT raw=%lu mv=%lumV (%.2fV) - first sample\n",
                (unsigned long)gRaw, (unsigned long)gMv, (float)gMv / 1000.0f);
  drawLowScreen();
  gLowActive = false; // 首屏只是启动证据，不触发告警逻辑
}

void loop() {
  uint32_t now = millis();

  // 周期电压采样 + 低压判定（连续 5 次确认，防 ADC 抖动误报）
  if (now - gLastSample >= SAMPLE_MS) {
    gLastSample = now;
    readBattery();
    Serial.printf("BAT raw=%lu mv=%lumV (%.2fV) %s\n",
                  (unsigned long)gRaw, (unsigned long)gMv, (float)gMv / 1000.0f,
                  gLowActive ? "[LOW-ACTIVE]" : "[monitoring]");
    if (!gLowActive) {
      if (gMv < LOW_MV_THRESHOLD && gRaw < LOW_RAW_THRESHOLD) {
        if (++gLowStrikes >= CONFIRM_STRIKES) {
          gLowActive = true;
          Serial.println(">>> LOW BATTERY CONFIRMED - alarm screen now");
          drawLowScreen();
          gLastRefresh = millis();
        }
      } else {
        gLowStrikes = 0;
      }
    }
  }

  // 低压持续播报：每 30s（<2.9V 时每 10s）刷新一次屏幕，直到断电
  if (gLowActive) {
    uint32_t interval = (gMv < CRITICAL_MV) ? CRITICAL_REFRESH_MS : LOW_REFRESH_MS;
    if (now - gLastRefresh >= interval) {
      gLastRefresh = now;
      drawLowScreen();
    }
  }

  // Wi-Fi 扫描烧电：RF 全开 1~2s，显著拉高平均电流（不需要连网）
  if (ENABLE_WIFI_BURN && now - gLastWifiBurn >= WIFI_BURN_INTERVAL_MS) {
    gLastWifiBurn = now;
    WiFi.mode(WIFI_STA);
    int n = WiFi.scanNetworks();
    Serial.printf("wifi-scan: %d networks found\n", n);
    WiFi.scanDelete();
  }

  // core 1 也烧一段（双核满载）
  volatile float x = 1.2345f;
  uint32_t end = millis() + 200;
  while (millis() < end) {
    x = x * 1.0000001f + 0.0000001f;
  }
  delay(10);
}

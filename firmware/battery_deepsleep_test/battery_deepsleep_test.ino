/*
 * battery_deepsleep_test.ino — ESP32 电池电量 + 深睡眠 独立测试固件
 * 目标板：宝可梦价格牌（ESP32-WROOM-32E-N16 + GxEPD2_213_Z98c 2.13" 三色墨水屏）
 *
 * 要回答的三个问题：
 *  1) 电池采样通路到底在哪只脚？
 *     外包原理图：VBAT_SENSE = GPIO34（VBAT→100k→GPIO34→100k→GND，vbat = ADC×2）
 *     生产固件实测：GPIO34 在 ADC 地板（~142mV），GPIO33 却有 3.134V 且满量程饱和（raw=4095）。
 *     本固件同时扫描 GPIO32/33/34/35/36/39，谁有电压、是否饱和、×1/×2 哪个落在 3.2~4.2V，一目了然。
 *  2) 有没有硬件分压？raw>=4080 饱和 = 引脚电压 ≥3.13V。
 *     若图纸的 100k/100k 分压真的焊了，4.2V 只会到 2.1V，绝不会饱和 → 饱和即分压缺失或引脚焊错。
 *  3) 深睡眠循环是否完整：RTC 定时唤醒 → 重测电池 → 刷屏（含 BUSY 兜底 25s）→ 再次深睡，
 *     电流交给万用表串测。
 *
 * Arduino IDE 参数（与生产固件一致）：
 *   Board: ESP32 Dev Module
 *   Flash Mode: QIO / Flash Size: 16MB
 *   Partition Scheme: 16M Flash (3MB APP/9.9MB FATFS)
 *   PSRAM: Disabled / Upload Speed: 921600 / Serial Monitor: 115200
 *
 * 用法：
 *   TEST_SLEEP_SECONDS = 30 : 正常测试，每 30 秒唤醒一次（一个周期约 60~70s）
 *   TEST_SLEEP_SECONDS = 0  : 保持常开不睡——配合万用表测"活跃电流"，
 *                             或盯着串口每 5s 看一次电池掉压
 */

#include <SPI.h>
#include <esp_sleep.h>
#include <GxEPD2_3C.h>
#include <Fonts/FreeMonoBold9pt7b.h>

// ============ 测试旋钮 ============
static constexpr int TEST_SLEEP_SECONDS = 30;   // 0 = 常开不睡（测活跃电流 / 观察掉压）
static constexpr uint32_t EPAPER_SETTLE_MS = 25000; // busy 未生效时的墙钟兜底（生产固件同款）

// ============ 硬件引脚（与生产固件一致） ============
static constexpr int EPD_BUSY = 25;
static constexpr int EPD_RST  = 26;
static constexpr int EPD_DC   = 27;
static constexpr int EPD_MOSI = 14;
static constexpr int EPD_SCLK = 13;
static constexpr int EPD_CS   = 15;

GxEPD2_3C<GxEPD2_213_Z98c, GxEPD2_213_Z98c::HEIGHT> display(
  GxEPD2_213_Z98c(EPD_CS, EPD_DC, EPD_RST, EPD_BUSY)
);

// ============ 电池采样候选脚 ============
// 生产固件现在读 GPIO33（直连假设 ×1）；外包图纸写 GPIO34（100k/100k 分压 ×2）。
static constexpr int ADC_PINS[] = {32, 33, 34, 35, 36, 39};
static constexpr int ADC_PIN_COUNT = sizeof(ADC_PINS) / sizeof(ADC_PINS[0]);
static constexpr float MIN_VALID_V = 2.50f;     // 低于此值视为无电池/悬空
static constexpr float BAT_EMPTY_V = 3.20f;     // 生产固件的百分比映射下限
static constexpr float BAT_FULL_V  = 4.20f;
static constexpr uint32_t SATURATED_RAW = 4080; // 11dB 下 ADC 满量程 ≈ 3134mV

RTC_DATA_ATTR uint32_t cycle = 0;  // 跨深睡保持的循环计数

// 采样结果（readPin 的返回值只含基础类型，避开 Arduino 预处理器对结构体的解析坑）
struct PinSample {
  uint32_t raw;
  uint32_t mv;
};

// 判定结果：全部用全局变量（不用自定义类型做函数参数/返回值，保证预处理原型生成不出错）
static int    gBestPin = -1;
static uint32_t gBestRaw = 0;
static uint32_t gBestMv = 0;
static float  gBestV1 = 0;       // 直连假设 vbat = mv
static float  gBestV2 = 0;       // 图纸假设 vbat = mv × 2
static bool   gSaturated = false;
static bool   gDividerOk = false;  // ×2 落在 3.0~4.4V = 图纸分压对得上
static bool   gDirectOk = false;   // ×1 落在 3.0~4.4V = 直连
static const char* gLabel = "NO BATTERY";

// 24 次平均采样（与生产固件 readBatteryVoltage 同参数）
static PinSample readPin(int pin) {
  PinSample s;
  pinMode(pin, INPUT);
  analogSetPinAttenuation(pin, ADC_11db);
  uint32_t rawSum = 0, mvSum = 0;
  for (int i = 0; i < 24; ++i) {
    rawSum += analogRead(pin);
    mvSum += analogReadMilliVolts(pin);
    delay(2);
  }
  s.raw = rawSum / 24;
  s.mv  = mvSum / 24;
  return s;
}

static const char* resetReasonName() {
  switch (esp_reset_reason()) {
    case ESP_RST_POWERON:  return "POWERON (fresh boot)";
    case ESP_RST_DEEPSLEEP:return "DEEP-SLEEP TIMER WAKEUP";
    case ESP_RST_SW:       return "SOFTWARE reset";
    case ESP_RST_PANIC:    return "PANIC crash!";
    case ESP_RST_EXT:      return "EXT (EN button?)";
    default:               return "other";
  }
}

static const char* wakeCauseName() {
  switch (esp_sleep_get_wakeup_cause()) {
    case ESP_SLEEP_WAKEUP_TIMER: return "TIMER";
    case ESP_SLEEP_WAKEUP_EXT0:  return "EXT0";
    case ESP_SLEEP_WAKEUP_EXT1:  return "EXT1";
    case ESP_SLEEP_WAKEUP_GPIO:  return "GPIO";
    case ESP_SLEEP_WAKEUP_UART:  return "UART";
    case ESP_SLEEP_WAKEUP_UNDEFINED: return "NONE";
    default:                     return "?";
  }
}

static int percentFrom(float v) {
  if (v <= BAT_EMPTY_V) return 0;
  if (v >= BAT_FULL_V)  return 100;
  return (int)((v - BAT_EMPTY_V) / (BAT_FULL_V - BAT_EMPTY_V) * 100.0f + 0.5f);
}

// 扫描所有候选脚并给结论（结果写全局变量）
static void scanBattery() {
  gBestPin = -1; gBestRaw = 0; gBestMv = 0;
  gSaturated = gDividerOk = gDirectOk = false;
  gLabel = "NO BATTERY";
  Serial.println("--- ADC scan (11dB, 24-sample avg) ---");
  int candidates = 0;
  for (int i = 0; i < ADC_PIN_COUNT; ++i) {
    int pin = ADC_PINS[i];
    PinSample s = readPin(pin);
    Serial.printf("  GPIO%-2d raw=%4lu adc=%4lumV", pin, (unsigned long)s.raw, (unsigned long)s.mv);
    if (s.mv >= 500) {
      Serial.print("   <-- candidate");
      candidates++;
    }
    Serial.println();
    if (s.mv > gBestMv) { gBestRaw = s.raw; gBestMv = s.mv; gBestPin = pin; }
  }
  if (gBestPin < 0 || gBestMv < 500) {
    Serial.println("VERDICT: no battery detected (all pins at floor). USB-only or cell dead?");
    return;
  }
  gSaturated = gBestRaw >= SATURATED_RAW;
  gBestV1 = (float)gBestMv / 1000.0f;
  gBestV2 = gBestV1 * 2.0f;
  gDividerOk = (gBestV2 >= 3.0f && gBestV2 <= 4.4f);
  gDirectOk  = (gBestV1 >= 3.0f && gBestV1 <= 4.4f);

  Serial.printf("Battery candidate: GPIO%d raw=%lu adc=%lumV (%d pin(s) above 500mV)\n",
                gBestPin, (unsigned long)gBestRaw, (unsigned long)gBestMv, candidates);
  if (gSaturated) {
    Serial.printf("  >> SATURATED (raw>=%lu, pin >= ~3.13V)\n", (unsigned long)SATURATED_RAW);
    Serial.printf("     hypothesis x1 (direct): v=%.3fV\n     hypothesis x2 (schematic 100k/100k): v=%.3fV\n",
                  gBestV1, gBestV2);
    Serial.println("  >> 分压缺失或引脚焊错：图纸 100k/100k 分压下 4.2V 只到 2.1V，不可能饱和。");
    Serial.println("     4.2V 直连 ADC 引脚超出量程（11dB 上限约 3.1V），需硬件修：加分压或核对走线。");
    gLabel = "SATURATED";
  } else if (gDividerOk) {
    Serial.printf("  >> MATCHES SCHEMATIC x2 DIVIDER: vbat = %.3fV (pct ~%d%%)\n",
                  gBestV2, percentFrom(gBestV2));
    gLabel = "DIVIDER OK x2";
  } else if (gDirectOk) {
    Serial.printf("  >> DIRECT FEED x1 (no divider): vbat = %.3fV (pct ~%d%%)\n",
                  gBestV1, percentFrom(gBestV1));
    gLabel = "DIRECT x1";
  } else {
    Serial.printf("  >> value outside 3.0~4.4V under both hypotheses (x1=%.3fV x2=%.3fV), check wiring\n",
                  gBestV1, gBestV2);
    gLabel = "SUSPECT";
  }
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

static void drawTestScreen() {
  char buf[48];
  SPI.begin(EPD_SCLK, -1, EPD_MOSI, EPD_CS);
  display.init(115200, true, 10, false);   // reset_duration=10ms，与生产一致
  display.setRotation(1);                  // 逻辑 250 x 122
  display.setFullWindow();
  display.firstPage();
  uint32_t epdStart = millis();
  do {
    display.fillScreen(GxEPD_WHITE);
    display.setTextColor(GxEPD_BLACK);
    display.setFont(&FreeMonoBold9pt7b);
    int y = 12;
    snprintf(buf, sizeof(buf), "BAT/DS TEST C#%lu", (unsigned long)cycle);
    display.setCursor(0, y); display.print(buf);            y += 16;
    snprintf(buf, sizeof(buf), "WAKE=%s", wakeCauseName());
    display.setCursor(0, y); display.print(buf);            y += 16;
    if (gBestPin >= 0) {
      snprintf(buf, sizeof(buf), "BAT@GPIO%d %lumV", gBestPin, (unsigned long)gBestMv);
      display.setCursor(0, y); display.print(buf);          y += 16;
      if (gSaturated) {
        snprintf(buf, sizeof(buf), "RAW=%lu SATURATED", (unsigned long)gBestRaw);
        display.setCursor(0, y); display.print(buf);        y += 16;
      } else {
        float vBat = gDividerOk ? gBestV2 : (gDirectOk ? gBestV1 : 0);
        snprintf(buf, sizeof(buf), "V=%.2fV %d%%", vBat, percentFrom(vBat));
        display.setCursor(0, y); display.print(buf);        y += 16;
      }
    } else {
      display.setCursor(0, y); display.print("NO BATTERY"); y += 16;
    }
    display.setCursor(0, y); display.print(gLabel);         y += 16;
    snprintf(buf, sizeof(buf), "SLEEP=%ds", TEST_SLEEP_SECONDS);
    display.setCursor(0, y); display.print(buf);
  } while (display.nextPage());
  waitEpaperSettle(epdStart);
  display.hibernate();
}

static void goToSleep() {
  Serial.printf("Entering deep sleep for %d s\n", TEST_SLEEP_SECONDS);
  Serial.flush();
  delay(100);   // 让 UART 缓冲真正吐完，避免最后一行被断电截断
  esp_sleep_enable_timer_wakeup((uint64_t)TEST_SLEEP_SECONDS * 1000000ULL);
  esp_deep_sleep_start();
  // 不返回
}

void setup() {
  Serial.begin(115200);
  delay(200);
  analogReadResolution(12);

  cycle++;
  Serial.println();
  Serial.println("==============================================");
  Serial.println("Battery + Deep-Sleep Test (battery_deepsleep_test)");
  Serial.printf("cycle=%lu  reset=%s  wakeup_cause=%s  freeHeap=%lu\n",
                (unsigned long)cycle, resetReasonName(), wakeCauseName(), (unsigned long)ESP.getFreeHeap());
  if (esp_reset_reason() == ESP_RST_DEEPSLEEP) {
    Serial.println(">>> 深睡定时唤醒正常：RTC 定时器把设备叫醒了");
  } else if (cycle > 1) {
    Serial.println(">>> 注意：不是定时唤醒而是外部复位——检查是不是按了 EN/断电重插");
  }

  scanBattery();
  drawTestScreen();

  if (TEST_SLEEP_SECONDS == 0) {
    Serial.println("Stay-awake mode (TEST_SLEEP_SECONDS=0): watching battery every 5 s");
  } else {
    goToSleep();
  }
}

void loop() {
  if (TEST_SLEEP_SECONDS == 0) {
    static uint32_t last = 0;
    if (millis() - last >= 5000) {
      last = millis();
      PinSample p33 = readPin(33);
      PinSample p34 = readPin(34);
      Serial.printf("T+%6lus  GPIO33 raw=%4lu mv=%4lu | GPIO34 raw=%4lu mv=%4lu\n",
                    (unsigned long)(millis() / 1000),
                    (unsigned long)p33.raw, (unsigned long)p33.mv,
                    (unsigned long)p34.raw, (unsigned long)p34.mv);
    }
    delay(50);
  } else {
    delay(50);  // 理论到不了这里：setup 里已深睡
  }
}

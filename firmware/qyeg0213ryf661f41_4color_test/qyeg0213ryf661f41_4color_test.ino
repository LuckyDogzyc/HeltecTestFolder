/*
 * QYEG0213RYF661F41 four-color panel hardware test for the existing ESP32 board.
 *
 * Source protocol: vendor STM32 demo supplied with QYEG0213RYF661F41-V2.0.
 * Panel native raster: 128 x 250 pixels, 2 bits/pixel, 8,000 bytes per full frame.
 * Colors on the panel: white=01, yellow=10, red=11, black=00.
 *
 * IMPORTANT:
 * - Flash ONLY when a QYEG0213RYF661F41 FOUR-COLOR panel is physically connected.
 * - This does NOT make the installed QYEG0213RYF661 three-color panel become four-color.
 * - It intentionally does not connect Wi-Fi, FFat, server APIs, or deep sleep.
 * - The pin map below is the currently verified production ESP32 test-board map.
 */

#include <Arduino.h>
#include <SPI.h>

static constexpr int EPD_BUSY = 25;
static constexpr int EPD_RST = 26;
static constexpr int EPD_DC = 27;
static constexpr int EPD_MOSI = 14;
static constexpr int EPD_SCLK = 13;
static constexpr int EPD_CS = 15;

static constexpr uint16_t PANEL_WIDTH = 128;
static constexpr uint16_t PANEL_HEIGHT = 250;
static constexpr uint16_t BYTES_PER_ROW = PANEL_WIDTH / 4;
static constexpr uint32_t FRAME_BYTES = uint32_t(PANEL_HEIGHT) * BYTES_PER_ROW;

// The production board's BUSY line is known not to report the panel waveform.
// Use conservative wall-clock waits for the first hardware test. Set true only
// after measuring a correctly wired BUSY signal on this four-color panel.
static constexpr bool BUSY_WIRE_VERIFIED = false;

// Controller-native 2-bit pixel values, four pixels packed MSB first in each byte.
enum PanelColor : uint8_t {
  BLACK = 0b00,
  WHITE = 0b01,
  YELLOW = 0b10,
  RED = 0b11,
};

static void command(uint8_t value) {
  digitalWrite(EPD_DC, LOW);
  digitalWrite(EPD_CS, LOW);
  SPI.transfer(value);
  digitalWrite(EPD_CS, HIGH);
}

static void data(uint8_t value) {
  digitalWrite(EPD_DC, HIGH);
  digitalWrite(EPD_CS, LOW);
  SPI.transfer(value);
  digitalWrite(EPD_CS, HIGH);
}

static bool waitUntilReady(const char* stage, uint32_t timeoutMs) {
  if (!BUSY_WIRE_VERIFIED) {
    // The known three-color production board does not expose a useful BUSY
    // signal. Do not block the refresh command waiting for a permanently LOW
    // GPIO; the controller is instead allowed its documented full-refresh time.
    const uint32_t fixedWaitMs = strstr(stage, "refresh") ? 30000 : 1000;
    Serial.printf("BUSY bypass: %s; fixed delay %lu ms (GPIO%d=%d)\n",
                  stage, static_cast<unsigned long>(fixedWaitMs), EPD_BUSY, digitalRead(EPD_BUSY));
    delay(fixedWaitMs);
    return true;
  }

  const uint32_t started = millis();
  // Vendor code documents BUSY=0 and waits for BUSY=1.
  while (digitalRead(EPD_BUSY) == LOW) {
    if (millis() - started >= timeoutMs) {
      Serial.printf("ERROR: BUSY timeout during %s after %lu ms (pin=%d state=%d)\n",
                    stage, static_cast<unsigned long>(timeoutMs), EPD_BUSY, digitalRead(EPD_BUSY));
      return false;
    }
    delay(10);
  }
  Serial.printf("BUSY ready: %s after %lu ms\n", stage, static_cast<unsigned long>(millis() - started));
  return true;
}

static void resetPanel() {
  digitalWrite(EPD_RST, LOW);
  delay(100);
  digitalWrite(EPD_RST, HIGH);
  delay(100);
}

// Exact initialization sequence from the uploaded QYEG0213RYF661F41 STM32 demo.
static void initPanel() {
  resetPanel();

  command(0x4D); data(0x78);
  command(0x00); data(0x07); data(0x29);
  command(0x01); data(0x07); data(0x00);
  command(0x03); data(0x10); data(0x54); data(0x44);
  command(0x06); data(0x0F); data(0x0A); data(0x2F); data(0x25); data(0x22); data(0x2E); data(0x21);
  command(0x50); data(0x37);
  command(0x60); data(0x02); data(0x02);
  command(0x61); data(0x00); data(0x80); data(0x00); data(0xFA);  // 128 x 250
  command(0xE7); data(0x1C);
  command(0xE3); data(0x22);
  command(0xB6); data(0x6F);
  command(0xB4); data(0xD0);
  command(0xE9); data(0x01);
  command(0x30); data(0x08);
}

static PanelColor colorAt(uint16_t x, uint16_t y) {
  // A four-quadrant pattern proves every pigment independently.
  if (y < PANEL_HEIGHT / 2) return x < PANEL_WIDTH / 2 ? BLACK : RED;
  return x < PANEL_WIDTH / 2 ? YELLOW : WHITE;
}

static uint8_t pack4Pixels(uint16_t x, uint16_t y) {
  return (static_cast<uint8_t>(colorAt(x + 0, y)) << 6) |
         (static_cast<uint8_t>(colorAt(x + 1, y)) << 4) |
         (static_cast<uint8_t>(colorAt(x + 2, y)) << 2) |
         static_cast<uint8_t>(colorAt(x + 3, y));
}

static bool drawFourColorQuadrants() {
  Serial.printf("Sending %lu-byte native 2bpp frame (%ux%u)\n",
                static_cast<unsigned long>(FRAME_BYTES), PANEL_WIDTH, PANEL_HEIGHT);
  command(0x10);
  for (uint16_t y = 0; y < PANEL_HEIGHT; ++y) {
    for (uint16_t byteX = 0; byteX < BYTES_PER_ROW; ++byteX) {
      data(pack4Pixels(byteX * 4, y));
    }
  }

  command(0x04);  // power on
  if (!waitUntilReady("power-on", 30000)) return false;

  command(0x12);  // display refresh
  data(0x00);
  if (!waitUntilReady("four-color refresh", 90000)) return false;

  command(0x02);  // power off
  data(0x00);
  if (!waitUntilReady("power-off", 30000)) return false;

  command(0x07);  // deep sleep panel controller
  data(0xA5);
  delay(200);
  return true;
}

void setup() {
  Serial.begin(115200);
  delay(400);
  Serial.println("\nQYEG0213RYF661F41 four-color ESP32 hardware test");
  Serial.printf("Pins: BUSY=%d RST=%d DC=%d MOSI=%d SCLK=%d CS=%d\n",
                EPD_BUSY, EPD_RST, EPD_DC, EPD_MOSI, EPD_SCLK, EPD_CS);

  pinMode(EPD_BUSY, INPUT);
  pinMode(EPD_RST, OUTPUT);
  pinMode(EPD_DC, OUTPUT);
  pinMode(EPD_CS, OUTPUT);
  digitalWrite(EPD_CS, HIGH);
  digitalWrite(EPD_DC, HIGH);
  digitalWrite(EPD_RST, HIGH);

  SPI.begin(EPD_SCLK, -1, EPD_MOSI, EPD_CS);
  SPI.beginTransaction(SPISettings(2000000, MSBFIRST, SPI_MODE0));
  initPanel();
  const bool ok = drawFourColorQuadrants();
  SPI.endTransaction();

  Serial.println(ok
    ? "PASS: verify physical panel shows BLACK | RED on top, YELLOW | WHITE on bottom."
    : "FAIL: inspect FPC pinout, BUSY polarity/wiring, panel power, and confirm F41 four-color panel.");
}

void loop() {
  delay(1000);
}

// esp-tou — time-of-use electricity price indicator
//
// ESP32 DevKit + 1602 I2C LCD + Freenove 8x WS2812 RGB module.
// Syncs NZ time via WiFi/NTP, then shows the current tariff band:
//   LCD line 1: band name          e.g. "OFF-PEAK"
//   LCD line 2: clock + band end   e.g. "14:32 ends 17:00"
//   RGB bar: band colour, lit length = fraction of the band remaining.

#include <WiFi.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <Adafruit_NeoPixel.h>
#include <time.h>
#include "secrets.h"

// ---------------- Hardware ----------------
constexpr int PIXEL_PIN   = 27;  // Freenove RGB module S pin
                                 // (not 16/17: WROVER uses those for PSRAM)
constexpr int PIXEL_COUNT = 8;
constexpr int SDA_PIN     = 21;
constexpr int SCL_PIN     = 22;

constexpr uint8_t DAY_BRIGHTNESS   = 40;   // 0-255
constexpr uint8_t NIGHT_BRIGHTNESS = 6;    // dim so it doesn't light the room
constexpr int NIGHT_DIM_FROM_MIN   = 21 * 60;  // 9pm
constexpr int NIGHT_DIM_UNTIL_MIN  = 7 * 60;   // 7am

// New Zealand, with daylight saving rules baked in
const char* TZ_INFO = "NZST-12NZDT,M9.5.0,M4.1.0/3";

// Location, for computing sunrise/sunset (drives the LCD backlight)
constexpr float LATITUDE  = -41.29;  // Wellington
constexpr float LONGITUDE = 174.78;

// ---------------- Tariff schedule ----------------
enum Band : uint8_t { VERY_CHEAP, OFF_PEAK, PEAK };
// Shown on LCD line 1 — must fit in 16 characters
const char* BAND_NAME[] = {"POWER VERY CHEAP", "POWER IS CHEAP", "POWER EXPENSIVE"};

// Each window runs from startMin until the next entry's start (wraps at
// midnight). Entries must be sorted by startMin. Same schedule every day.
struct Window { uint16_t startMin; Band band; };
const Window SCHEDULE[] = {
  {0 * 60,  VERY_CHEAP},  // 12am - 7am
  {7 * 60,  PEAK},        // 7am - 11am
  {11 * 60, OFF_PEAK},    // 11am - 5pm
  {17 * 60, PEAK},        // 5pm - 9pm
  {21 * 60, OFF_PEAK},    // 9pm - 11pm
  {23 * 60, VERY_CHEAP},  // 11pm - 12am
};
constexpr int N_WINDOWS = sizeof(SCHEDULE) / sizeof(SCHEDULE[0]);
constexpr int MIN_PER_DAY = 24 * 60;

LiquidCrystal_I2C* lcd = nullptr;
Adafruit_NeoPixel strip(PIXEL_COUNT, PIXEL_PIN, NEO_GRB + NEO_KHZ800);

Band bandAt(int minuteOfDay) {
  Band b = SCHEDULE[N_WINDOWS - 1].band;  // last window wraps past midnight
  for (int i = 0; i < N_WINDOWS; i++) {
    if (SCHEDULE[i].startMin <= minuteOfDay) b = SCHEDULE[i].band;
  }
  return b;
}

// Minutes until the band changes to something different (merges adjacent
// windows of the same band, e.g. 11pm VERY_CHEAP flowing into 12am).
int minutesUntilBandEnd(int minuteOfDay) {
  Band now = bandAt(minuteOfDay);
  for (int ahead = 1; ahead <= MIN_PER_DAY; ahead++) {
    if (bandAt((minuteOfDay + ahead) % MIN_PER_DAY) != now) return ahead;
  }
  return MIN_PER_DAY;  // single-band schedule
}

int minutesSinceBandStart(int minuteOfDay) {
  Band now = bandAt(minuteOfDay);
  for (int back = 1; back <= MIN_PER_DAY; back++) {
    if (bandAt((minuteOfDay - back + MIN_PER_DAY) % MIN_PER_DAY) != now) {
      return back - 1;
    }
  }
  return 0;
}

uint32_t bandColor(Band b) {
  switch (b) {
    case VERY_CHEAP: return strip.Color(0, 190, 25);   // green
    case OFF_PEAK:   return strip.Color(255, 90, 0);   // amber
    default:         return strip.Color(255, 0, 0);    // red
  }
}

bool inNightDim(int minuteOfDay) {
  return minuteOfDay >= NIGHT_DIM_FROM_MIN || minuteOfDay < NIGHT_DIM_UNTIL_MIN;
}

// Today's sunrise/sunset as local minutes-of-day, from the standard solar
// equations (declination + equation of time) — accurate to a minute or two.
void sunTimes(const tm& now, int& riseMin, int& setMin) {
  float N = now.tm_yday + 1;
  float B = 2 * PI * (N - 81) / 364.0;
  float eqTime = 9.87 * sin(2 * B) - 7.53 * cos(B) - 1.5 * sin(B);  // minutes
  float decl = -23.44 * DEG_TO_RAD * cos(2 * PI / 365.0 * (N + 10));
  float lat = LATITUDE * DEG_TO_RAD;
  // -0.83 deg: sun's radius + atmospheric refraction at the horizon
  float cosH = (sin(-0.83 * DEG_TO_RAD) - sin(lat) * sin(decl)) /
               (cos(lat) * cos(decl));
  cosH = constrain(cosH, -1.0f, 1.0f);
  float halfDay = acos(cosH) * RAD_TO_DEG * 4;  // minutes

  // UTC offset (incl. DST) via localtime vs gmtime of the same instant
  time_t t = time(nullptr);
  tm loc, utc;
  localtime_r(&t, &loc);
  gmtime_r(&t, &utc);
  int offset = (loc.tm_hour - utc.tm_hour) * 60 + (loc.tm_min - utc.tm_min);
  if (loc.tm_year != utc.tm_year || loc.tm_yday != utc.tm_yday) {
    bool localAhead = (loc.tm_year > utc.tm_year) ||
                      (loc.tm_year == utc.tm_year && loc.tm_yday > utc.tm_yday);
    offset += localAhead ? 1440 : -1440;
  }

  float solarNoon = 720 - 4 * LONGITUDE - eqTime + offset;
  riseMin = ((int)(solarNoon - halfDay) + 1440) % 1440;
  setMin  = ((int)(solarNoon + halfDay) + 1440) % 1440;
}

bool isDark(const tm& now) {
  static int cachedDay = -1;
  static int riseMin = 0, setMin = 0;
  if (now.tm_yday != cachedDay) {
    cachedDay = now.tm_yday;
    sunTimes(now, riseMin, setMin);
    Serial.printf("sun: rise %02d:%02d, set %02d:%02d\n", riseMin / 60,
                  riseMin % 60, setMin / 60, setMin % 60);
  }
  int m = now.tm_hour * 60 + now.tm_min;
  return m < riseMin || m >= setMin;
}

// ---------------- LCD helpers ----------------
void lcdLine(int row, const String& text) {
  if (lcd == nullptr) return;
  static String last[2];
  String padded = text;
  while (padded.length() < 16) padded += ' ';
  padded = padded.substring(0, 16);
  if (padded == last[row]) return;  // avoid flicker
  last[row] = padded;
  lcd->setCursor(0, row);
  lcd->print(padded);
}

// PCF8574 backpacks live at 0x20-0x27, PCF8574A at 0x38-0x3F.
// Returns 0 if nothing answers.
uint8_t findLcdAddress() {
  for (uint8_t addr = 0x20; addr <= 0x3F; addr++) {
    if (addr == 0x28) addr = 0x38;
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      Serial.printf("I2C device found at 0x%02X\n", addr);
      return addr;
    }
  }
  Serial.println("I2C scan: no devices found (check SDA=21, SCL=22)");
  return 0;
}

// Keeps rescanning until an LCD answers, so wiring it after boot works.
void ensureLcd() {
  static uint32_t lastScan = 0;
  if (lcd != nullptr || millis() - lastScan < 2000) return;
  lastScan = millis();
  uint8_t addr = findLcdAddress();
  if (addr == 0) return;
  lcd = new LiquidCrystal_I2C(addr, 16, 2);
  lcd->init();
  lcd->backlight();
}

// ---------------- Display ----------------
void showStatus(const String& l1, const String& l2) {
  lcdLine(0, l1);
  lcdLine(1, l2);
}

void render(const tm& now) {
  int minuteOfDay = now.tm_hour * 60 + now.tm_min;
  Band band = bandAt(minuteOfDay);

  int remaining = minutesUntilBandEnd(minuteOfDay);
  int elapsed   = minutesSinceBandStart(minuteOfDay);
  int total     = remaining + elapsed;
  int endMin    = (minuteOfDay + remaining) % MIN_PER_DAY;

  char line2[17];
  snprintf(line2, sizeof(line2), "%02d:%02d ends %02d:%02d",
           now.tm_hour, now.tm_min, endMin / 60, endMin % 60);
  lcdLine(0, BAND_NAME[band]);
  lcdLine(1, line2);

  // backlight only during daylight; the RGB bar carries the signal at night
  if (lcd != nullptr) {
    static int lastDark = -1;
    int dark = isDark(now) ? 1 : 0;
    if (dark != lastDark) {
      lastDark = dark;
      if (dark) lcd->noBacklight(); else lcd->backlight();
    }
  }

  // RGB bar: drains as the band runs out
  int lit = (remaining * PIXEL_COUNT + total - 1) / total;  // ceil
  lit = constrain(lit, 1, PIXEL_COUNT);
  strip.setBrightness(inNightDim(minuteOfDay) ? NIGHT_BRIGHTNESS
                                              : DAY_BRIGHTNESS);
  uint32_t c = bandColor(band);
  for (int i = 0; i < PIXEL_COUNT; i++) {
    strip.setPixelColor(i, i < lit ? c : 0);
  }
  strip.show();
}

// ---------------- Setup / loop ----------------
bool timeIsSet() {
  return time(nullptr) > 1700000000;  // any plausible current epoch
}

void setup() {
  Serial.begin(115200);

  strip.begin();
  strip.setBrightness(DAY_BRIGHTNESS);
  strip.clear();
  strip.show();

  Wire.begin(SDA_PIN, SCL_PIN);
  ensureLcd();

  showStatus("esp-tou", "WiFi: " WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  // NTP with NZ timezone; SNTP keeps re-syncing in the background
  configTzTime(TZ_INFO, "nz.pool.ntp.org", "pool.ntp.org",
               "time.cloudflare.com");
}

void loop() {
  ensureLcd();
  if (!timeIsSet()) {
    showStatus("esp-tou",
               WiFi.status() == WL_CONNECTED ? "Syncing time..."
                                             : "WiFi: " WIFI_SSID);
    // amber "waiting" dot so the device visibly isn't dead
    strip.clear();
    strip.setPixelColor(0, strip.Color(255, 90, 0));
    strip.show();
    delay(500);
    return;
  }

  time_t t = time(nullptr);
  tm now;
  localtime_r(&t, &now);
  render(now);

  static Band lastLogged = (Band)255;
  Band band = bandAt(now.tm_hour * 60 + now.tm_min);
  if (band != lastLogged) {
    lastLogged = band;
    Serial.printf("[%02d:%02d] band -> %s (WiFi %s, IP %s)\n", now.tm_hour,
                  now.tm_min, BAND_NAME[band],
                  WiFi.status() == WL_CONNECTED ? "up" : "down",
                  WiFi.localIP().toString().c_str());
  }
  delay(1000);
}

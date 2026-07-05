// esp-tou — time-of-use electricity price indicator
//
// ESP32 DevKit + 1602 I2C LCD + Freenove 8x WS2812 RGB module.
// Syncs NZ time via WiFi/NTP, then shows the current tariff band:
//   LCD line 1: band name          e.g. "OFF-PEAK"
//   LCD line 2: clock + band end   e.g. "14:32 ends 17:00"
//   RGB bar: band colour, lit length = fraction of the band remaining.

#define FW_VERSION "3"  // bump on release; shown by GET / to verify OTA

#include <WiFi.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <ArduinoOTA.h>
#include <Wire.h>
#include <Preferences.h>
#include <LiquidCrystal_I2C.h>
#include <Adafruit_NeoPixel.h>
#include <time.h>
#include "secrets.h"

// ---------------- Hardware ----------------
constexpr int PIXEL_PIN   = 27;  // Freenove RGB module S pin
                                 // (not 16/17: WROVER uses those for PSRAM)
constexpr int PIXEL_COUNT = 8;
constexpr int PIXEL_OFFSET = 4;  // ring is mounted rotated half a turn
constexpr int SDA_PIN     = 21;
constexpr int SCL_PIN     = 22;

constexpr uint8_t DAY_BRIGHTNESS   = 40;   // 0-255
constexpr uint8_t NIGHT_BRIGHTNESS = 6;    // dim so it doesn't light the room
constexpr int NIGHT_DIM_FROM_MIN   = 21 * 60;  // 9pm
constexpr int NIGHT_DIM_UNTIL_MIN  = 7 * 60;   // 7am

// New Zealand, with daylight saving rules baked in
const char* TZ_INFO = "NZST-12NZDT,M9.5.0,M4.1.0/3";

// ---------------- Tariff schedule ----------------
enum Band : uint8_t { VERY_CHEAP, OFF_PEAK, PEAK };
// Shown on LCD line 1 — must fit in 16 characters
const char* BAND_NAME[] = {"Power very cheap", "Power is cheap", "Power expensive"};

// Each window runs from startMin until the next entry's start (midnight
// hands over to the next day's schedule). Entries must be sorted by
// startMin and each table must start at 0.
struct Window { uint16_t startMin; Band band; };
const Window WEEKDAY[] = {
  {0 * 60,  VERY_CHEAP},  // 12am - 7am
  {7 * 60,  PEAK},        // 7am - 11am
  {11 * 60, OFF_PEAK},    // 11am - 5pm
  {17 * 60, PEAK},        // 5pm - 9pm
  {21 * 60, OFF_PEAK},    // 9pm - 11pm
  {23 * 60, VERY_CHEAP},  // 11pm - 12am
};
const Window WEEKEND[] = {
  {0 * 60,  VERY_CHEAP},  // 12am - 7am
  {7 * 60,  OFF_PEAK},    // 7am - 11pm (no weekend peak)
  {23 * 60, VERY_CHEAP},  // 11pm - 12am
};
constexpr int MIN_PER_DAY  = 24 * 60;
constexpr int MIN_PER_WEEK = 7 * MIN_PER_DAY;

LiquidCrystal_I2C* lcd = nullptr;
Adafruit_NeoPixel strip(PIXEL_COUNT, PIXEL_PIN, NEO_GRB + NEO_KHZ800);
WebServer server(80);
Preferences prefs;

// Backlight mode (set via GET /backlight, persisted in NVS):
// false = auto (off unless an API message is showing), true = always on
bool backlightAlways = false;

// Message override state (set via GET /show)
String overrideText;
uint32_t overrideColor = 0xFFFFFF;  // 0xRRGGBB
uint32_t overrideUntil = 0;         // millis() deadline

bool overrideActive() {
  return overrideText.length() > 0 && (int32_t)(overrideUntil - millis()) > 0;
}

Band bandAt(int wday, int minuteOfDay) {
  bool weekend = (wday == 0 || wday == 6);  // tm_wday: 0=Sun, 6=Sat
  const Window* sched = weekend ? WEEKEND : WEEKDAY;
  const int n = weekend ? sizeof(WEEKEND) / sizeof(WEEKEND[0])
                        : sizeof(WEEKDAY) / sizeof(WEEKDAY[0]);
  Band b = sched[0].band;
  for (int i = 0; i < n; i++) {
    if (sched[i].startMin <= minuteOfDay) b = sched[i].band;
  }
  return b;
}

// weekMin: minutes since Sunday 00:00, so band scans can cross midnight
// into a day with a different schedule
Band bandAtWeek(int weekMin) {
  weekMin = ((weekMin % MIN_PER_WEEK) + MIN_PER_WEEK) % MIN_PER_WEEK;
  return bandAt(weekMin / MIN_PER_DAY, weekMin % MIN_PER_DAY);
}

// Minutes until the band changes to something different (merges adjacent
// windows of the same band, e.g. 11pm VERY_CHEAP flowing into 12am).
int minutesUntilBandEnd(int weekMin) {
  Band now = bandAtWeek(weekMin);
  for (int ahead = 1; ahead <= MIN_PER_WEEK; ahead++) {
    if (bandAtWeek(weekMin + ahead) != now) return ahead;
  }
  return MIN_PER_WEEK;  // single-band schedule
}

int minutesSinceBandStart(int weekMin) {
  Band now = bandAtWeek(weekMin);
  for (int back = 1; back <= MIN_PER_WEEK; back++) {
    if (bandAtWeek(weekMin - back) != now) return back - 1;
  }
  return 0;
}

// All pixel writes go through here so the ring's mounting rotation is
// corrected in one place
void setPixel(int i, uint32_t color) {
  strip.setPixelColor((i + PIXEL_OFFSET) % PIXEL_COUNT, color);
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
void setBacklight(bool on) {
  static int last = -1;
  if (lcd == nullptr) return;
  if ((int)on == last) return;
  last = (int)on;
  if (on) lcd->backlight(); else lcd->noBacklight();
}

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
// "2:32" style 12-hour clock — no room for am/pm on a 16-char line
String clock12(int hour, int minute) {
  int h = hour % 12;
  if (h == 0) h = 12;
  char buf[6];
  snprintf(buf, sizeof(buf), "%d:%02d", h, minute);
  return String(buf);
}

void showStatus(const String& l1, const String& l2) {
  lcdLine(0, l1);
  lcdLine(1, l2);
}

void render(const tm& now) {
  int minuteOfDay = now.tm_hour * 60 + now.tm_min;
  int weekMin = now.tm_wday * MIN_PER_DAY + minuteOfDay;
  Band band = bandAt(now.tm_wday, minuteOfDay);

  int remaining = minutesUntilBandEnd(weekMin);
  int elapsed   = minutesSinceBandStart(weekMin);
  int total     = remaining + elapsed;
  int endMin    = (minuteOfDay + remaining) % MIN_PER_DAY;

  lcdLine(0, BAND_NAME[band]);
  lcdLine(1, clock12(now.tm_hour, now.tm_min) + " ends " +
                 clock12(endMin / 60, endMin % 60));

  // auto mode: backlight only wakes for API messages (renderOverride)
  setBacklight(backlightAlways);

  // RGB bar: drains as the band runs out
  int lit = (remaining * PIXEL_COUNT + total - 1) / total;  // ceil
  lit = constrain(lit, 1, PIXEL_COUNT);
  strip.setBrightness(inNightDim(minuteOfDay) ? NIGHT_BRIGHTNESS
                                              : DAY_BRIGHTNESS);
  uint32_t c = bandColor(band);
  for (int i = 0; i < PIXEL_COUNT; i++) {
    setPixel(i, i < lit ? c : 0);
  }
  strip.show();
}

// ---------------- HTTP API ----------------
bool timeIsSet() {
  return time(nullptr) > 1700000000;  // any plausible current epoch
}

// Accepts "RRGGBB", "#RRGGBB", or a colour name. Yields 0xRRGGBB.
bool parseColor(String s, uint32_t& out) {
  s.trim();
  s.toLowerCase();
  if (s.startsWith("#")) s = s.substring(1);
  struct { const char* name; uint32_t c; } named[] = {
      {"red", 0xFF0000},    {"green", 0x00FF00},   {"blue", 0x0000FF},
      {"amber", 0xFF5A00},  {"orange", 0xFF5A00},  {"yellow", 0xFFC800},
      {"purple", 0x8000FF}, {"magenta", 0xFF00FF}, {"pink", 0xFF3060},
      {"cyan", 0x00FFFF},   {"white", 0xFFFFFF},
  };
  for (auto& n : named) {
    if (s == n.name) { out = n.c; return true; }
  }
  if (s.length() != 6) return false;
  char* end;
  out = strtoul(s.c_str(), &end, 16);
  return end == s.c_str() + 6;
}

// The HD44780 only renders ASCII sensibly
String asciiOnly(const String& s) {
  String out;
  for (unsigned i = 0; i < s.length(); i++) {
    char c = s[i];
    out += (c >= 32 && c <= 126) ? c : ' ';
  }
  return out;
}

void handleShow() {
  String text = server.hasArg("text") ? server.arg("text")
                                      : server.arg("message");
  text = asciiOnly(text).substring(0, 32);  // 2 LCD lines
  if (text.length() == 0) {
    server.send(400, "text/plain", "need ?text=... (up to 32 chars)\n");
    return;
  }

  long ttl = server.arg("ttl").toInt();
  if (ttl <= 0) ttl = 60;
  if (ttl > 604800L) ttl = 604800L;  // 7 days; keeps millis math wrap-safe

  String colorArg = server.hasArg("colour") ? server.arg("colour")
                                            : server.arg("color");
  uint32_t color = 0xFFFFFF;
  if (colorArg.length() > 0 && !parseColor(colorArg, color)) {
    server.send(400, "text/plain",
                "bad colour: RRGGBB hex or a name like red/green/amber\n");
    return;
  }

  overrideText = text;
  overrideColor = color;
  overrideUntil = millis() + (uint32_t)ttl * 1000;

  char resp[64];
  snprintf(resp, sizeof(resp), "ok: showing for %lds in #%06X\n", ttl,
           (unsigned)color);
  server.send(200, "text/plain", resp);
  Serial.printf("HTTP show: \"%s\" ttl=%lds colour=#%06X\n", text.c_str(),
                ttl, (unsigned)color);
}

void handleClear() {
  overrideText = "";
  overrideUntil = 0;
  server.send(200, "text/plain", "ok: cleared\n");
}

void handleBacklight() {
  String mode = server.arg("mode");
  if (mode == "always" || mode == "on") {
    backlightAlways = true;
  } else if (mode == "auto" || mode == "off") {
    backlightAlways = false;
  } else if (mode.length() > 0) {
    server.send(400, "text/plain", "mode must be 'always' or 'auto'\n");
    return;
  }
  if (mode.length() > 0) prefs.putBool("bl_always", backlightAlways);
  server.send(200, "text/plain", String("backlight: ") +
                                     (backlightAlways ? "always\n" : "auto\n"));
}

void handleRoot() {
  time_t t = time(nullptr);
  tm now;
  localtime_r(&t, &now);
  String t12 = clock12(now.tm_hour, now.tm_min) +
               (now.tm_hour < 12 ? "am" : "pm");
  char body[256];
  snprintf(body, sizeof(body),
           "esp-tou v" FW_VERSION "\nband: %s\ntime: %s\noverride: %s\n\n"
           "GET /show?text=hi&ttl=60&colour=amber (name or RRGGBB hex)\n"
           "GET /backlight?mode=always|auto\n"
           "GET /clear\n",
           timeIsSet() ? BAND_NAME[bandAt(now.tm_wday,
                                          now.tm_hour * 60 + now.tm_min)]
                       : "unknown (no time sync yet)",
           t12.c_str(), overrideActive() ? overrideText.c_str() : "none");
  server.send(200, "text/plain", body);
}

// Message on the LCD, one LED chasing around the bar per second
void renderOverride() {
  lcdLine(0, overrideText.substring(0, 16));
  lcdLine(1, overrideText.length() > 16 ? overrideText.substring(16)
                                        : String(""));
  setBacklight(true);  // a message is worth waking the screen for

  static uint32_t lastStep = 0;
  static int pos = 0;
  if (millis() - lastStep < 1000) return;
  lastStep = millis();

  time_t t = time(nullptr);
  tm now;
  localtime_r(&t, &now);
  strip.setBrightness(inNightDim(now.tm_hour * 60 + now.tm_min)
                          ? NIGHT_BRIGHTNESS : DAY_BRIGHTNESS);
  strip.clear();
  setPixel(pos, overrideColor);
  strip.show();
  pos = (pos + 1) % PIXEL_COUNT;
}

// mDNS and OTA can only start once WiFi is up, so retry from loop().
// OTA means the board never needs a USB data cable again (it's glued
// into its case) — flash with espota.py against port 3232.
void ensureMdns() {
  static bool started = false;
  if (started || WiFi.status() != WL_CONNECTED) return;
  started = MDNS.begin("esp-tou");
  if (!started) return;
  MDNS.addService("http", "tcp", 80);

  ArduinoOTA.setHostname("esp-tou");
  ArduinoOTA.setPassword(OTA_PASS);
  ArduinoOTA.setMdnsEnabled(false);  // we already run mDNS ourselves
  ArduinoOTA.onStart([]() {
    showStatus("Updating...", "");
    strip.clear();
    strip.show();
  });
  ArduinoOTA.begin();
  MDNS.enableArduino(3232, true);
}

// ---------------- Setup / loop ----------------

void setup() {
  Serial.begin(115200);

  prefs.begin("esp-tou", false);
  backlightAlways = prefs.getBool("bl_always", false);

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

  server.on("/", handleRoot);
  server.on("/show", handleShow);
  server.on("/clear", handleClear);
  server.on("/backlight", handleBacklight);
  server.begin();
}

void loop() {
  server.handleClient();
  ArduinoOTA.handle();
  ensureLcd();
  ensureMdns();

  if (!timeIsSet()) {
    static uint32_t lastBeat = 0;
    if (millis() - lastBeat >= 500) {
      lastBeat = millis();
      showStatus("esp-tou",
                 WiFi.status() == WL_CONNECTED ? "Syncing time..."
                                               : "WiFi: " WIFI_SSID);
      // amber "waiting" dot so the device visibly isn't dead
      strip.clear();
      setPixel(0, strip.Color(255, 90, 0));
      strip.show();
    }
    delay(2);
    return;
  }

  if (overrideActive()) {
    renderOverride();
  } else {
    static uint32_t lastRender = 0;
    if (millis() - lastRender >= 1000) {
      lastRender = millis();
      time_t t = time(nullptr);
      tm now;
      localtime_r(&t, &now);
      render(now);

      static Band lastLogged = (Band)255;
      Band band = bandAt(now.tm_wday, now.tm_hour * 60 + now.tm_min);
      if (band != lastLogged) {
        lastLogged = band;
        Serial.printf("[%02d:%02d] band -> %s (WiFi %s, IP %s)\n",
                      now.tm_hour, now.tm_min, BAND_NAME[band],
                      WiFi.status() == WL_CONNECTED ? "up" : "down",
                      WiFi.localIP().toString().c_str());
      }
    }
  }
  delay(2);  // keep handleClient responsive between renders
}

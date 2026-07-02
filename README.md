# esp-tou

A little USB-powered desk gadget that shows when electricity is cheap, built
from an ESP32 devkit, a 1602 I2C LCD, and a Freenove 8× RGB LED module.

It joins WiFi, syncs New Zealand time via NTP (DST handled automatically),
and then runs standalone — no server, no cloud.

## What it shows

- **LCD line 1**: current band — `POWER VERY CHEAP` / `POWER IS CHEAP` /
  `POWER EXPENSIVE` (16-char limit rules out longer wording)
- **LCD line 2**: clock and when the band ends — `2:32 ends 5:00`
  (12-hour, no am/pm)
- **RGB bar**: band colour (green / amber / red); the number of lit LEDs
  drains as the band runs out. Dims automatically 9pm–7am.
- **LCD backlight** is on during daylight only — sunrise/sunset are
  computed on-device from `LATITUDE`/`LONGITUDE` in the sketch (default:
  Wellington). The dimmed RGB bar still shows the band after dark. The
  backpack offers no software dimming beyond on/off — for a permanently
  subtler backlight, pull the jumper cap off the backpack's LED pins and
  bridge them with a ~1kΩ resistor instead.

## Tariff schedule

Same every day (edit `SCHEDULE` in `esp-tou.ino` to change):

| Window       | Band       | Colour |
|--------------|------------|--------|
| 11pm – 7am   | Very cheap | green  |
| 7am – 11am   | Peak       | red    |
| 11am – 5pm   | Off-peak   | amber  |
| 5pm – 9pm    | Peak       | red    |
| 9pm – 11pm   | Off-peak   | amber  |

## Wiring

**1602 LCD (I2C backpack)**

| LCD pin | ESP32 pin        |
|---------|------------------|
| GND     | GND              |
| VCC     | VIN (5V)         |
| SDA     | GPIO 21          |
| SCL     | GPIO 22          |

If the LCD shows solid blocks or nothing, adjust the contrast pot on the
back of the I2C backpack. The sketch auto-detects address 0x27 or 0x3F.

**Freenove 8 RGB LED module** — use the **IN** header only; the OUT header
is for daisy-chaining more modules.

| Module pin (IN) | ESP32 pin |
|-----------------|-----------|
| S               | GPIO 27   |
| V               | 3V3       |
| G               | GND       |

Powering the module from 3V3 keeps the data signal level in spec; at the
brightness this sketch uses, 8 LEDs are well within the regulator's budget.

## Build & flash

Requires `arduino-cli` with the `esp32:esp32` core, plus libraries
`LiquidCrystal I2C` and `Adafruit NeoPixel`:

```sh
arduino-cli core install esp32:esp32
arduino-cli lib install "LiquidCrystal I2C" "Adafruit NeoPixel"
```

WiFi credentials live in a gitignored header:

```sh
cp secrets.h.example secrets.h   # then fill in SSID + password
```

Compile and upload (CH340 boards can be flaky at high baud — this uses
115200):

```sh
arduino-cli compile --fqbn esp32:esp32:esp32 .
arduino-cli upload --fqbn esp32:esp32:esp32:UploadSpeed=115200 -p /dev/cu.usbserial-1110 .
```

Serial debug output at 115200 baud logs each band transition.

## HTTP API

Unauthenticated, LAN-only, port 80. The router's DHCP reservation locks
the device to **http://192.168.1.47**; mDNS also answers at
`http://esp-tou.local`.

| Route    | Params | Effect |
|----------|--------|--------|
| `/`      | —      | plain-text status + usage |
| `/show`  | `text` (≤32 ASCII chars), `ttl` (seconds, default 60, max 7 days), `colour` or `color` (name or `RRGGBB` hex, default white) | Takes over the LCD with the message and chases one LED per second around the bar in that colour until the TTL expires |
| `/clear` | —      | Ends the override early |

```sh
curl "http://192.168.1.47/show?text=Build%20passed&ttl=120&colour=green"
curl http://192.168.1.47/clear
```

Colour names: red, green, blue, amber/orange, yellow, purple, magenta,
pink, cyan, white.

## Behaviour notes

- Before the first successful time sync the LCD shows connection status and
  a single amber LED lights as a heartbeat.
- Once time is synced the clock free-runs even if WiFi drops; SNTP re-syncs
  in the background when it returns.
- Power it from any USB charger — the computer is only needed for flashing.

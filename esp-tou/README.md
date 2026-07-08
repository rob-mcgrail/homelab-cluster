# esp-tou

A little USB-powered desk gadget that shows when electricity is cheap, built
from an ESP32 devkit, a 1602 I2C LCD, and a Freenove 8× RGB LED module.

It joins WiFi, syncs New Zealand time via NTP (DST handled automatically),
and then runs standalone — no server, no cloud.

## What it shows

- **LCD line 1**: current band — `Power very cheap` / `Power is cheap` /
  `Power expensive` (16-char limit rules out longer wording)
- **LCD line 2**: clock and when the band ends — `2:32 ends 5:00`
  (12-hour, no am/pm)
- **RGB bar**: band colour (green / amber / red); the number of lit LEDs
  drains as the band runs out. Dims automatically 9pm–7am.
- **LCD backlight**: in the default `auto` mode it stays off, waking only
  while an API message is showing; `GET /backlight?mode=always` keeps it
  lit instead (setting persists across power cycles). (The backpack offers
  no software dimming beyond on/off — if you ever want a permanently
  subtler backlight, pull the jumper cap off the backpack's LED pins and
  bridge them with a ~1kΩ resistor.)

## Tariff schedule

Edit the `WEEKDAY` / `WEEKEND` tables in `esp-tou.ino` to change.

Weekdays:

| Window       | Band       | Colour |
|--------------|------------|--------|
| 11pm – 7am   | Very cheap | green  |
| 7am – 11am   | Peak       | red    |
| 11am – 5pm   | Off-peak   | amber  |
| 5pm – 9pm    | Peak       | red    |
| 9pm – 11pm   | Off-peak   | amber  |

Weekends (Sat/Sun) have no peak:

| Window       | Band       | Colour |
|--------------|------------|--------|
| 11pm – 7am   | Very cheap | green  |
| 7am – 11pm   | Off-peak   | amber  |

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

## Required packages (one-time setup)

```sh
brew install arduino-cli
arduino-cli core install esp32:esp32
arduino-cli lib install "LiquidCrystal I2C" "Adafruit NeoPixel"
```

`python3` is also needed for OTA pushes; `espota.py` and `esptool` ship
inside the esp32 core (under `~/Library/Arduino15/packages/esp32/`).

WiFi credentials and the OTA password live in a gitignored header:

```sh
cp secrets.h.example secrets.h   # then fill in SSID, password, OTA pass
```

## Deploying a release (OTA)

The board is glued into its case — all updates go over WiFi. From this
directory:

```sh
# 1. bump FW_VERSION at the top of esp-tou.ino, then:
arduino-cli compile --fqbn esp32:esp32:esp32 --export-binaries .

# 2. push to the device (port 3232):
python3 ~/Library/Arduino15/packages/esp32/hardware/esp32/*/tools/espota.py \
  -i 192.168.1.47 -p 3232 --auth="$(sed -n 's/.*OTA_PASS *"\(.*\)"/\1/p' secrets.h)" \
  -f build/esp32.esp32.esp32/esp-tou.ino.bin

# 3. verify the new version is running:
curl http://192.168.1.47/
```

Notes:

- espota works by the device connecting **back** to the sender, so the
  macOS firewall must allow Python to accept incoming connections.
  Alternatively run espota from any Linux box on the LAN — only the
  `.bin` and `espota.py` need copying over.
- A transfer that dies mid-stream (weak WiFi) is harmless: the device
  keeps running its current firmware. Just retry.

### USB fallback (first-ever flash or recovery)

If the firmware is bricked, OTA can't help — flash over USB with a
**data-capable** micro-USB cable (charge-only cables enumerate nothing):

```sh
arduino-cli compile --fqbn esp32:esp32:esp32 .
arduino-cli upload --fqbn esp32:esp32:esp32:UploadSpeed=115200 -p /dev/cu.usbserial-* .
```

Upload speed must stay at 115200 — the CH340 fails at higher rates.
Serial debug output at 115200 baud logs each band transition.

## HTTP API

Unauthenticated, LAN-only, port 80. The router's DHCP reservation locks
the device to **http://192.168.1.47**; mDNS also answers at
`http://esp-tou.local`.

| Route    | Params | Effect |
|----------|--------|--------|
| `/`      | —      | plain-text status + usage |
| `/show`  | `text` (≤64 ASCII chars), `ttl` (seconds, default 60, max 7 days), `colour` or `color` (name or `RRGGBB` hex, default white) | Takes over the LCD with the message, word-wrapped across the two 16-char lines; texts longer than one screen page every 2s. One LED chases around the bar per second in the colour until the TTL expires |
| `/clear` | —      | Ends the override early |
| `/backlight` | `mode` = `always` or `auto` (omit to just read the current mode) | `always` keeps the LCD backlit; `auto` lights it only while a message shows. Persists across power cycles |

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

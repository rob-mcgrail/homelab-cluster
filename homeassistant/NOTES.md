# Home Assistant — onboarding notes

This file lives at `/config/NOTES.md` inside the container, i.e.
`./homeassistant/NOTES.md` on the host. Read on the host; HA itself
doesn't render markdown.

---

## Current state (set up 2026-04-25)

- **Cameras integrated**: `Front door floodlight cam` + `Deck floodlight cam` via the Reolink integration.
- **Custom HA image** (`./homeassistant-image/Dockerfile`): adds Intel's `intel-media-driver` (iHD VAAPI userspace) and sets `LIBVA_DRIVER_NAME=iHD` so ffmpeg can hardware-decode/encode on the UHD 770 iGPU. Compose adds `/dev/dri:/dev/dri` and `group_add: ["993"]` (the host `render` group) so the container can talk to the device.
- **Automations** in `automations.yaml`:
  - *Floodlights: turn on when either cam detects person/vehicle* — gated on `sun.sun = below_horizon` and `input_boolean.floodlights_auto = on`.
  - *Floodlights: turn off after 2 min of no detection* — auto-off timer resets on every fresh detection.
  - *Record HD clip — front door / deck* — fires a 60s VAAPI ffmpeg clip on person/vehicle alerts. **Skipped during 7am–7pm when `binary_sensor.rob_home = on`** (we don't need clips of ourselves in our own house). Always records at night, or any time we're away.
  - *Bootstrap: default floodlights_auto to on* — first-boot only.
- **Scripts**: `panic_floodlights_and_sirens` — both floodlights on + both sirens on. Manual call only (Lovelace Floodlights dashboard, dashboard PANIC button).
- **Helpers**: `input_boolean.floodlights_auto` (master kill-switch for the auto-on rule), `binary_sensor.rob_home` (template, see below).

### Real entity IDs

| Purpose | Entity |
|---|---|
| Front person | `binary_sensor.front_door_floodlight_cam_person` |
| Front vehicle | `binary_sensor.front_door_floodlight_cam_vehicle` |
| Deck person | `binary_sensor.deck_floodlight_cam_person` |
| Deck vehicle | `binary_sensor.deck_floodlight_cam_vehicle` |
| Front floodlight | `light.front_door_floodlight_cam_floodlight` |
| Deck floodlight | `light.deck_floodlight_cam_floodlight` |
| All floodlights | `light.all_floodlights` (group of the two above) |
| Front siren | `siren.front_door_floodlight_cam_siren` |
| Deck siren | `siren.deck_floodlight_cam_siren` |
| Auto toggle | `input_boolean.floodlights_auto` |
| Rob home | `binary_sensor.rob_home` |

Substitute these into the API examples below if you copy from older
revisions of this file.

---

## HD clip recording pipeline

Each detection automation calls a `shell_command` (defined in
`configuration.yaml`) that runs `ffmpeg` against the cam's HEVC main
stream via go2rtc, scales + transcodes to H.264 1920p on the iGPU
(VAAPI), and writes a 60s MP4 to `/media/cam-recordings/<cam>/`.

```
HA event → shell_command.record_<cam> → ffmpeg (hwaccel vaapi) → MP4
```

Two non-obvious things to know:

1. **Detached invocation pattern** — `ffmpeg` is wrapped in `sh -c '... &'`. HA's `shell_command` integration has a hardcoded 60-second timeout with no per-command override; an undetached `ffmpeg -t 60` would be SIGKILL'd before it could finalize the MP4 (no `moov` atom = unplayable file). The detach makes the shell exit at ~0s; ffmpeg keeps running under PID 1 reparenting and writes a clean file.
2. **VAAPI not QSV** — Alpine doesn't package Intel's `oneVPL` runtime that QSV needs. Both target the same `iHD_drv_video.so` underneath, so VAAPI is functionally equivalent on UHD 770.

**`mode: single` + `delay: 45s`** in each automation gates re-triggers — at most one clip per cam per detection burst within a 45s window. Continuous activity (someone prowling for >45s) will produce sequential clips since the cam re-arms its `person` sensor on a similar cadence.

Files land at `/mnt/disk2/cam-recordings/{front_door,deck}/<UTC-timestamp>.mp4` (bind-mounted into HA at `/media/cam-recordings/` and into the dashboard at `/cam-recordings:ro`). Pruned daily by `scripts/cam-recordings-prune.sh` (3-day retention).

---

## Presence detection (`binary_sensor.rob_home`)

A template binary sensor that's `on` if **either** signal says we're
home — defined in `configuration.yaml`:

- `device_tracker.kochi` (the phone) reports `home` — GPS via the HA Companion app.
- `sensor.kochi_wi_fi_connection` reports the home SSID — also from the Companion app, more reliable than GPS for "definitely on the property".

OR'd together because GPS can briefly drift to `not_home` while you're
still inside, and WiFi can disconnect transiently. Either signal alone
keeps the sensor `on`.

**Companion app setup** (one-off, on each phone):
1. Install the [Home Assistant Companion app](https://www.home-assistant.io/integrations/mobile_app/) and sign in.
2. App → Settings → Companion app → **Manage sensors** → enable **Location sensor** and **WiFi Connection**.
3. Grant the OS-level "Allow all the time" / "Always" permission. On iOS also enable **Precise Location**.

Once on, the `device_tracker.<phone>` and `sensor.<phone>_wi_fi_connection`
entities will populate within ~30 seconds. The template will resolve
from `unknown` to `on` / `off` accordingly. Add more signals (NFC tag,
bluetooth, second phone) by extending the OR list in the template.

The clip-recording automations use it to skip daytime detections when
home — `condition: rob_home is off OR time is between 19:00–07:00`.

---

## Original setup steps (kept for reference / re-setup)

## 1. First-time onboarding

After `docker compose up -d homeassistant`, browse to
**https://ha.{DOMAIN}** (or `http://${LAN_IP}:8123` while bootstrapping).

- Create the admin user, set a strong password.
- Set your location (used for sunrise/sunset triggers later).
- Pick `metric` units, `12h` or `24h` clock as you prefer.
- Skip "Add devices" — you'll add Reolink in step 2.

## 2. Add the Reolink integration

For each camera:

- Settings → Devices & Services → **+ Add Integration** → search **Reolink**.
- Enter the camera's LAN IP, admin username, admin password.
- HA gives you a chance to set a friendly *device name* — this becomes
  the entity prefix (e.g. naming the camera `Front` produces
  `binary_sensor.front_person`, `light.front_floodlight`,
  `siren.front`, `camera.front_main`, etc).
- Repeat for the second camera (e.g. `Back`).

Confirm the entities exist by going to **Developer Tools → States** and
filtering by your camera names. You're looking for at minimum:
- `binary_sensor.<cam>_person`
- `binary_sensor.<cam>_vehicle`
- `light.<cam>_floodlight`
- `siren.<cam>`

## 3. Drop in the two automations

Replace `<cam_a>` and `<cam_b>` with your camera names below, then
paste into `automations.yaml` (or add via the UI's automation editor).

```yaml
- id: floodlights_on_when_either_cam_detects
  alias: "Floodlights: turn on when either cam detects person/vehicle"
  description: "Either cam sees a human or vehicle → both floodlights on."
  mode: single
  trigger:
    - platform: state
      entity_id:
        - binary_sensor.<cam_a>_person
        - binary_sensor.<cam_a>_vehicle
        - binary_sensor.<cam_b>_person
        - binary_sensor.<cam_b>_vehicle
      to: "on"
  action:
    - service: light.turn_on
      target:
        entity_id:
          - light.<cam_a>_floodlight
          - light.<cam_b>_floodlight

- id: floodlights_off_after_quiet_period
  alias: "Floodlights: turn off after 2 min of no detection"
  description: "Both floodlights off once both cams see neither person nor vehicle for 2 minutes. Subsequent detections reset the timer because the trigger requires the 'off' state to hold continuously."
  mode: single
  trigger:
    - platform: state
      entity_id:
        - binary_sensor.<cam_a>_person
        - binary_sensor.<cam_a>_vehicle
        - binary_sensor.<cam_b>_person
        - binary_sensor.<cam_b>_vehicle
      to: "off"
      for:
        minutes: 2
  condition:
    # Only fire when ALL of the detection sensors are off — otherwise a
    # quiet 2 minutes on cam_a alone would kill lights while cam_b is
    # still seeing someone.
    - condition: state
      entity_id: binary_sensor.<cam_a>_person
      state: "off"
    - condition: state
      entity_id: binary_sensor.<cam_a>_vehicle
      state: "off"
    - condition: state
      entity_id: binary_sensor.<cam_b>_person
      state: "off"
    - condition: state
      entity_id: binary_sensor.<cam_b>_vehicle
      state: "off"
  action:
    - service: light.turn_off
      target:
        entity_id:
          - light.<cam_a>_floodlight
          - light.<cam_b>_floodlight
```

The `for: minutes: 2` on the off-trigger means ALL detection sensors
must hold "off" for the full 2 minutes uninterrupted. Any new alert
from either camera resets the timer, which gives you the
"subsequent alerts extend the window" behaviour you wanted.

After pasting, hit **Settings → Reload YAML configuration → Reload
Automations** (or restart HA from the Developer Tools menu).

## 4. Long-lived access token (for API/button control)

- Profile (your user, bottom-left) → Long-Lived Access Tokens.
- Create a token, name it `homelab-curl` or similar.
- Copy it immediately — HA won't show it again.

Stash it in `.api_keys` alongside the others:

```sh
HASS_URL=http://localhost:8123   # for curl from the host
# HASS_URL=http://homeassistant:8123   # for the dashboard container (or any other docker service on the same network)
HASS_TOKEN=<paste>
```

### API examples

Both floodlights on:
```sh
curl -X POST "$HASS_URL/api/services/light/turn_on" \
  -H "Authorization: Bearer $HASS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entity_id": ["light.<cam_a>_floodlight","light.<cam_b>_floodlight"]}'
```

Both sirens on (panic):
```sh
curl -X POST "$HASS_URL/api/services/siren/turn_on" \
  -H "Authorization: Bearer $HASS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entity_id": ["siren.<cam_a>","siren.<cam_b>"]}'
```

Disable the auto-on automation (e.g. for a party):
```sh
curl -X POST "$HASS_URL/api/services/automation/turn_off" \
  -H "Authorization: Bearer $HASS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entity_id": "automation.floodlights_on_when_either_cam_detects"}'
```

## 5. Optional: dashboard buttons

Once you know the entity IDs, drop two buttons on the HA Lovelace
dashboard for one-tap control:

- **Settings → Dashboards → Overview → Edit** → + Add Card → Button.
- Tap action: `call-service` → `light.turn_on` / `siren.turn_on` →
  target both entities.
- Repeat for "all floodlights off".

The HA mobile companion app (iOS/Android) gives you the same buttons
on the lock screen via widgets/quick actions if you're feeling fancy.

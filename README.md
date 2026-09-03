# Personal Hydration Manager

[![HACS](https://img.shields.io/badge/HACS-Custom-41BDF5?style=flat-square)](https://github.com/hacs/integration)
[![Release](https://img.shields.io/github/v/release/loryanstrant/HA-Personal-Hydration-Manager?style=flat-square)](https://github.com/loryanstrant/HA-Personal-Hydration-Manager/releases)
[![Release date](https://img.shields.io/github/release-date/loryanstrant/HA-Personal-Hydration-Manager?style=flat-square)](https://github.com/loryanstrant/HA-Personal-Hydration-Manager/releases)
[![Downloads](https://img.shields.io/github/downloads/loryanstrant/HA-Personal-Hydration-Manager/total?style=flat-square)](https://github.com/loryanstrant/HA-Personal-Hydration-Manager/releases)
[![License](https://img.shields.io/github/license/loryanstrant/HA-Personal-Hydration-Manager?style=flat-square)](LICENSE)
[![Last commit](https://img.shields.io/github/last-commit/loryanstrant/HA-Personal-Hydration-Manager?style=flat-square)](https://github.com/loryanstrant/HA-Personal-Hydration-Manager/commits)
[![Stars](https://img.shields.io/github/stars/loryanstrant/HA-Personal-Hydration-Manager?style=flat-square)](https://github.com/loryanstrant/HA-Personal-Hydration-Manager/stargazers)

[![Open in HACS](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=loryanstrant&repository=HA-Personal-Hydration-Manager&category=integration)

A Home Assistant integration to track daily water intake for one or more people in your household, with a built-in dashboard card.

Targets are derived from the **National Academies of Sciences, Engineering, and Medicine (NASEM)** *Adequate Intake (AI) for Total Beverages* table — the baseline for **liquid** intake by age and gender, excluding the ~20% of water humans get from solid food.

| Age Group | Profile | Daily Target |
|-----------|---------|--------------|
| 1–3 years | All | 900 mL |
| 4–8 years | All | 1,200 mL |
| 9–13 years | Boys / Girls | 1,900 / 1,600 mL |
| 14–18 years | Boys / Girls | 2,600 / 1,800 mL |
| 19+ years | Men / Women | 3,000 / 2,200 mL |
| Pregnancy | Any age | 2,400 mL |
| Lactation | Any age | 3,000 mL |

> The NASEM AI is a population-level baseline. Individual needs vary with climate, activity, and health — treat the integration's target as guidance, not a medical recommendation.

## Features

- **Multiple profile support** — each household member can have their own config entry, sensors, and dashboard card.
- **Smart pace calculation** — dynamic catch-up across your **day start → day end** window: the recommended hourly pace adjusts to what you've already drunk and how many hours of that window remain, so it climbs if you fall behind.
- **Three card views, mix-and-match** — animated cup fill, countdown + pace, and one-tap manual add.
- **Visual card editor** with a preview tile in the dashboard card picker.
- **Two data input modes, both supported in the same config**:
  - **Source sensor** — point to any sensor that tracks today's consumed volume (e.g. [HA-HidrateSpark-Bluetooth-Proxy](https://github.com/loryanstrant/HA-HidrateSpark-Bluetooth-Proxy)).
  - **Events** — fire `personal_hydration_manager_drink` events from automations, scripts, or other integrations.
- **Services** for logging drinks, resetting the day, or setting an absolute consumed value.
- **Two automation blueprints** included — confirmation-required push notification, and a TTS reminder.
- **Metric default with mL ⇄ fl oz toggle** in the card editor.
- **Daily reset at local midnight**, persisted across HA restarts — so it agrees with a source sensor that counts a calendar day, and a 3am glass counts towards the day it happened.

<img width="521" height="420" alt="image" src="https://github.com/user-attachments/assets/5d6ba709-2798-47ec-b98f-a37cd73f2741" />

## Installation

### Via HACS (recommended)

1. Open HACS → Integrations → ⋮ → **Custom repositories**.
2. Add `https://github.com/loryanstrant/HA-Personal-Hydration-Manager` with type **Integration**.
3. Install **Personal Hydration Manager**, then **restart Home Assistant**.
4. Settings → Devices & Services → **Add Integration** → Personal Hydration Manager.

The dashboard card and blueprints are registered automatically — no manual resource step.

### Manual

Copy `custom_components/personal_hydration_manager/` into `<config>/custom_components/`, then restart HA.

## Configuration

Add one integration entry per person. Fields:

| Field | Notes |
|-------|-------|
| Name | Used for entity IDs, e.g. `sensor.phm_alex_consumed_today` |
| Age | Years |
| Gender | Male / Female — selects the matching NASEM row |
| Pregnancy | Overrides target to 2,400 mL |
| Lactation | Overrides target to 3,000 mL |
| Day start | When you want to start drinking. Opens the pace window — it does **not** reset the counter (that happens at midnight) |
| Day end | When you want to be finished. Closes the pace window |
| Source sensor (optional) | Sensor entity tracking consumed volume |
| Source mode | `absolute` (sensor state = today's total), `delta` (add only the increases), or `sum` (manual entries **+** how far the sensor has moved since the last reset) |

You can change any of these later via the integration's **Configure** button.

## Entities created per profile

All entities are prefixed with `phm_` so they group together in the entity list.

| Entity | Unit | Description |
|--------|------|-------------|
| `sensor.phm_<name>_daily_target` | mL | NASEM target (or override) |
| `sensor.phm_<name>_consumed_today` | mL | Total consumed today |
| `sensor.phm_<name>_manual_consumed` | mL | Total logged by hand today (services, card, blueprints) |
| `sensor.phm_<name>_remaining` | mL | Target − consumed (≥ 0) |
| `sensor.phm_<name>_hourly_pace` | mL/h | See **Pace** below. Attributes: `pace_ml_per_h`, `day_start`, `day_end` |
| `sensor.phm_<name>_progress` | % | `consumed / target` |
| `number.phm_<name>_target_override` | mL | Set > 0 to override NASEM; `0` to use NASEM |

### Pace

`sensor.phm_<name>_hourly_pace` answers "how fast do I need to drink?", and the answer depends on
where you are in the **day start → day end** window:

| When | Value |
|------|-------|
| Before day start | `remaining / (day_end − day_start)` — the steady rate across the whole window |
| Inside the window | `remaining / hours_left_until_day_end` — climbs if you fall behind |
| After day end | `remaining` — there is no rate left to quote, so the card says "catch up: X mL" |

The window changes only the **pace**. It never changes what counts: every drink lands on the
calendar day it happened, and the daily total resets at midnight.

## Services

### `personal_hydration_manager.log_drink`
Log a drink against a profile.

```yaml
service: personal_hydration_manager.log_drink
data:
  profile: alex          # name (slug) or config entry_id
  volume: 250
  unit: mL               # mL | L | fl_oz
```

### `personal_hydration_manager.reset_today`
Manually reset today's consumed total to 0.

```yaml
service: personal_hydration_manager.reset_today
data:
  profile: alex
```

### `personal_hydration_manager.set_consumed`
Set the consumed total to a specific value (useful for external trackers).

```yaml
service: personal_hydration_manager.set_consumed
data:
  profile: alex
  volume: 1200
  unit: mL
```

## Listening for drink events (third-party integrations)

Any integration can record a drink by firing this event:

```yaml
event_type: personal_hydration_manager_drink
event_data:
  profile: alex
  volume: 500
  unit: mL
```

The HidrateSpark proxy can be wired in either as the `source_sensor` (recommended), or by firing this event whenever it logs a sip.

## The dashboard card

After installation, open any dashboard, click **+ Add Card**, search for **Personal Hydration** — you'll see a live preview.

The percentage is drawn **inside the cup**, on the waterline, rather than in a row above it. It
changes colour as the water rises past it, so it stays readable at every fill level in both light
and dark themes. If you turn the cup off, the percentage moves back up to the card's header.

![The card at 45%](docs/images/percent-in-cup.png)

The visual editor exposes:

- Profile (which config entry)
- Toggle each view: **cup fill**, **countdown + pace**, **manual add**
- Quick-add buttons (default `200, 300, 500` mL)
- Unit display: mL (default) or fl oz

## Blueprints

Two blueprints are bundled with the integration and installed automatically the first time you add it:

- **`hydration_push_notification.yaml`** — sends a notification to a mobile device that requires the user to confirm they've had water (actionable notification).
- **`hydration_tts_reminder.yaml`** — speaks the current status via TTS — typically used with an hourly trigger.

They appear under **Settings → Automations & Scenes → Blueprints → Hydration —** after the integration is set up (a restart may be required for the blueprint folder to be re-scanned). You can also re-import them manually from `blueprints/automation/loryanstrant/` in this repo.

## Calculation reference

Targets are drawn from:

> Institute of Medicine (US) Panel on Dietary Reference Intakes for Electrolytes and Water. *Dietary Reference Intakes for Water, Potassium, Sodium, Chloride, and Sulfate.* Washington (DC): National Academies Press (US); 2005.

The NASEM AI represents *Total Beverages* — water from all liquid sources. The roughly 20% of daily water that humans get from solid food is **not** counted here, which is the right baseline for tracking what you drink.

## Development

<img width="256" height="256" alt="image" src="https://github.com/user-attachments/assets/ad5e2241-4bc4-45b4-876b-c12fbf62e2f1" />

## Contributing

Issues and PRs welcome on [GitHub](https://github.com/loryanstrant/HA-Personal-Hydration-Manager).

## Disclaimer

This integration is informational only. It is not a medical device and does not provide medical advice. Consult a clinician for personalised hydration guidance — especially for children, during pregnancy/lactation, or with any health condition.

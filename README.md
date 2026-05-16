# Personal Hydration Manager

[![hacs_badge](https://img.shields.io/badge/HACS-Custom-41BDF5.svg)](https://hacs.xyz)
![hacs validate](https://github.com/loryanstrant/HA-Personal-Hydration-Manager/actions/workflows/validate.yml/badge.svg)

A Home Assistant integration to track daily water intake for one or more people in your household, with a built-in Lovelace card.

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

- **One profile per person** — each household member gets their own config entry, sensors, and dashboard card.
- **Smart pace calculation** — dynamic catch-up: as the day progresses, the recommended hourly pace adjusts based on what you've already drunk and how many hours remain until your usual bedtime.
- **Three card views, mix-and-match** — animated cup fill, countdown + pace, and one-tap manual add.
- **Visual card editor** with a preview tile in the dashboard card picker.
- **Two data input modes, both supported in the same config**:
  - **Source sensor** — point to any sensor that tracks today's consumed volume (e.g. [HA-HidrateSpark-Bluetooth-Proxy](https://github.com/loryanstrant/HA-HidrateSpark-Bluetooth-Proxy)).
  - **Events** — fire `personal_hydration_manager_drink` events from automations, scripts, or other integrations.
- **Services** for logging drinks, resetting the day, or setting an absolute consumed value.
- **Two automation blueprints** included — confirmation-required push notification, and a TTS reminder.
- **Metric default with mL ⇄ fl oz toggle** in the card editor.
- **Daily reset at your configured start-of-day time**, persisted across HA restarts.

## Installation

### Via HACS (recommended)

1. Open HACS → Integrations → ⋮ → **Custom repositories**.
2. Add `https://github.com/loryanstrant/HA-Personal-Hydration-Manager` with type **Integration**.
3. Install **Personal Hydration Manager**, then **restart Home Assistant**.
4. Settings → Devices & Services → **Add Integration** → Personal Hydration Manager.

The dashboard card is registered automatically — no manual resource step.

### Manual

Copy `custom_components/personal_hydration_manager/` into `<config>/custom_components/`, then restart HA.

## Configuration

Add one integration entry per person. Fields:

| Field | Notes |
|-------|-------|
| Name | Used for entity IDs, e.g. `sensor.alex_consumed_today` |
| Age | Years |
| Gender | Male / Female — selects the matching NASEM row |
| Pregnancy | Overrides target to 2,400 mL |
| Lactation | Overrides target to 3,000 mL |
| Day start | When the daily counter resets |
| Day end | Used by the hourly-pace calculation |
| Source sensor (optional) | Sensor entity tracking consumed volume |
| Source mode | `absolute` (sensor state = today's total) or `delta` (sum the increases) |

You can change any of these later via the integration's **Configure** button.

## Entities created per profile

| Entity | Unit | Description |
|--------|------|-------------|
| `sensor.<name>_daily_target` | mL | NASEM target (or override) |
| `sensor.<name>_consumed_today` | mL | Total consumed today |
| `sensor.<name>_remaining` | mL | Target − consumed (≥ 0) |
| `sensor.<name>_hourly_pace` | mL/h | `remaining / hours_left_until_day_end` |
| `sensor.<name>_progress` | % | `consumed / target` |
| `number.<name>_target_override` | mL | Set > 0 to override NASEM; `0` to use NASEM |

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

The visual editor exposes:

- Profile (which config entry)
- Toggle each view: **cup fill**, **countdown + pace**, **manual add**
- Quick-add buttons (default `200, 300, 500` mL)
- Unit display: mL (default) or fl oz

## Blueprints

Two blueprints live in `blueprints/automation/loryanstrant/`:

- **`hydration_push_notification.yaml`** — sends a notification to a mobile device that requires the user to confirm they've had water (actionable notification).
- **`hydration_tts_reminder.yaml`** — speaks the current status via TTS — typically used with an hourly trigger.

Import via Settings → Automations → Blueprints → Import Blueprint, pasting the raw URL of each file.

## Calculation reference

Targets are drawn from:

> Institute of Medicine (US) Panel on Dietary Reference Intakes for Electrolytes and Water. *Dietary Reference Intakes for Water, Potassium, Sodium, Chloride, and Sulfate.* Washington (DC): National Academies Press (US); 2005.

The NASEM AI represents *Total Beverages* — water from all liquid sources. The roughly 20% of daily water that humans get from solid food is **not** counted here, which is the right baseline for tracking what you drink.

## Development

The card is shipped pre-built as a single vanilla-JavaScript Web Component (no build step required). Source lives in `custom_components/personal_hydration_manager/www/personal-hydration-card.js`.

## Contributing

Issues and PRs welcome on [GitHub](https://github.com/loryanstrant/HA-Personal-Hydration-Manager).

## Disclaimer

This integration is informational only. It is not a medical device and does not provide medical advice. Consult a clinician for personalised hydration guidance — especially for children, during pregnancy/lactation, or with any health condition.

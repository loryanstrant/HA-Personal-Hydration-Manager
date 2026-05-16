# Personal Hydration Manager

Track daily water intake against the **NASEM Adequate Intake (AI) for Total Beverages** baseline, broken down by age and gender.

## What you get

- A Home Assistant integration that exposes one profile **per person** with sensors for daily target, consumed, remaining, hourly pace, and progress.
- A Lovelace card with three composable views — animated cup fill, countdown of remaining volume + recommended pace, and one-tap manual logging — plus a visual editor and a preview tile in the card picker.
- Services to log drinks from automations, scripts, or other integrations (for example [HA-HidrateSpark-Bluetooth-Proxy](https://github.com/loryanstrant/HA-HidrateSpark-Bluetooth-Proxy)).
- Two automation blueprints — a confirmation-required push notification and a TTS reminder that announces how much you still need to drink.

The card is registered automatically as a dashboard resource — no manual resource setup required.

## Calculation source

Targets come from the **NASEM Adequate Intake for Total Beverages** table, which excludes the ~20% of water humans get from solid food and represents the daily target for *liquids only*. Pregnancy and lactation overrides are also included.

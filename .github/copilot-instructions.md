# Copilot instructions — HA-Personal-Hydration-Manager

> Canonical standards live in the `dev-standards` repo on SOUNDWAVE/Gitea.
> Read by Copilot chat **and** inline suggestions. For full HA build conventions,
> see the `build-ha-component` skill in dev-standards.

## What this repo is

A **Home Assistant custom component** for hydration tracking/reminders — domain
`personal_hydration_manager`. Coordinator-based; exposes `sensor` + `number`
entities, a bundled Lovelace card, and ships **automation blueprints** (push +
TTS reminders) that it can install.

## Repo shape

- `custom_components/personal_hydration_manager/` — `manifest.json`,
  `__init__.py`, `config_flow.py`, `const.py`, `coordinator.py`, `sensor.py`,
  `number.py`, `frontend.py`, `blueprints_install.py`, `services.yaml`,
  `strings.json`, `translations/`, `brand/`.
- `.../www/personal-hydration-card.js` — bundled card.
- Blueprints exist in **two** places: repo-root `blueprints/automation/loryanstrant/`
  and a copy under the component's `blueprints/`. Keep them in sync (the component
  installs from its bundled copy; the root copy is for import-by-URL).
- `hacs.json`, `info.md`, `.github/workflows/`.

## Conventions

- Bump `manifest.json` **version** every release (semver); `domain` matches the
  folder name.
- When you change a blueprint, update **both** copies so installed and
  import-by-URL stay identical.
- Test: `hassfest` + HACS validation, then `pytest` with
  `pytest-homeassistant-custom-component`.
- Deploy/test via the published release artifact into TEST1/TEST2, not host
  file-copy. Backup + auto-rollback.

## Never

- Don't commit HA long-lived tokens or deploy keys — Gitea Actions secrets only.

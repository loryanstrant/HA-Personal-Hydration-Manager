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
- `hacs.json`, `info.md`, `.github/workflows/`, `tests/` (packaging guards),
  `AGENTS.md` (the longer version of this file — keep the two in sync),
  `DECISIONS.md`.

## Conventions

- Bump `manifest.json` **version** every release (semver); `domain` matches the
  folder name. Bump `CARD_VERSION` in every bundled card **in lockstep**, even a
  card you did not touch. Enforced by `tests/test_packaging.py`.
- `translations/en.json` is a byte-for-byte copy of `strings.json`. Custom
  integrations read flow text from `translations/` at runtime, never from
  `strings.json` — anything only in `strings.json` renders as its raw key.
  Enforced by test.
- Every config/options-flow field carries a `data_description`. Enforced by test.
- When you change a blueprint, update **both** copies so installed and
  import-by-URL stay byte-identical, and keep every `source_url` pointing at the
  repo named in `manifest.json`'s `documentation`. Both enforced by test.
- The card editor is built on `ha-form` + selectors — never hand-built DOM, and
  never `innerHTML` in anything reachable from `set hass`. HA assigns `hass`
  several times a second and would destroy the control the user has open.
- Never call `customElements.whenDefined()` at module top level; HA swaps
  `window.customElements` for a scoped-registry polyfill while booting.
- Test: `hassfest` + HACS validation, then `pytest` with
  `pytest-homeassistant-custom-component`.
- Deploy/test via the published release artifact into TEST1/TEST2, not host
  file-copy. Backup + auto-rollback.

## Never

- Don't commit HA long-lived tokens or deploy keys — Gitea Actions secrets only.
- Don't create a release tag on GitHub. Gitea is canonical; tag there first, sync
  the mirror, then publish the GitHub release on the existing tag. The mirror
  prunes GitHub-only refs within 8 hours and takes the release with them.

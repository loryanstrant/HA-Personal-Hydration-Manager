# AGENTS.md — HA-Personal-Hydration-Manager

> Cross-tool agent instructions (Claude Code, Copilot agent mode).
> **Gotcha:** Copilot *inline* suggestions do NOT read this file — any rule that
> must hold for inline completions is mirrored into
> `.github/copilot-instructions.md`. Keep the two in sync.

## Project

Home Assistant custom component `personal_hydration_manager` — per-person water
intake tracking against the NASEM Adequate Intake table, with a bundled Lovelace
card and two automation blueprints. Canonical repo on SOUNDWAVE/Gitea; GitHub is
a one-way push mirror and the front door for external issues/releases.

## How to work here

- Use the `plan-before-coding`, `write-a-test-plan`, and `build-ha-component`
  skills (global, in `~/.copilot/skills/` — also available to Claude Code).
- Smallest shippable slice; one thing at a time.
- Record non-obvious decisions in `DECISIONS.md` in the same commit as the code.

## Repo shape

- `custom_components/personal_hydration_manager/` — the component.
- `.../www/personal-hydration-card.js` — the bundled card **and its editor**.
- Blueprints exist in **two** places: repo-root `blueprints/automation/loryanstrant/`
  and a copy under the component's `blueprints/`. The component installs from its
  bundled copy; the root copy is what an import-by-URL fetches.
- `tests/` — packaging guards. No Home Assistant instance needed; they run in a second.

## Rules with teeth

- **Bump `manifest.json` `version` (semver) on every release, and every bundled
  card's `CARD_VERSION` in lockstep** — even a card you did not touch.
  `tests/test_packaging.py` enforces this; it shipped wrong for two releases.
- **`translations/en.json` must be a byte-for-byte copy of `strings.json`.**
  Custom integrations read flow text from `translations/` at runtime, never from
  `strings.json`. Anything only in `strings.json` renders as its raw key — that
  shipped too, and the "Sum" source mode appeared in the dropdown as `sum`.
- **Every flow field carries a `data_description`.** A bare label is useless to a
  non-developer. Enforced by test.
- **When you change a blueprint, change both copies.** They must stay
  byte-identical, and every `source_url` must name the repo in `manifest.json`'s
  `documentation`. Both are enforced by test — the root copies carried the repo's
  pre-rename slug from the initial release until 0.2.0, so import-by-URL users had
  a blueprint whose update check 404'd.
- **The card editor is built on `ha-form` + selectors, never hand-built DOM.**
  Home Assistant assigns `hass` several times a second; anything that re-renders
  a subtree on `set hass` destroys the control the user has open. `ha-form` is
  created once and thereafter only `.hass`/`.schema`/`.data` are assigned.
- **Never call `customElements.whenDefined()` at module top level.** Home Assistant
  swaps `window.customElements` for a scoped-registry polyfill while booting, so a
  top-level binding may never fire. Re-read the registry on each call.

## Build / test / deploy

`hassfest` + HACS validate + `pytest` is the gate (all three run in
`.github/workflows/validate.yaml`). Smoke-test on `HomeAssistant-DEV`, then install
the **published release artifact** into TEST1/TEST2 the way a user would — never a
host copy of the working tree.

## Release order (load-bearing)

Gitea is canonical. Merge to Gitea `main` → create the tag **in Gitea first** →
sync the push mirror → confirm the tag on GitHub → only then publish the GitHub
release on that existing tag. A GitHub-only tag is force-deleted by the mirror's
prune within 8 hours, taking its release with it.

## Secrets

HA tokens and deploy keys live in Gitea Actions secrets — never in the repo.

# Decisions

Non-obvious choices and the reasoning behind them, newest first. Anything a future
reader would otherwise have to re-derive — or worse, quietly undo.

## 2026-08-23 — The two blueprint copies are reconciled, and guarded by tests

The blueprints ship twice: once at the repo root (what an import-by-URL fetches) and
once inside the component (what `blueprints_install.py` copies into the user's config).
They had drifted, in **both** files, since the initial release.

The only difference was `source_url`. The root copies named
`github.com/loryanstrant/personal-hydration-manager` — the repository's pre-rename
slug, which returns **404**. The bundled copies named
`HA-Personal-Hydration-Manager`, which returns **200**. Three bytes, invisible in
review, and exactly the 4395/4392 file-size difference. Git shows how: `f2cdac2`
created the root copies under the old name and `d529353` added the bundled copies
under the new one, without going back.

This is worse than "two slightly different automations". Home Assistant stores
`source_url` as an imported blueprint's identity and re-fetches it for *Re-import
blueprint*. Anyone who imported the root copy has a blueprint whose update check
points at a repository that does not exist, and it fails silently, forever. **The
bundled copy was correct**, so the root copies adopted its URL.

Two tests now hold the line, and the second one matters more than it looks:

- `test_the_two_blueprint_copies_have_not_drifted` byte-compares the pairs.
- `test_blueprint_source_url_points_at_this_repo` checks every `source_url` against
  the repo slug in `manifest.json`'s `documentation`. **Byte-equality alone is
  satisfied by making both copies wrong** — this is the test that actually catches
  the fault that happened.

Reading the blueprints needs a YAML loader that tolerates HA's `!input` tag;
`yaml.safe_load` refuses it outright. `_BlueprintLoader` reads any `!`-tag as its
plain scalar, which keeps the check structural rather than a regex over the text.

**Lesson:** when two copies of a file must match, byte-equality is necessary and not
sufficient. Also assert the property that made one of them correct.

## 2026-08-23 — This repo has packaging tests now, and they found three more faults

There was no test infrastructure at all: no `tests/`, no `pytest.ini`, and CI ran
only hassfest and HACS validation. Porting Laundry Weather's `tests/test_packaging.py`
took an afternoon and immediately failed on three things nobody had noticed:

- **`CARD_VERSION` was `0.1.12` while the manifest was `0.1.14`.** The card's console
  banner had been lying for two releases, so anyone troubleshooting from it was
  reading the wrong version number.
- **`translations/en.json` was missing the `sum` source-mode label.** Custom
  integrations load flow text from `translations/` at runtime, never from
  `strings.json`, so that option rendered in the live setup dropdown as the bare word
  `sum`. A one-line omission with a directly user-visible result.
- **All 20 config-flow fields had a bare label and no `data_description`.** "Source
  mode" with nothing explaining what absolute, delta and sum do to your total is not
  a question a non-developer can answer.

The guards are pure filesystem reads — no `hass` fixture, no `conftest.py`, and the
whole file runs in under a tenth of a second. That is the argument for having them:
they cost nothing per run and each one encodes a fault that actually shipped.

**Lesson:** the cheapest tests in a HACS repo are the ones that never start Home
Assistant. A packaging suite is worth writing on the day you need the first guard,
because it arrives carrying the rest.

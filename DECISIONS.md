# Decisions

Non-obvious choices and the reasoning behind them, newest first. Anything a future
reader would otherwise have to re-derive — or worse, quietly undo.

## 2026-08-23 — The card editor is built on `ha-form`

The editor was 110 lines of hand-built DOM producing seven browser-default controls inside a
Home Assistant dialog full of Material fields. They matched neither their neighbours nor the
active theme, because a raw `<select>` follows the browser's `color-scheme`, not HA's.

**The structural argument mattered more than the cosmetic one.** `set hass` assigned
`shadowRoot.innerHTML` unconditionally, and HA assigns `hass` several times a second — so any
control the user had open was destroyed underneath them. Laundry Weather shipped exactly that
bug and fixed it with an equality check before re-rendering, which is a *guard* a later edit can
undo. With `ha-form` the element is created once and thereafter only `.hass`, `.schema` and
`.data` are assigned; Lit patches in place and there is nothing to blow away.

**One inherited premise was wrong, and is worth recording as wrong.** This port was briefed as
also fixing a *copy* violation — "a `<select>` of entity IDs is the worst offender". True of
Laundry Weather; **not true here.** This card's `_profileOptions()` already labelled every option
`friendly_name.replace(" Daily target", "")`, so the dropdown already read "Testy McProfile". The
only raw identifier it could ever show was the `|| slug` fallback. The consistency and re-render
arguments carry this change on their own; the copy one did not need to be borrowed.

**The entity picker was built, rendered, and rejected on the evidence.** `include_entities` gave
exactly the old candidate set plus search and icons. But HA's entity picker leads with the
*entity's* name and puts the device beneath, so every row read **"Daily target"** with the person
in smaller text below — the wrong emphasis in the one field the change is about. Both variants
were rendered in real Home Assistant and compared side by side before choosing the named
dropdown. That also deleted a whole class of bug: the option values *are* the stored slugs, so
there is no entity-ID translation in either direction and the stored shape is untouched.

**Three version strings, not two.** `frontend.py` carries its own `CARD_VERSION` that stamps
`?v=` on the Lovelace resource URL. It had been left at 0.1.14. Behind the manifest, the resource
URL does not change between releases and browsers keep serving the card they already cached — the
update appears not to have landed. Now bumped in lockstep and guarded by
`test_the_cache_buster_matches_the_manifest`.

**Traps that cost a run each, all now handled in `scripts/verify-card-editor.mjs`:**

- `ha-entity-picker` renders *nothing* outside `<home-assistant>` — zero height, empty shadow
  root, no console error — because newer HA components take `hass` from a Lit context provider
  rather than a property. A harness that attaches to `document.body` silently tests a half-dead
  form while every other field renders fine.
- **Home Assistant discards foreign nodes from its shadow tree when it re-renders on resize.**
  Building the harness once and then resizing for the mobile screenshot loses the panel. Rebuild
  per viewport.
- The Lovelace resource loader races page load, so `customElements.get(...)` is intermittently
  undefined. Importing the served bundle directly with a cache-busting query is both
  deterministic and a stronger check — it proves the file on disk right now is the one under test.
- The frontend occasionally reloads mid-run and destroys the execution context. Retry once from a
  clean page rather than reporting a frontend hiccup as a failing assertion.

**Lesson:** a component that renders nothing is not obviously broken. When a UI check builds
elements outside their normal parent, assert that something rendered before trusting what did.

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

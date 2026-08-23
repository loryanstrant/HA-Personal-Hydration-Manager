# Spec — Card editor on `ha-form`

*Status: approved 2026-08-23.*

## Problem

The card's visual editor is 110 lines of hand-built DOM producing **seven browser-default
controls**: a `<select>` for the profile, four `<input type="checkbox">`, a second `<select>`
for units, and a text `<input>` for the quick-add volumes. It renders inside Home Assistant's
own card-configuration dialog, surrounded by HA Material fields, and looks like none of them —
different font metrics, different focus rings, different spacing, and it follows the browser's
`color-scheme` rather than the active Home Assistant theme.

Two `standards/ux.md` rules are broken by it:

- **Consistency** — *"reuse the app's existing primitives before inventing new ones; a new
  control matches the treatment of its neighbours."*
- **Copy** — *"no raw identifiers where a name would do."* The profile `<select>` is populated
  from entity IDs, in the one field a non-developer has to get right.

There is also a structural fault, and it matters more than the cosmetic one. `set hass` calls
`_render()`, which assigns `shadowRoot.innerHTML` unconditionally. Home Assistant assigns `hass`
several times a second, so **any control the user has open is destroyed underneath them**. The
sibling Laundry Weather card had exactly this bug — its clock-format dropdown flashed open and
shut — and fixed it in v0.3.1 with an equality check before re-rendering. That fix is a *guard*,
and a later edit to `_render()` can undo it.

`ha-form` removes the possibility rather than guarding it: the form element is created once and
thereafter only `.hass`, `.schema` and `.data` are assigned, so Lit patches in place and there is
no `innerHTML` to blow away.

## Scope

The **card** editor only — `personal-hydration-card-editor` inside
`custom_components/personal_hydration_manager/www/personal-hydration-card.js`. The card's own
rendering path is untouched by this change.

Not the integration's configuration screen — that is a Python config/options flow rendered by
Home Assistant itself, and it already uses `EntitySelector`, `NumberSelector`, `SelectSelector`
and `TimeSelector`.

Not the card's `+ Custom…` button, which opens a `window.prompt()`. That is the same
raw-primitive problem on the card rather than the editor, and it is handled separately.

## Constraints found before designing

**This is not a new pattern for this fleet.** `HA-Laundry-Weather` v0.4.0 and `ha-jokes` are the
in-house references: a labels map, a helpers map, one `ha-form`, and a `value-changed` listener
that stops the inner event and re-emits `config-changed`.

**The stored `profile` is a slug, not an entity ID.** This is the one place this card differs
materially from Laundry Weather. The config holds `profile: "loryan"`, from which the card
string-builds five entity IDs (`sensor.phm_loryan_daily_target` and friends). An entity picker
therefore needs a mapping in both directions — the same shape as Laundry Weather's tri-state
Klingon setting — so that the stored shape does not change and no dashboard needs migrating.

Deriving the slug from `entity_id` is exactly as robust as the card already is: `sensor.py:85`
pins `entity_id` to `sensor.phm_{slug}_{key}` and the card's whole read path depends on that
convention. This adds no new fragility.

**`include_entities` exists on the entity selector**, so the picker can offer exactly the
candidate set the old `<select>` produced — the `sensor.phm_*_daily_target` entities — while
gaining friendly names, icons and search.

**`ha-form` is only defined once Home Assistant has loaded its editor chunk.** Mushroom's
`loadHaComponents()` — calling `hui-tile-card.getConfigElement()` to force it — is the
community-canonical belt-and-braces.

**`customElements.whenDefined()` must not be called at module top level.** Home Assistant
replaces `window.customElements` with a scoped-registry polyfill while its core bundle boots, so
a top-level binding attaches to the native registry's method and may never fire.

**`quick_add` is stored in millilitres regardless of the display unit.** The card converts for
display, so in fl oz mode a stored `200` renders as a "+ 6.8 fl oz" button. Nothing in the
current editor says so. This is a live copy trap, not a new one.

**The editor's `setConfig` does not apply the card's defaults, but the card's does.** A config
omitting `show_cup` therefore shows the box unchecked while the card renders the cup — the
editor currently contradicts what the user can see.

## Flow

Unchanged for the user: *Edit card* → the same settings → changes apply live. What changes is
that the fields are Home Assistant's own, the profile is chosen by person's name rather than by
entity ID, the quick-add volumes are chips instead of a comma-separated string, and the dropdowns
open in an overlay layer instead of as native browser popups.

## Design

Approved layout: the four view toggles sit in an `ha-form` `type: "grid"`, preserving today's 2×2
block. HA's grid collapses to a single column below its breakpoint, so 380px needs no special
handling.

| field | selector | note |
|---|---|---|
| `profile` | `entity` with `include_entities` | friendly name + search |
| `title` | `text` | new — the card has a title row with no override |
| `show_title`, `show_cup`, `show_countdown`, `show_manual` | four `boolean` in one `grid` | today's 2×2 block |
| `unit` | `select`, dropdown | Metric (mL / L) · Imperial (fl oz) |
| `quick_add` | `select`, `multiple` + `custom_value` | chips; presets 150·200·250·330·500·750·1000, any number typeable |

### States

- **Empty** — with no profiles configured, `include_entities` is empty and HA shows a bare "no
  matching entities". The profile helper is replaced in that case with *"No hydration profiles
  yet — add one under Settings → Devices & Services → Personal Hydration Manager."*
- **Loading** — `_render()` returns until `hass` arrives. In the real dialog `hass` is present on
  the first assignment.
- **Error / stale profile** — if the stored slug resolves to no entity (integration removed,
  entity renamed), the picker maps it to `""`. Editing *any other field* would then emit
  `profile: ""` and silently clear it. The editor records whether the slug resolved; if it did
  not and the incoming picker value is also empty, the stored slug is kept.
- **380px** — verified by screenshot, not assumed.
- **Status** — no colour-only state anywhere in the editor.
- **Mobile parity** — no separate work. Home Assistant cards render in the companion app through
  the same frontend, so the 380px screenshot *is* the mobile check.

## Acceptance criteria

1. Every control is a Home Assistant component; **no raw `<select>` or `<input>` survives** in the
   editor.
2. The profile picker offers exactly the entities the old `_profileOptions()` filter produced —
   the `sensor.phm_*_daily_target` sensors — shown by friendly name, and searchable.
3. Every stored config key round-trips unchanged. `profile` remains a slug; a config written by
   the old editor loads and re-saves byte-identically, and no dashboard needs an edit.
4. Editing a field other than the profile never clears a profile whose entity is missing.
5. `quick_add` round-trips as an array of positive integers, in millilitres, and its helper text
   says so explicitly.
6. The `ha-form` element is the **same node object across 20 consecutive `hass` assignments**, and
   the editor still updates when the config genuinely changes.
7. The entity picker renders with non-zero height.
8. Screenshots at desktop and ~380px show the editor matching the surrounding HA fields.

## Non-goals

- The card's rendering path. Only the editor changes.
- The integration's config/options flow.
- Migrating stored configs. Nothing about the stored shape changes, so there is nothing to
  migrate.
- The `window.prompt()` behind `+ Custom…` — handled separately.

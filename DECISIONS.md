# Decisions

Non-obvious choices and the reasoning behind them, newest first. Anything a future
reader would otherwise have to re-derive — or worse, quietly undo.

## 2026-08-23 — The custom amount is typed on the card, not in a browser prompt

`+ Custom…` called `window.prompt()` — browser chrome that ignores the theme, cannot be styled,
and on a phone throws a system modal over everything to collect one number. It also could not
report a problem: a `parseFloat` failure and a non-positive number were both silently `return`ed,
so a mistyped amount looked exactly like a successful one.

The replacement is an inline field with **Add** and **Cancel**, styled as the card's own pills
rather than HA Material fields — the neighbours here are the quick-add pills, and the rule is to
match *your* neighbours.

**The hard part was survival, not layout.** `_render()` replaces the whole shadow subtree, HA
assigns `hass` several times a second, and a 30-second tick timer renders too. An input in that
subtree is destroyed by any of them, mid-typing. So `_render()` now returns early while the field
is open and replays the pending render on close. The figures freeze for the few seconds it is
open, which is a better trade than the field vanishing under the user's hands.

**A real bug the preview caught.** Focus has to be deferred by one frame. The button that opens
the field is removed by the same render, and the browser resets focus to `<body>` as that click
finishes — undoing a synchronous `focus()`. The first build looked fine in a screenshot and would
have shipped a field you had to tap twice. It only surfaced because the harness asserted
`shadowRoot.activeElement`, and the diagnostic that identified it was that a *second* `focus()`
call stuck when the first had not.

**Lesson:** "it appeared on screen" is not "it works". Assert the states you cannot see in a
screenshot — focus, what survives a re-render, what was *not* called.

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

## 2026-08-31 — The percentage moved into the cup, and needed two of itself to do it

The progress percentage lived in a header row. Moving it into the cup saves that row and puts the
number on the gauge it describes — but it introduces a problem the header version never had: **the
number's backdrop moves.** Above the waterline it sits on the card background, which is near-white
in a light theme and near-black in a dark one. Below it, on the water gradient. And the waterline
travels through the digits during the day.

No single fill colour survives that. The measurements, taken from the live DOM rather than guessed:

- Theme text colour is invisible on the water in a light theme.
- Bare white is **1.81:1** against the pale `#7ec8ff` at the water's surface — and mid-fill is
  exactly where the number sits. It is also invisible on a white card.
- Deep navy reads well on water but is **~1.5:1** on a dark card, so it cannot serve as the dry
  colour either.

So the number is drawn **twice**, at identical coordinates, each copy clipped to one side of the
waterline. `dry` takes `var(--primary-text-color)` and is correct in both themes for free; `wet` is
theme-independent because its backdrop is the water, which is the same blue in every theme. The
split lands exactly on the waterline, so a digit can be half one colour and half the other — which
is the effect a liquid gauge is expected to have, not an artefact.

The wet copy is white with a translucent dark halo, and **the halo is load-bearing**. Composited
over the water it gives the glyph a 3.94:1 boundary at the surface and 5.77:1 at the base. Delete
the halo and the number fails at exactly one fill range, which is the kind of regression that ships.
`scripts/verify-percent-in-cup.mjs` measures the halo specifically, not just "the text is white".

Two things only the pictures could settle, both from `scripts/mock-percent-in-cup.mjs` — which
renders the **real card file** with only `_renderCup()` patched, so it cannot flatter a design the
card would not actually produce:

- **The two-tone state is rare.** The digits span y≈101–129 and the waterline is at
  `180 − pct × 1.6`, so it only crosses them between ~32% and ~50%. The colour-split case that
  drove the whole design is a narrow band, not the normal state.
  *(Superseded in 0.3.1: that waterline formula was wrong at the bottom of the range and became
  `210 − pct × 1.9`, moving the band to ~43–58%. See the 2026-09-01 entry.)*
- **Neither candidate is smooth in both themes.** White+halo is seamless in dark (both halves
  near-white) and flips in light; navy is the reverse. There is no treatment that avoids a flip,
  because the dry copy must follow the theme and the wet copy must not.

**Lesson:** when a design question is "which of these looks right", render the real component and
look at it. Both candidates cleared the contrast thresholds on paper; the thing that actually
decided it — that the split is invisible in dark mode for one of them and not the other — is not
visible in a contrast ratio.

**Also:** the version bump has **three** sites, not two. `tests/test_packaging.py` caught
`frontend.py`'s cache-buster still at 0.2.0 after `manifest.json` and `CARD_VERSION` were both
moved to 0.3.0. That cache-buster is what busts a stale card bundle in the browser, so shipping it
wrong would have left users on the old card with no clue why.

## 2026-09-01 — An empty cup was drawing water, and five places recorded the wrong formula

The cup's interior runs from the rim at y=20 to its floor at **y=210**. The fill mapped 0% to
**y=180** — thirty units above the floor — so an untouched daily target still drew a band of water
across the bottom, about a sixth of the cup's height. The card said "0%" while the picture said
you had had a drink.

This was original code, not a regression from moving the percentage into the cup. But it survived
0.3.0 because the design mockups rendered 0% with that band and nobody, including the person who
made them, looked at the empty case and asked whether it was right. **A test suite that sweeps
20 / 35 / 45 / 70 / 100% never asks what nothing looks like.**

The fix is `210 − pct × 1.9`, plus a rule worth more than the arithmetic: **the picture agrees
with the number the card prints.**

- prints `0%` → no water element is emitted at all
- prints `1%` or more → the depth is floored at 4 units so it is always visible

Both sides key off the **rounded** percentage rather than the raw sensor value, and that is the
part that makes it hold. A profile at 0.4% prints "0%" and must therefore show nothing; one at
0.6% prints "1%" and must show something. Keying off the raw value would have reintroduced exactly
the reported fault at a smaller scale.

The wave amplitude now scales with depth (`min(6, depth / 2)`) — a fixed ±6 ripple on a 4-unit
puddle is deeper than the water it is rippling.

**The expensive part was not the fix.** The waterline formula, or the ~32–50% two-tone band it
implies, was written down in **five** places: the card, the verify script's assertion, the mock
harness's comment *and* its patched copy of `_renderCup`, the spec, and the previous DECISIONS
entry. Changing the card without the other four would have left four confident, wrong statements
for the next person to trust.

Two lessons, and the second is the one worth keeping:

- **Test the empty state.** It is the state every user sees first, on the day they install.
- **A duplicated implementation in a test harness is a liability the moment the design ships.**
  `mock-percent-in-cup.mjs` carried its own `_renderCup` so it could show two candidate colour
  treatments side by side. That was right while the design was a proposal and wrong the instant it
  landed: the copy would have gone on rendering the old geometry, flattering a card that no longer
  existed. It now renders the real card with nothing patched.

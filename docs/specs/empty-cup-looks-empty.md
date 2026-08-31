# Spec — An empty cup looks empty

*Status: approved 2026-09-01. Shipped in 0.3.1.*

## Problem

At 0% the cup drew a band of water across its bottom, so the card looked like you had had a drink
while the number beside it read **0%**.

The cup's interior runs from the rim at **y=20** to its floor at **y=210**, but the fill mapped 0%
to **y=180** — thirty viewBox units above the floor, about **a sixth of the cup's height**. 100%
was correct (y=20 *is* the rim), so only the low end was wrong.

```js
const fillY = 180 - (progressPct / 100) * 160;   // 0% -> y=180, but the floor is y=210
```

This was original code, not a regression from moving the percentage into the cup. It survived
0.3.0 because the design mockups rendered 0% *with* that band and nobody looked at the empty case
and asked whether it was right. A sweep of 20 / 35 / 45 / 70 / 100% never asks what nothing looks
like.

## The rule

**The picture agrees with the number the card prints.**

- prints **0%** → no water is drawn at all
- prints **1% or more** → the water is always at least a visible sliver

Both sides key off the **rounded** percentage, not the raw sensor value, and that is what makes the
rule hold rather than merely patching the reported case. A profile at 0.4% prints "0%" and must
therefore show nothing; one at 0.6% prints "1%" and must show something. Keying off the raw value
would have reintroduced the same fault at a smaller scale.

## Design

```js
const CUP_FLOOR = 210, CUP_RIM = 20, MIN_DEPTH = 4;
const hasWater = Number(pct) > 0;                       // pct is the ROUNDED, displayed value
const depth = hasWater ? Math.max(MIN_DEPTH, (progressPct / 100) * (CUP_FLOOR - CUP_RIM)) : 0;
const fillY = CUP_FLOOR - depth;
const wave  = Math.min(6, depth / 2);
```

- When `hasWater` is false the water `<g>` is **not emitted at all**, rather than drawn with zero
  height. The dry copy of the number then renders whole and `wetClip` collapses to a strip below
  the cup floor containing nothing.
- `MIN_DEPTH` is 4 viewBox units ≈ 3px — the smallest sliver that reads as water.
- The wave amplitude scales with depth. A fixed ±6 ripple on a 4-unit puddle is deeper than the
  water it is rippling; at a normal fill it reaches its full 6 and looks exactly as before.

### The knock-on

Moving the baseline moves the band in which the waterline crosses the digits, which span y≈101–129:

| | Waterline | Two-tone band |
|---|---|---|
| 0.3.0 | `180 − pct × 1.6` | ~32–50% |
| 0.3.1 | `210 − pct × 1.9` | **~43–58%** |

That figure was recorded in **five** places — the card, the verify script's assertion, the mock
harness's comment *and* its own copy of `_renderCup`, the spec, and `DECISIONS.md`. All had to move
together or four confident, wrong statements would have been left for the next reader.

### States

- **0%** — empty cup, number entirely in the theme's text colour.
- **1–2%** — floored sliver, gentle ripple.
- **43–58%** — waterline crosses the digits; the number is two-toned.
- **100%** — water to the rim, unchanged from 0.3.0.
- **Cup switched off** — the percentage falls back to the header, unchanged.
- **Mobile parity** — none needed; HA cards render in the companion app through the same frontend.

## Acceptance criteria

1. At 0% no water element exists in the DOM and the waterline sits on the cup floor (y=210).
2. A raw 0.4% prints "0%" and draws nothing; a raw 0.6% prints "1%" and draws a sliver.
3. Anything printing ≥1% has a water depth of at least 4 units.
4. 100% still fills to the rim (y=20).
5. The clips still split exactly on the waterline at every level, including the empty one.
6. Every previously verified property still holds — contrast, `100%` width, accessibility, the
   cup-off fallback.
7. `manifest.json`, `CARD_VERSION` and `frontend.py`'s cache-buster all read the same version.

## Non-goals

- The cup's shape, gradient, or the wave at normal fill levels.
- The percentage's size, position or colours — settled in
  [percent-inside-cup.md](percent-inside-cup.md).
- Any change to how the sensors compute progress.

## What shipped

![The card at 45%, the number split on the waterline](../images/percent-in-cup.png)

![100% at 380px](../images/percent-in-cup-380.png)

Verified by `scripts/verify-percent-in-cup.mjs` against real Home Assistant — **18/18**, sweeping
0, 0.4, 0.6, 1, 2, 20, 43, 45, 50, 57, 70 and 100%:

| Fill | Prints | Water | Waterline |
|---|---|---|---|
| 0 | `0%` | **none** | y=210 (floor) |
| 0.4 | `0%` | **none** | y=210 |
| 0.6 | `1%` | 4.0u | y=206 |
| 2 | `2%` | 4.0u | y=206 |
| 45 | `45%` | 85.5u | y=125 |
| 100 | `100%` | 190u | y=20 (rim) |

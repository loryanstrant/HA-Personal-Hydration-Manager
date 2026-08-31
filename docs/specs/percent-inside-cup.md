# Spec — The percentage is displayed inside the cup

*Status: approved 2026-08-31.*

## Problem

The progress percentage sits in a header row at the top of the card — `Loryan · · · 42%` when the
name is shown, or a right-aligned `42%` on a row of its own when it isn't. That row costs vertical
space on a card that is already tall, and it puts the number somewhere other than the thing it
describes: the cup right below it is a percentage gauge with no percentage on it.

Moving the number into the cup saves the row and reads more directly.

## Constraint that shapes the design

**The number's background moves.** Above the waterline it sits on the card background — which is
near-white in a light theme and near-black in a dark one. Below the waterline it sits on the water
gradient, `#7ec8ff` at the surface down to `#2196f3` at the base. And the waterline travels
through the digits as the day goes on.

No single fill colour works. Theme text colour is invisible against the water in a light theme;
white is invisible against the card in a light theme and measures only ~1.8:1 against the pale
`#7ec8ff` right at the waterline, which is exactly where the number sits at mid-fill.

The cup is also **narrow**: `viewBox="0 0 200 220"` rendered at 160×180px, with an interior width
of roughly 100 viewBox units (~80 real px) at mid-height. `100%` is the widest string the card can
ever show and is the case that sets the font size.

## Design

The number is drawn **twice**, at identical coordinates, each copy clipped to one side of the
waterline:

```html
<clipPath id="dryClip"><rect x="0" y="0"        width="200" height="${fillY}"/></clipPath>
<clipPath id="wetClip"><rect x="0" y="${fillY}" width="200" height="${220 - fillY}"/></clipPath>
...
<text x="100" y="129" class="hyd-pct dry" clip-path="url(#dryClip)">42%</text>
<text x="100" y="129" class="hyd-pct wet" clip-path="url(#wetClip)">42%</text>
```

- **`dry`** takes `var(--primary-text-color)`, so it follows light and dark themes for free.
- **`wet`** is theme-independent, because its background is the water and the water is the same
  blue in every theme. The exact treatment (white with a translucent dark halo, or deep navy) is
  chosen from rendered mockups rather than argued from contrast maths alone — both clear AA for
  large bold text; the question is which one looks right.

The split lands exactly on the waterline, so a digit can be half one colour and half the other.
That is the effect a liquid-fill gauge is expected to have, not an artefact.

Both clip-path ids are safe to hard-code: every card renders in its own shadow root.

### What moves and what doesn't

- **Only the percentage moves.** The `646 mL / 3.00 L` caption stays beneath the cup.
- The name row is unchanged when `show_title` is on; it simply no longer carries a number.
- The standalone right-aligned percentage row (`show_title: false`) is **deleted** — that is the
  row the change buys back.

### States

- **0%** — the number sits entirely on the empty cup, in theme text colour.
- **Mid-fill** — the waterline runs through the digits and the number is two-toned.
- **100%** — the number sits entirely on water; the widest string against the narrowest part of
  the cup it must fit.
- **Cup switched off** (`show_cup: false`) — there is nowhere to put the number, so it **falls
  back to the header** exactly as it renders today. Turning the cup off must never silently cost
  someone their percentage.
- **380px** — the cup is a fixed 160px so nothing reflows; the check is that `100%` does not
  collide with the cup walls and the card gains no horizontal scroll.
- **Errors** — the "pick a profile" and "no hydration profile found" cards are untouched.
- **Status without colour** — the percentage is a number, never a colour-coded state. The two text
  colours are a legibility device, not a signal; nothing is encoded in which one you see, so the
  colour-blindness rule is satisfied by construction.
- **Mobile parity** — none needed. Home Assistant cards render in the companion app through the
  same frontend, so the 380px screenshot *is* the mobile check.

### Accessibility

The cup SVG is `aria-hidden="true"` today, which is correct only while the number is real text
somewhere else. Once the number moves inside, the SVG takes `role="img"` and an `aria-label`
carrying the figure in words — `"42% of today's target — 646 mL of 3.00 L"`. The percentage must
not leave the accessibility tree just because it left the header.

## Acceptance criteria

1. With `show_cup: true`, no percentage appears in the header; the cup SVG carries it.
2. The number renders as exactly two `<text>` nodes, clipped above and below, splitting at `fillY`.
3. At 0%, 42%, 55% and 100% the number is legible against whatever is behind it, measuring ≥ 3:1
   for both copies against their actual backdrop (AA for large bold text).
4. `100%` fits inside the cup walls with clearance at 380px — no clipped or overlapping glyphs.
5. The cup SVG carries `role="img"` and an `aria-label` naming the percentage; `aria-hidden` is gone.
6. With `show_cup: false`, the percentage returns to the header, in both `show_title` states.
7. Correct in light **and** dark themes.
8. `manifest.json` `version` and `CARD_VERSION` are bumped in lockstep.

## Non-goals

- The amounts caption. It stays under the cup; folding it inside too was considered and declined.
- A percentage that rides the waterline as a moving level marker. Considered and declined.
- A new editor toggle. The percentage lives in the cup whenever the cup is shown.
- The cup's own geometry, gradient and wave animation, which are unchanged.
- The countdown, pace and quick-add rows, which are untouched.

## What shipped

*Screenshots added when the change is verified.*

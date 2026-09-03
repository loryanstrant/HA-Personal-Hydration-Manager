/*!
 * Personal Hydration Card
 * https://github.com/loryanstrant/HA-Personal-Hydration-Manager
 * MIT License
 *
 * A single-file vanilla web component — no build step required.
 * Renders any combination of three views (cup fill, countdown, manual add)
 * and exposes a visual editor via <hui-form>.
 */

const CARD_TAG = "personal-hydration-card";
const EDITOR_TAG = "personal-hydration-card-editor";
const CARD_VERSION = "0.4.0";

const ML_PER_FL_OZ = 29.5735;

// Shared by the card and its editor. The editor used to omit these, so a
// config written without `show_cup` showed the box unchecked while the card
// rendered the cup — the editor contradicted what you could see.
const DEFAULTS = {
  profile: "",
  show_title: true,
  show_cup: true,
  show_countdown: true,
  show_manual: true,
  unit: "mL",
  quick_add: [200, 300, 500],
};

// The integration pins entity_id to sensor.phm_<slug>_<key> (see sensor.py),
// and the card string-builds all five of its entities from the stored slug.
// The editor reads this pair back to find the profiles that exist.
const PROFILE_PREFIX = "sensor.phm_";
const PROFILE_SUFFIX = "_daily_target";

function mlToDisplay(ml, unit) {
  if (unit === "fl_oz") return (ml / ML_PER_FL_OZ).toFixed(1);
  if (ml >= 1000) return (ml / 1000).toFixed(2);
  return Math.round(ml).toString();
}

function unitLabel(unit, ml) {
  if (unit === "fl_oz") return "fl oz";
  return ml >= 1000 ? "L" : "mL";
}

function paceLabel(ml, unit) {
  if (unit === "fl_oz") return `${(ml / ML_PER_FL_OZ).toFixed(1)} fl oz/h`;
  return `${Math.round(ml)} mL/h`;
}

function fireEvent(node, type, detail) {
  const event = new Event(type, { bubbles: true, composed: true });
  event.detail = detail ?? {};
  node.dispatchEvent(event);
}

/* ---------- The card ---------- */

class PersonalHydrationCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = null;
    this._hass = null;
    this._tickTimer = null;
    // Inline custom-amount entry, replacing the browser prompt() box.
    this._customOpen = false;
    this._customValue = "";
    this._customError = "";
    this._renderPending = false;
    // Dirty-check key for the last shadow-DOM rebuild. See _render().
    this._lastRenderKey = null;
  }

  static getStubConfig(hass) {
    const profiles = Object.values(hass?.entities || {})
      .filter((e) => e.entity_id?.startsWith("sensor.phm_") && e.entity_id.endsWith("_daily_target"))
      .map((e) => e.entity_id.replace("sensor.phm_", "").replace("_daily_target", ""));
    return {
      type: `custom:${CARD_TAG}`,
      profile: profiles[0] || "",
      show_title: true,
      show_cup: true,
      show_countdown: true,
      show_manual: true,
      unit: "mL",
      quick_add: [200, 300, 500],
    };
  }

  static async getConfigElement() {
    return document.createElement(EDITOR_TAG);
  }

  setConfig(config) {
    if (!config) throw new Error("Invalid configuration");
    this._config = { ...DEFAULTS, ...config };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
    if (!this._tickTimer) {
      // re-render every 30s so countdown/pace stays fresh between coordinator pushes
      this._tickTimer = setInterval(() => this._render(), 30_000);
    }
  }

  disconnectedCallback() {
    if (this._tickTimer) {
      clearInterval(this._tickTimer);
      this._tickTimer = null;
    }
  }

  getCardSize() {
    let size = this._config?.show_title === false ? 0 : 1;
    if (this._config?.show_cup) size += 3;
    if (this._config?.show_countdown) size += 1;
    if (this._config?.show_manual) size += 1;
    return Math.max(size, 1);
  }

  _state(entity_id) {
    return this._hass?.states?.[entity_id];
  }

  _render(force) {
    if (!this._config || !this._hass) return;

    // The custom-amount field is a live input inside this subtree, and this
    // method replaces the subtree wholesale. Home Assistant assigns `hass`
    // several times a second and the tick timer fires every 30s, so rendering
    // while it is open would destroy it mid-typing. Hold off until it closes,
    // then catch up. The figures freeze for the few seconds it is open, which
    // is a better trade than the field vanishing under the user's hands.
    if (this._customOpen && !force) {
      this._renderPending = true;
      return;
    }
    this._renderPending = false;

    const profile = this._config.profile;
    if (!profile) {
      this._renderError("Pick a profile in the card editor.", force);
      return;
    }

    const targetEntity = `sensor.phm_${profile}_daily_target`;
    const consumedEntity = `sensor.phm_${profile}_consumed_today`;
    const remainingEntity = `sensor.phm_${profile}_remaining`;
    const paceEntity = `sensor.phm_${profile}_hourly_pace`;
    const progressEntity = `sensor.phm_${profile}_progress`;

    const target = this._state(targetEntity);
    const consumed = this._state(consumedEntity);
    const remaining = this._state(remainingEntity);
    const pace = this._state(paceEntity);
    const progress = this._state(progressEntity);

    if (!target || !consumed) {
      this._renderError(
        `No hydration profile found for "${profile}". Have you added the integration?`,
        force
      );
      return;
    }

    const unit = this._config.unit || "mL";
    const targetMl = Number(target.state) || 0;
    const consumedMl = Number(consumed.state) || 0;
    const remainingMl = Number(remaining?.state) || Math.max(targetMl - consumedMl, 0);
    const paceMl = Number(pace?.state) || 0;
    const progressPct = Math.min(100, Math.max(0, Number(progress?.state) || 0));

    const name = target.attributes?.friendly_name?.split(" ")[0] || profile;

    const showTitle = this._config.show_title !== false;

    // The percentage is drawn inside the cup. With the cup switched off there
    // is nowhere to put it, so it falls back to the header exactly as it used
    // to render — turning the cup off must not silently cost you the number.
    const showCup = !!this._config.show_cup;
    const pctText = `${progressPct.toFixed(0)}%`;

    // Dirty-check before touching the DOM. Home Assistant reassigns `hass`
    // several times a second across the whole dashboard — most of those
    // pushes touch no entity this card reads — and the 30s tick in `set
    // hass` fires on the same schedule regardless of whether anything
    // changed. Every one of those used to tear down and rebuild the entire
    // shadow DOM (the full <style> block plus the SVG cup), which is what
    // measured as ~0.8 of a CPU core, continuously, on a completely static
    // dashboard (SHOCKWAVE wall panel, 2026-09-01). Skip the rebuild
    // whenever nothing the markup actually depends on has moved. `force`
    // (used to reopen/close/confirm the inline custom-amount field) always
    // bypasses this, since those transitions must be reflected immediately.
    const renderKey = JSON.stringify([
      profile,
      targetMl,
      consumedMl,
      remainingMl,
      paceMl,
      progressPct,
      name,
      showTitle,
      showCup,
      this._config.show_countdown,
      this._config.show_manual,
      unit,
      this._config.quick_add,
      this._customOpen,
      this._customValue,
      this._customError,
    ]);
    if (!force && renderKey === this._lastRenderKey) return;
    this._lastRenderKey = renderKey;

    this.shadowRoot.innerHTML = `
      ${this._styles()}
      <ha-card>
        <div class="hyd-root">
          ${showTitle ? `
            <header class="hyd-header">
              <div class="hyd-name">${name}</div>
              ${showCup ? "" : `<div class="hyd-percent">${pctText}</div>`}
            </header>
          ` : showCup ? "" : `
            <div class="hyd-percent-only">${pctText}</div>
          `}

          ${showCup ? this._renderCup(progressPct, unit, consumedMl, targetMl) : ""}
          ${this._config.show_countdown ? this._renderCountdown(remainingMl, paceMl, unit) : ""}
          ${this._config.show_manual ? this._renderManual(unit) : ""}
        </div>
      </ha-card>
    `;

    if (this._config.show_manual) this._wireManualButtons();
  }

  _renderError(msg, force) {
    // Same dirty-check as _render(): an entity that stays missing/unavailable
    // would otherwise still rebuild the whole subtree on every `hass` push.
    const renderKey = `error:${msg}`;
    if (!force && renderKey === this._lastRenderKey) return;
    this._lastRenderKey = renderKey;

    this.shadowRoot.innerHTML = `
      ${this._styles()}
      <ha-card><div class="hyd-root"><div class="hyd-error">${msg}</div></div></ha-card>
    `;
  }

  _renderCup(progressPct, unit, consumedMl, targetMl) {
    const pct = progressPct.toFixed(0);

    // The cup's interior runs from the rim at y=20 to its floor at y=210. The
    // fill used to start at y=180 — thirty units up from the floor — so an
    // untouched target still drew a band of water across the bottom and the
    // card looked like you had drunk something while reading "0%".
    //
    // The rule now is that the picture agrees with the number the card prints:
    // "0%" draws no water at all, and anything that prints 1% or more always
    // shows at least a visible sliver. Both sides of that key off the ROUNDED
    // percentage rather than the raw value, which is the part that makes it
    // hold — 0.4% prints "0%" and must show nothing, 0.6% prints "1%" and must
    // show something.
    const CUP_FLOOR = 210;
    const CUP_RIM = 20;
    const MIN_DEPTH = 4; // ~3px on screen: the smallest sliver that reads as water
    const hasWater = Number(pct) > 0;
    const depth = hasWater
      ? Math.max(MIN_DEPTH, (progressPct / 100) * (CUP_FLOOR - CUP_RIM))
      : 0;
    const fillY = CUP_FLOOR - depth;
    // The wave swings +/-6 units around the surface. On a 4-unit puddle that
    // ripple would be deeper than the water, so it scales down with the fill
    // and only reaches its full amplitude on a reasonably full cup.
    const wave = Math.min(6, depth / 2);
    // The percentage used to be a header row. It now lives in the cup, which
    // means its backdrop moves: card background above the waterline, water
    // below it, and the waterline travels through the digits during the day.
    // No single fill colour survives that, so the number is drawn twice and
    // each copy is clipped to one side of the line. The split lands exactly on
    // the waterline, so a digit can be half one colour and half the other.
    //
    // The dry copy takes the theme's text colour and so is correct in light and
    // dark for free. The wet copy is theme-independent because its backdrop is
    // the water, which is the same blue in every theme.
    const number = `${pct}<tspan class="hyd-pct-sign">%</tspan>`;
    // The SVG can no longer be aria-hidden: it now carries the only copy of a
    // figure that used to be real text.
    const label =
      `${pct}% of today's target — ` +
      `${mlToDisplay(consumedMl, unit)} ${unitLabel(unit, consumedMl)} of ` +
      `${mlToDisplay(targetMl, unit)} ${unitLabel(unit, targetMl)}`;
    return `
      <div class="hyd-cup-wrap">
        <svg viewBox="0 0 200 220" class="hyd-cup" role="img" aria-label="${label}">
          <defs>
            <clipPath id="cupClip">
              <path d="M40,20 L160,20 L150,200 Q150,210 140,210 L60,210 Q50,210 50,200 Z" />
            </clipPath>
            <clipPath id="dryClip">
              <rect x="0" y="0" width="200" height="${fillY}" />
            </clipPath>
            <clipPath id="wetClip">
              <rect x="0" y="${fillY}" width="200" height="${220 - fillY}" />
            </clipPath>
            <linearGradient id="waterGrad" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stop-color="#7ec8ff" />
              <stop offset="100%" stop-color="#2196f3" />
            </linearGradient>
          </defs>
          <path d="M40,20 L160,20 L150,200 Q150,210 140,210 L60,210 Q50,210 50,200 Z"
                fill="none" stroke="var(--primary-text-color, #333)" stroke-width="3" />
          ${hasWater ? `
          <g clip-path="url(#cupClip)" class="hyd-water">
            <rect x="0" y="${fillY}" width="200" height="220" fill="url(#waterGrad)">
              <animate attributeName="y" from="${fillY + 4}" to="${fillY}" dur="1.2s" fill="freeze" />
            </rect>
            <path d="M0,${fillY} Q25,${fillY - wave} 50,${fillY} T100,${fillY} T150,${fillY} T200,${fillY} V220 H0 Z"
                  fill="url(#waterGrad)" opacity="0.7">
              <animate attributeName="d"
                values="M0,${fillY} Q25,${fillY - wave} 50,${fillY} T100,${fillY} T150,${fillY} T200,${fillY} V220 H0 Z;
                        M0,${fillY} Q25,${fillY + wave} 50,${fillY} T100,${fillY} T150,${fillY} T200,${fillY} V220 H0 Z;
                        M0,${fillY} Q25,${fillY - wave} 50,${fillY} T100,${fillY} T150,${fillY} T200,${fillY} V220 H0 Z"
                dur="3s" repeatCount="indefinite" />
            </path>
          </g>` : ""}
          <text x="100" y="129" class="hyd-pct hyd-pct-dry" clip-path="url(#dryClip)">${number}</text>
          <text x="100" y="129" class="hyd-pct hyd-pct-wet" clip-path="url(#wetClip)">${number}</text>
        </svg>
        <div class="hyd-cup-caption">
          ${mlToDisplay(consumedMl, unit)} <span class="u">${unitLabel(unit, consumedMl)}</span>
          <span class="muted"> / ${mlToDisplay(targetMl, unit)} ${unitLabel(unit, targetMl)}</span>
        </div>
      </div>
    `;
  }

  _renderCountdown(remainingMl, paceMl, unit) {
    return `
      <div class="hyd-countdown">
        <div class="hyd-stat">
          <div class="hyd-stat-value">${mlToDisplay(remainingMl, unit)}<span class="u"> ${unitLabel(unit, remainingMl)}</span></div>
          <div class="hyd-stat-label">left today</div>
        </div>
        <div class="hyd-stat">
          <div class="hyd-stat-value">${paceLabel(paceMl, unit)}</div>
          <div class="hyd-stat-label">to stay on track</div>
        </div>
      </div>
    `;
  }

  _renderManual(unit) {
    const buttons = (this._config.quick_add || DEFAULTS.quick_add)
      .map(
        (mlValue) => `
        <button type="button" class="hyd-btn" data-volume="${mlValue}">
          + ${mlToDisplay(mlValue, unit)} ${unitLabel(unit, mlValue)}
        </button>
      `
      )
      .join("");

    if (!this._customOpen) {
      return `
        <div class="hyd-manual">
          ${buttons}
          <button type="button" class="hyd-btn hyd-btn-custom" data-custom="1">
            + Custom…
          </button>
        </div>
      `;
    }

    // The word, not the symbol — "fl oz" and "mL" both read as themselves.
    const word = unit === "fl_oz" ? "fl oz" : "mL";
    return `
      <div class="hyd-manual">
        ${buttons}
      </div>
      <div class="hyd-custom" role="group" aria-label="Add a custom amount">
        <div class="hyd-custom-field">
          <input type="number" id="hyd-custom-amount" class="hyd-custom-input"
                 inputmode="decimal" min="0" step="any" autocomplete="off"
                 aria-label="Amount in ${word}"
                 aria-invalid="${this._customError ? "true" : "false"}" />
          <span class="hyd-custom-unit" aria-hidden="true">${word}</span>
        </div>
        <button type="button" class="hyd-btn" data-confirm="1">Add</button>
        <button type="button" class="hyd-btn hyd-btn-custom" data-cancel="1">Cancel</button>
      </div>
      ${this._customError ? `<div class="hyd-custom-error" role="alert">${this._customError}</div>` : ""}
    `;
  }

  _wireManualButtons() {
    const root = this.shadowRoot;
    root.querySelectorAll(".hyd-btn").forEach((btn) => {
      btn.addEventListener("click", () => this._handleManualClick(btn));
    });

    const field = root.getElementById("hyd-custom-amount");
    if (!field) return;
    field.value = this._customValue ?? "";
    field.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this._confirmCustom();
      } else if (event.key === "Escape") {
        event.preventDefault();
        this._closeCustom();
      }
    });
    // Remember what has been typed, so a re-render after closing (or an error)
    // does not silently discard it.
    field.addEventListener("input", () => { this._customValue = field.value; });

    // Focus on the next frame, not now. The button that opened this field was
    // removed by the same render, and the browser resets focus to <body> as
    // that click finishes — which would undo a synchronous focus() here and
    // leave the user having to tap the field a second time.
    requestAnimationFrame(() => field.focus());
  }

  _openCustom() {
    this._customOpen = true;
    this._customError = "";
    this._customValue = "";
    this._render(true);
  }

  _closeCustom() {
    this._customOpen = false;
    this._customError = "";
    this._customValue = "";
    this._render();
  }

  async _confirmCustom() {
    const parsed = parseFloat(this._customValue);
    if (!isFinite(parsed) || parsed <= 0) {
      this._customError = "Enter a number bigger than zero.";
      this._render(true);
      return;
    }
    const volumeMl = this._config.unit === "fl_oz" ? parsed * ML_PER_FL_OZ : parsed;
    this._customOpen = false;
    this._customError = "";
    this._customValue = "";
    this._render();
    await this._logDrink(volumeMl);
  }

  async _handleManualClick(btn) {
    if (btn.dataset.custom) {
      this._openCustom();
      return;
    }
    if (btn.dataset.cancel) {
      this._closeCustom();
      return;
    }
    if (btn.dataset.confirm) {
      await this._confirmCustom();
      return;
    }

    btn.classList.add("hyd-btn-busy");
    try {
      await this._logDrink(Number(btn.dataset.volume));
    } finally {
      setTimeout(() => btn.classList.remove("hyd-btn-busy"), 400);
    }
  }

  async _logDrink(volumeMl) {
    const profile = this._config.profile;
    if (!profile || !this._hass) return;
    await this._hass.callService("personal_hydration_manager", "log_drink", {
      profile,
      volume: volumeMl,
      unit: "mL",
    });
  }

  _styles() {
    return `
      <style>
        ha-card { overflow: hidden; }
        .hyd-root { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
        .hyd-header {
          display: flex; align-items: baseline; justify-content: space-between;
        }
        .hyd-name { font-weight: 600; font-size: 1.1rem; }
        .hyd-percent { font-size: 1.25rem; font-weight: 700; color: var(--primary-color, #2196f3); }
        .hyd-percent-only {
          font-size: 1.25rem; font-weight: 700; color: var(--primary-color, #2196f3);
          text-align: right;
        }
        .hyd-cup-wrap { display: flex; flex-direction: column; align-items: center; gap: 4px; }
        .hyd-cup { width: 160px; height: 180px; }

        /* The percentage inside the cup. Sizes are in viewBox units, so they
           hold at every rendered width. The cup walls are only ~106 units
           apart at this height and "100%" is the widest string the card can
           draw, which is what sets the size and the smaller sign. */
        .hyd-pct {
          font-size: 40px; font-weight: 700;
          text-anchor: middle; letter-spacing: -1px;
        }
        .hyd-pct-sign { font-size: 22px; }
        .hyd-pct-dry { fill: var(--primary-text-color, #212121); }
        /* White alone measures ~1.8:1 against the pale #7ec8ff at the water's
           surface — which is exactly where the number sits at mid-fill. The
           halo is what makes it readable there, not decoration. */
        .hyd-pct-wet {
          fill: #ffffff;
          paint-order: stroke;
          stroke: rgba(0, 42, 71, 0.42);
          stroke-width: 3px;
          stroke-linejoin: round;
        }
        .hyd-cup-caption { font-size: 0.95rem; }
        .hyd-cup-caption .u { font-size: 0.8rem; opacity: 0.7; }
        .hyd-cup-caption .muted { color: var(--secondary-text-color, #888); }
        .hyd-countdown {
          display: grid; grid-template-columns: 1fr 1fr; gap: 12px;
          padding: 8px 4px; border-top: 1px solid var(--divider-color, #e0e0e0);
          border-bottom: 1px solid var(--divider-color, #e0e0e0);
        }
        .hyd-stat { text-align: center; }
        .hyd-stat-value { font-size: 1.4rem; font-weight: 700; }
        .hyd-stat-value .u { font-size: 0.85rem; font-weight: 400; opacity: 0.7; }
        .hyd-stat-label { font-size: 0.8rem; color: var(--secondary-text-color, #888); }
        .hyd-manual { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; }
        .hyd-btn {
          appearance: none; border: none; cursor: pointer;
          background: var(--primary-color, #2196f3); color: #fff;
          padding: 8px 14px; border-radius: 16px; font-size: 0.95rem; font-weight: 500;
          transition: transform 0.1s ease, opacity 0.2s ease;
        }
        .hyd-btn:hover { transform: translateY(-1px); }
        .hyd-btn:active { transform: translateY(0); }
        .hyd-btn-busy { opacity: 0.5; pointer-events: none; }
        .hyd-btn-custom {
          background: var(--secondary-background-color, #555);
          color: var(--primary-text-color, #fff);
        }
        .hyd-error { color: var(--error-color, #db4437); text-align: center; }

        /* Inline custom amount. Wraps to its own rows at narrow widths rather
           than overflowing — the field keeps a sane minimum and the two
           buttons drop beneath it. */
        .hyd-custom {
          display: flex; flex-wrap: wrap; gap: 8px;
          align-items: center; justify-content: center;
        }
        .hyd-custom-field {
          display: flex; align-items: center; gap: 6px; flex: 1 1 140px;
          min-width: 120px; max-width: 220px;
          border: 1px solid var(--divider-color, #ccc); border-radius: 16px;
          padding: 4px 12px;
          background: var(--card-background-color, #fff);
        }
        .hyd-custom-field:focus-within {
          border-color: var(--primary-color, #2196f3);
          box-shadow: 0 0 0 1px var(--primary-color, #2196f3);
        }
        .hyd-custom-input {
          flex: 1 1 auto; width: 100%; min-width: 0;
          border: none; outline: none; background: none;
          color: var(--primary-text-color, #000);
          font: inherit; font-size: 0.95rem; padding: 4px 0;
          -moz-appearance: textfield;
        }
        .hyd-custom-input::-webkit-outer-spin-button,
        .hyd-custom-input::-webkit-inner-spin-button {
          -webkit-appearance: none; margin: 0;
        }
        .hyd-custom-unit {
          font-size: 0.8rem; color: var(--secondary-text-color, #888); flex: 0 0 auto;
        }
        .hyd-custom-error {
          font-size: 0.8rem; text-align: center;
          color: var(--error-color, #db4437);
        }
      </style>
    `;
  }
}

/* ---------- Visual editor ----------
 *
 * Built on ha-form and Home Assistant's selectors rather than hand-built DOM.
 * Two reasons, one cosmetic and one structural. The editor renders inside HA's
 * card dialog surrounded by Material fields, and raw <select>/<input> match
 * neither them nor the active theme. And the hand-built version assigned
 * shadowRoot.innerHTML on every `set hass` — which HA fires several times a
 * second — so any control the user had open was destroyed underneath them.
 * Here the form element is created once and thereafter only .hass, .schema and
 * .data are assigned, so Lit patches in place and there is nothing to blow away.
 */

const EDITOR_LABELS = {
  profile: "Person",
  title: "Card title (optional)",
  show_title: "Show the name",
  show_cup: "Show the cup",
  show_countdown: "Show the countdown and pace",
  show_manual: "Show the quick-add buttons",
  unit: "Units",
  quick_add: "Quick-add buttons",
};

// ha-form renders the raw key name when it cannot find a label, so this map is
// required rather than decorative.
const EDITOR_HELPERS = {
  profile: "Whose hydration this card shows. Profiles come from the Personal Hydration Manager integration.",
  title: "Leave blank to use the person's name.",
  quick_add: "Always in millilitres, even when the card is showing fluid ounces.",
};

const NO_PROFILES_HELPER =
  "No hydration profiles yet — add one under Settings → Devices & Services → Personal Hydration Manager.";

// Bare numbers, not "200 mL": a typed-in custom value renders as whatever was
// typed, so a unit suffix on the presets alone makes the chip row read
// "200 mL · 300 · 500 mL". The unit is stated once, in the helper text.
// The card's three defaults are all in here so the common case is a tap.
const QUICK_ADD_PRESETS = [150, 200, 250, 300, 330, 500, 750, 1000];

/** The select selector deals in strings; the config stores integers. */
function normaliseQuickAdd(values) {
  const list = (Array.isArray(values) ? values : [])
    .map((value) => parseInt(String(value).trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  return list.length ? list : [...DEFAULTS.quick_add];
}

function editorSchema(candidates) {
  return [
    // A named list, not an entity picker. You are choosing a person from the
    // household, and HA's entity picker leads with the entity's own name — so
    // every row would read "Daily target" with the person relegated to the
    // second line, which is the opposite emphasis from the one that matters.
    // The options carry the stored slug as their value, so nothing has to be
    // translated on the way in or out.
    { name: "profile", selector: { select: { mode: "dropdown", options: candidates } } },
    { name: "title", selector: { text: {} } },
    {
      name: "",
      type: "grid",
      schema: [
        { name: "show_title", selector: { boolean: {} } },
        { name: "show_cup", selector: { boolean: {} } },
        { name: "show_countdown", selector: { boolean: {} } },
        { name: "show_manual", selector: { boolean: {} } },
      ],
    },
    {
      name: "unit",
      selector: { select: { mode: "dropdown", options: [
        { value: "mL", label: "Metric (mL / L)" },
        { value: "fl_oz", label: "Imperial (fl oz)" },
      ] } },
    },
    {
      name: "quick_add",
      selector: { select: {
        multiple: true,
        custom_value: true,
        options: QUICK_ADD_PRESETS.map((ml) => ({ value: String(ml), label: String(ml) })),
      } },
    },
  ];
}

/**
 * Force the frontend chunk that defines ha-form and the entity picker.
 *
 * In practice the editor is only ever built from the card dialog, which has
 * already loaded that chunk — but this is Mushroom's belt-and-braces and costs
 * nothing. `window.customElements` is re-read on every call rather than
 * captured: Home Assistant swaps it for a scoped-registry polyfill while its
 * core bundle boots, which is also why this must never be
 * `customElements.whenDefined()` at module top level — that would bind to the
 * native registry's method and might never fire.
 */
function loadHaComponents() {
  const registry = window.customElements;
  if (!registry.get("ha-form")) {
    const tile = registry.get("hui-tile-card");
    if (tile && tile.getConfigElement) tile.getConfigElement();
  }
  if (!registry.get("ha-entity-picker")) {
    const entities = registry.get("hui-entities-card");
    if (entities && entities.getConfigElement) entities.getConfigElement();
  }
}

class PersonalHydrationCardEditor extends HTMLElement {
  // Light DOM, matching the sibling laundry-weather and ha-jokes cards: the
  // dialog styles the editor's own children, and the entity picker reads
  // `hass` from a Lit context provider further up the tree.
  constructor() {
    super();
    this._config = null;
    this._hass = null;
    this._form = null;
  }

  setConfig(config) {
    this._config = { ...DEFAULTS, ...config };
    this._render();
  }

  // Safe to render on every tick, unlike the hand-built version this replaced:
  // nothing is destroyed, the form just receives new values.
  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  connectedCallback() {
    loadHaComponents();
  }

  /** The configured profiles, as {value: slug, label: person's name}. */
  _candidates() {
    if (!this._hass) return [];
    const states = this._hass.states || {};
    return Object.keys(states)
      .filter((id) => id.startsWith(PROFILE_PREFIX) && id.endsWith(PROFILE_SUFFIX))
      .sort()
      .map((id) => ({
        value: id.slice(PROFILE_PREFIX.length, id.length - PROFILE_SUFFIX.length),
        // friendly_name is "<Person> Daily target"; the sensor's own name is
        // noise here. Falls back to the entity ID if it has been renamed.
        label: (states[id].attributes?.friendly_name || id).replace(/ Daily target$/, ""),
      }));
  }

  _schema() {
    // Rebuilt only when the candidate list actually changes, so ha-form is not
    // handed a fresh array object on every state update.
    const candidates = this._candidates();
    const key = candidates.map((c) => `${c.value}:${c.label}`).join(",");
    if (!this._schemaCache || this._schemaKey !== key) {
      this._schemaKey = key;
      this._schemaCache = editorSchema(candidates);
    }
    return this._schemaCache;
  }

  _formData() {
    const data = { ...this._config };
    // The select speaks strings; the config stores integers.
    data.quick_add = normaliseQuickAdd(this._config.quick_add).map(String);
    return data;
  }

  _label(schema) {
    return EDITOR_LABELS[schema.name] || "";
  }

  _helper(schema) {
    if (schema.name === "profile" && this._candidates().length === 0) {
      return NO_PROFILES_HELPER;
    }
    return EDITOR_HELPERS[schema.name] || "";
  }

  _render() {
    // ha-form needs hass to resolve its selectors, so wait for it.
    if (!this._hass || !this._config) return;

    if (!this._form) {
      const form = document.createElement("ha-form");
      form.computeLabel = (schema) => this._label(schema);
      form.computeHelper = (schema) => this._helper(schema);
      form.addEventListener("value-changed", (event) => this._onValueChanged(event));
      this.appendChild(form);
      this._form = form;
    }

    this._form.hass = this._hass;
    this._form.schema = this._schema();
    this._form.data = this._formData();
  }

  _onValueChanged(event) {
    // Stop the inner event so only our config-changed reaches the editor host.
    event.stopPropagation();
    const value = { ...event.detail.value };

    // A profile whose sensors have gone (integration removed, entity renamed)
    // matches no option, so the dropdown renders blank. Without this, editing
    // any *other* field would read that blank as the user clearing the profile
    // and silently drop it. Only restore when the stored value is genuinely
    // unrepresentable — clearing a profile that IS in the list is honoured.
    if (!value.profile && this._config.profile) {
      const known = this._candidates().some((c) => c.value === this._config.profile);
      if (!known) value.profile = this._config.profile;
    }

    value.quick_add = normaliseQuickAdd(value.quick_add);

    this._config = value;
    fireEvent(this, "config-changed", { config: value });
  }
}

/* ---------- Registration ---------- */

if (!customElements.get(CARD_TAG)) {
  customElements.define(CARD_TAG, PersonalHydrationCard);
}
if (!customElements.get(EDITOR_TAG)) {
  customElements.define(EDITOR_TAG, PersonalHydrationCardEditor);
}

window.customCards = window.customCards || [];
if (!window.customCards.find((c) => c.type === CARD_TAG)) {
  window.customCards.push({
    type: CARD_TAG,
    name: "Personal Hydration",
    description: "Track daily water intake per person.",
    preview: true,
    documentationURL:
      "https://github.com/loryanstrant/HA-Personal-Hydration-Manager#the-dashboard-card",
  });
}

console.info(
  `%c PERSONAL-HYDRATION-CARD %c v${CARD_VERSION} `,
  "color:white;background:#2196f3;font-weight:700;border-radius:3px 0 0 3px;padding:2px 6px",
  "color:#2196f3;background:#e3f2fd;border-radius:0 3px 3px 0;padding:2px 6px"
);

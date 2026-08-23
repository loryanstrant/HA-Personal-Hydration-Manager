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
const CARD_VERSION = "0.2.0";

const ML_PER_FL_OZ = 29.5735;

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
    this._config = {
      profile: "",
      show_title: true,
      show_cup: true,
      show_countdown: true,
      show_manual: true,
      unit: "mL",
      quick_add: [200, 300, 500],
      ...config,
    };
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

  _render() {
    if (!this._config || !this._hass) return;
    const profile = this._config.profile;
    if (!profile) {
      this._renderError("Pick a profile in the card editor.");
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
        `No hydration profile found for "${profile}". Have you added the integration?`
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
    this.shadowRoot.innerHTML = `
      ${this._styles()}
      <ha-card>
        <div class="hyd-root">
          ${showTitle ? `
            <header class="hyd-header">
              <div class="hyd-name">${name}</div>
              <div class="hyd-percent">${progressPct.toFixed(0)}%</div>
            </header>
          ` : `
            <div class="hyd-percent-only">${progressPct.toFixed(0)}%</div>
          `}

          ${this._config.show_cup ? this._renderCup(progressPct, unit, consumedMl, targetMl) : ""}
          ${this._config.show_countdown ? this._renderCountdown(remainingMl, paceMl, unit) : ""}
          ${this._config.show_manual ? this._renderManual(unit) : ""}
        </div>
      </ha-card>
    `;

    if (this._config.show_manual) this._wireManualButtons();
  }

  _renderError(msg) {
    this.shadowRoot.innerHTML = `
      ${this._styles()}
      <ha-card><div class="hyd-root"><div class="hyd-error">${msg}</div></div></ha-card>
    `;
  }

  _renderCup(progressPct, unit, consumedMl, targetMl) {
    const fillY = 180 - (progressPct / 100) * 160;
    return `
      <div class="hyd-cup-wrap">
        <svg viewBox="0 0 200 220" class="hyd-cup" aria-hidden="true">
          <defs>
            <clipPath id="cupClip">
              <path d="M40,20 L160,20 L150,200 Q150,210 140,210 L60,210 Q50,210 50,200 Z" />
            </clipPath>
            <linearGradient id="waterGrad" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stop-color="#7ec8ff" />
              <stop offset="100%" stop-color="#2196f3" />
            </linearGradient>
          </defs>
          <path d="M40,20 L160,20 L150,200 Q150,210 140,210 L60,210 Q50,210 50,200 Z"
                fill="none" stroke="var(--primary-text-color, #333)" stroke-width="3" />
          <g clip-path="url(#cupClip)">
            <rect x="0" y="${fillY}" width="200" height="220" fill="url(#waterGrad)">
              <animate attributeName="y" from="${fillY + 4}" to="${fillY}" dur="1.2s" fill="freeze" />
            </rect>
            <path d="M0,${fillY} Q25,${fillY - 6} 50,${fillY} T100,${fillY} T150,${fillY} T200,${fillY} V220 H0 Z"
                  fill="url(#waterGrad)" opacity="0.7">
              <animate attributeName="d"
                values="M0,${fillY} Q25,${fillY - 6} 50,${fillY} T100,${fillY} T150,${fillY} T200,${fillY} V220 H0 Z;
                        M0,${fillY} Q25,${fillY + 6} 50,${fillY} T100,${fillY} T150,${fillY} T200,${fillY} V220 H0 Z;
                        M0,${fillY} Q25,${fillY - 6} 50,${fillY} T100,${fillY} T150,${fillY} T200,${fillY} V220 H0 Z"
                dur="3s" repeatCount="indefinite" />
            </path>
          </g>
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
    const buttons = (this._config.quick_add || [200, 300, 500])
      .map(
        (mlValue) => `
        <button type="button" class="hyd-btn" data-volume="${mlValue}">
          + ${mlToDisplay(mlValue, unit)} ${unitLabel(unit, mlValue)}
        </button>
      `
      )
      .join("");
    return `
      <div class="hyd-manual">
        ${buttons}
        <button type="button" class="hyd-btn hyd-btn-custom" data-custom="1">
          + Custom…
        </button>
      </div>
    `;
  }

  _wireManualButtons() {
    this.shadowRoot.querySelectorAll(".hyd-btn").forEach((btn) => {
      btn.addEventListener("click", () => this._handleManualClick(btn));
    });
  }

  async _handleManualClick(btn) {
    const profile = this._config.profile;
    if (!profile || !this._hass) return;

    let volumeMl;
    if (btn.dataset.custom) {
      const raw = window.prompt(
        `Add how much? (${this._config.unit === "fl_oz" ? "fl oz" : "mL"})`,
        ""
      );
      if (!raw) return;
      const parsed = parseFloat(raw);
      if (!isFinite(parsed) || parsed <= 0) return;
      volumeMl = this._config.unit === "fl_oz" ? parsed * ML_PER_FL_OZ : parsed;
    } else {
      volumeMl = Number(btn.dataset.volume);
    }

    btn.classList.add("hyd-btn-busy");
    try {
      await this._hass.callService("personal_hydration_manager", "log_drink", {
        profile,
        volume: volumeMl,
        unit: "mL",
      });
    } finally {
      setTimeout(() => btn.classList.remove("hyd-btn-busy"), 400);
    }
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
        .hyd-btn-custom { background: var(--secondary-background-color, #555); }
        .hyd-error { color: var(--error-color, #db4437); text-align: center; }
      </style>
    `;
  }
}

/* ---------- Visual editor ---------- */

class PersonalHydrationCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = null;
    this._hass = null;
  }

  setConfig(config) {
    this._config = { ...config };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  _profileOptions() {
    if (!this._hass) return [];
    return Object.values(this._hass.states || {})
      .filter((s) => s.entity_id.startsWith("sensor.phm_") && s.entity_id.endsWith("_daily_target"))
      .map((s) => {
        const slug = s.entity_id.replace("sensor.phm_", "").replace("_daily_target", "");
        return { value: slug, label: s.attributes?.friendly_name?.replace(" Daily target", "") || slug };
      });
  }

  _render() {
    if (!this._config) return;
    const profiles = this._profileOptions();
    const profileOptions = profiles
      .map(
        (p) =>
          `<option value="${p.value}" ${p.value === this._config.profile ? "selected" : ""}>${p.label}</option>`
      )
      .join("");

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        .row { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
        label { font-size: 0.85rem; color: var(--secondary-text-color, #888); }
        input[type="text"], select {
          padding: 8px; border-radius: 6px; border: 1px solid var(--divider-color, #ccc);
          background: var(--card-background-color, #fff); color: var(--primary-text-color, #000);
          font: inherit;
        }
        .checks { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
        .check { display: flex; align-items: center; gap: 6px; }
        .hint { font-size: 0.75rem; color: var(--secondary-text-color, #888); }
      </style>
      <div class="row">
        <label>Profile</label>
        <select id="profile">
          <option value="">— pick a profile —</option>
          ${profileOptions}
        </select>
        <span class="hint">Profiles come from the Personal Hydration Manager integration.</span>
      </div>

      <div class="row">
        <label>Display views</label>
        <div class="checks">
          <label class="check"><input type="checkbox" id="show_title" ${this._config.show_title !== false ? "checked" : ""}/> Title (person's name)</label>
          <label class="check"><input type="checkbox" id="show_cup" ${this._config.show_cup ? "checked" : ""}/> Cup fill</label>
          <label class="check"><input type="checkbox" id="show_countdown" ${this._config.show_countdown ? "checked" : ""}/> Countdown + pace</label>
          <label class="check"><input type="checkbox" id="show_manual" ${this._config.show_manual ? "checked" : ""}/> Manual add buttons</label>
        </div>
      </div>

      <div class="row">
        <label>Units</label>
        <select id="unit">
          <option value="mL" ${this._config.unit === "mL" ? "selected" : ""}>Metric (mL / L)</option>
          <option value="fl_oz" ${this._config.unit === "fl_oz" ? "selected" : ""}>Imperial (fl oz)</option>
        </select>
      </div>

      <div class="row">
        <label>Quick-add buttons (mL, comma-separated)</label>
        <input type="text" id="quick_add" value="${(this._config.quick_add || [200, 300, 500]).join(", ")}" />
      </div>
    `;

    this.shadowRoot.getElementById("profile").addEventListener("change", (e) =>
      this._update("profile", e.target.value)
    );
    ["show_title", "show_cup", "show_countdown", "show_manual"].forEach((k) => {
      this.shadowRoot.getElementById(k).addEventListener("change", (e) =>
        this._update(k, e.target.checked)
      );
    });
    this.shadowRoot.getElementById("unit").addEventListener("change", (e) =>
      this._update("unit", e.target.value)
    );
    this.shadowRoot.getElementById("quick_add").addEventListener("change", (e) => {
      const list = e.target.value
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => isFinite(n) && n > 0);
      this._update("quick_add", list.length ? list : [200, 300, 500]);
    });
  }

  _update(key, value) {
    this._config = { ...this._config, [key]: value };
    fireEvent(this, "config-changed", { config: this._config });
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

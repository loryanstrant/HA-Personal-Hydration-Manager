/**
 * Design mockups for "the percentage is displayed inside the cup".
 *
 * Renders the REAL card file in a browser — same markup, same styles, same
 * theme variables — and patches only `_renderCup()` with the proposed version.
 * Nothing here is a lookalike, so what the screenshots show is what the card
 * will do.
 *
 * No Home Assistant needed: the card only wants a `hass` object with five
 * sensor states on it. Runs in seconds, which is the point — this is the step
 * that happens BEFORE any product code, to choose the colour treatment from a
 * picture rather than from contrast arithmetic.
 *
 * Runs inside the Playwright image on BLASTER (Rufus itself has no browser):
 *   docker run --rm -v /tmp/phm-mock:/work -w /work \
 *     mcr.microsoft.com/playwright:v1.48.0-jammy node mock-percent-in-cup.mjs
 */
import { chromium } from "playwright-core";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CARD_PATH =
  process.env.PHM_CARD ||
  join(HERE, "..", "custom_components", "personal_hydration_manager", "www", "personal-hydration-card.js");
const OUT = process.env.PHM_OUT || join(HERE, "..", "_IMAGES");
const EXEC = process.env.PHM_CHROME || "/ms-playwright/chromium-1140/chrome-linux/chrome";

const CARD_SRC = readFileSync(CARD_PATH, "utf8");
mkdirSync(OUT, { recursive: true });

/*
 * The fill levels that matter, and why these five.
 *
 * The number's cap height spans roughly y=101..129 in the cup's 200x220
 * viewBox, and the waterline is at `180 - pct * 1.6`. So the waterline only
 * crosses the digits between about 32% and 50% — 35 and 45 are the two-tone
 * cases, and everything outside that band is a single colour. 0 and 100 are
 * the extremes; 100 is also the widest string the card can ever draw and the
 * one that decides the font size.
 */
const LEVELS = [0, 35, 45, 70, 100];
const TARGET_ML = 3000;

const THEMES = {
  light: {
    page: "#f2f4f7",
    vars: {
      "--primary-text-color": "#212121",
      "--secondary-text-color": "#727272",
      "--primary-color": "#03a9f4",
      "--card-background-color": "#ffffff",
      "--ha-card-background": "#ffffff",
      "--divider-color": "rgba(0,0,0,.12)",
      "--secondary-background-color": "#e5e5e5",
      "--error-color": "#db4437",
    },
  },
  dark: {
    page: "#111214",
    vars: {
      "--primary-text-color": "#e1e1e1",
      "--secondary-text-color": "#9b9b9b",
      "--primary-color": "#03a9f4",
      "--card-background-color": "#1c1c1e",
      "--ha-card-background": "#1c1c1e",
      "--divider-color": "rgba(225,225,225,.12)",
      "--secondary-background-color": "#3a3a3c",
      "--error-color": "#db4437",
    },
  },
};

/* The two candidate treatments for the copy of the number that sits on water.
 * `dry` is the same in both — it takes the theme's text colour, so it is
 * correct in light and dark for free. Only the wet copy is in question. */
const VARIANTS = {
  W1: {
    title: "W1 — white with a dark halo",
    blurb: "White survives the pale blue at the waterline only because of the halo.",
    css: `.hyd-pct-wet {
            fill: #ffffff;
            paint-order: stroke;
            stroke: rgba(0, 42, 71, .42);
            stroke-width: 3px;
            stroke-linejoin: round;
          }`,
  },
  W2: {
    title: "W2 — deep navy, no halo",
    blurb: "Navy reads on every shade of the water without an outline.",
    css: `.hyd-pct-wet { fill: #0a3d5c; }`,
  },
};

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { margin: 0; font-family: Roboto, "Helvetica Neue", Arial, sans-serif; }
  .sheet { padding: 24px 28px 32px; }
  h2 { font-size: 15px; font-weight: 700; margin: 26px 0 2px; letter-spacing: .01em; }
  h2:first-child { margin-top: 0; }
  p.blurb { font-size: 12.5px; margin: 0 0 12px; opacity: .72; }
  .row { display: flex; gap: 14px; align-items: flex-start; flex-wrap: wrap; }
  .cell { width: 292px; }
  .cap { font-size: 11.5px; font-weight: 600; opacity: .6; margin: 0 0 6px 2px;
         text-transform: uppercase; letter-spacing: .06em; }
</style></head><body><div class="sheet" id="sheet"></div>
<script>${CARD_SRC}</script>
</body></html>`;

const buildSheet = async (page, { themeName, mode }) => {
  await page.evaluate(
    ({ themeName, mode, THEMES, VARIANTS, LEVELS, TARGET_ML }) => {
      const theme = THEMES[themeName];
      document.body.style.background = theme.page;
      document.body.style.color = theme.vars["--primary-text-color"];
      for (const [k, v] of Object.entries(theme.vars)) {
        document.documentElement.style.setProperty(k, v);
      }

      // ha-card is a Home Assistant element, absent here. This is its shape:
      // rounded, raised, on the card background colour.
      if (!customElements.get("ha-card")) {
        customElements.define(
          "ha-card",
          class extends HTMLElement {
            connectedCallback() {
              this.style.display = "block";
              this.style.background = "var(--ha-card-background)";
              this.style.borderRadius = "12px";
              this.style.boxShadow = "0 2px 2px rgba(0,0,0,.10), 0 1px 5px rgba(0,0,0,.06)";
              this.style.color = "var(--primary-text-color)";
            }
          }
        );
      }

      const fakeHass = (pct) => {
        const consumed = Math.round((pct / 100) * TARGET_ML);
        const s = (state, friendly_name) => ({ state: String(state), attributes: { friendly_name } });
        return {
          entities: {},
          callService: async () => {},
          states: {
            "sensor.phm_loryan_daily_target": s(TARGET_ML, "Loryan Daily target"),
            "sensor.phm_loryan_consumed_today": s(consumed, "Loryan Consumed today"),
            "sensor.phm_loryan_remaining": s(TARGET_ML - consumed, "Loryan Remaining"),
            "sensor.phm_loryan_hourly_pace": s(185, "Loryan Hourly pace"),
            "sensor.phm_loryan_progress": s(pct, "Loryan Progress"),
          },
        };
      };

      /* The proposed _renderCup: the number drawn twice, each copy clipped to
       * one side of the waterline. Everything else — the cup path, the
       * gradient, the wave — is byte-for-byte what ships today. */
      const proposedRenderCup = function (progressPct, unit, consumedMl, targetMl) {
        const fillY = 180 - (progressPct / 100) * 160;
        const pct = progressPct.toFixed(0);
        const number = `${pct}<tspan class="hyd-pct-sign">%</tspan>`;
        const CUP = "M40,20 L160,20 L150,200 Q150,210 140,210 L60,210 Q50,210 50,200 Z";
        return `
      <div class="hyd-cup-wrap">
        <svg viewBox="0 0 200 220" class="hyd-cup" role="img"
             aria-label="${pct}% of today's target">
          <defs>
            <clipPath id="cupClip"><path d="${CUP}" /></clipPath>
            <clipPath id="dryClip"><rect x="0" y="0" width="200" height="${fillY}" /></clipPath>
            <clipPath id="wetClip"><rect x="0" y="${fillY}" width="200" height="${220 - fillY}" /></clipPath>
            <linearGradient id="waterGrad" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stop-color="#7ec8ff" />
              <stop offset="100%" stop-color="#2196f3" />
            </linearGradient>
          </defs>
          <path d="${CUP}" fill="none" stroke="var(--primary-text-color, #333)" stroke-width="3" />
          <g clip-path="url(#cupClip)">
            <rect x="0" y="${fillY}" width="200" height="220" fill="url(#waterGrad)" />
            <path d="M0,${fillY} Q25,${fillY - 6} 50,${fillY} T100,${fillY} T150,${fillY} T200,${fillY} V220 H0 Z"
                  fill="url(#waterGrad)" opacity="0.7" />
          </g>
          <text x="100" y="129" class="hyd-pct hyd-pct-dry" clip-path="url(#dryClip)">${number}</text>
          <text x="100" y="129" class="hyd-pct hyd-pct-wet" clip-path="url(#wetClip)">${number}</text>
        </svg>
        <div class="hyd-cup-caption">
          ${consumedMl >= 1000 ? (consumedMl / 1000).toFixed(2) : Math.round(consumedMl)}
          <span class="u">${consumedMl >= 1000 ? "L" : "mL"}</span>
          <span class="muted"> / ${(targetMl / 1000).toFixed(2)} L</span>
        </div>
      </div>`;
      };

      // The number's own geometry. Shared by both variants; only the wet fill
      // differs. The sign is set smaller than the digits so "100%" clears the
      // cup walls, which are only ~106 viewBox units apart at this height.
      const SHARED_CSS = `
        .hyd-pct { font-size: 40px; font-weight: 700; text-anchor: middle; letter-spacing: -1px; }
        .hyd-pct-sign { font-size: 22px; }
        .hyd-pct-dry { fill: var(--primary-text-color, #212121); }
        /* The header no longer carries the number. */
        .hyd-percent, .hyd-percent-only { display: none; }
      `;

      const makeCard = (pct, variantKey) => {
        const el = document.createElement("personal-hydration-card");
        if (variantKey) {
          el._renderCup = proposedRenderCup;
          const orig = el._styles.bind(el);
          el._styles = () =>
            orig() + `<style>${SHARED_CSS}\n${VARIANTS[variantKey].css}</style>`;
        }
        el.setConfig({
          type: "custom:personal-hydration-card",
          profile: "loryan",
          show_title: true,
          show_cup: true,
          show_countdown: true,
          show_manual: true,
          unit: "mL",
          quick_add: [200, 300, 500],
        });
        el.hass = fakeHass(pct);
        return el;
      };

      const sheet = document.getElementById("sheet");
      sheet.innerHTML = "";

      const section = (titleText, blurbText) => {
        const h = document.createElement("h2");
        h.textContent = titleText;
        sheet.appendChild(h);
        if (blurbText) {
          const p = document.createElement("p");
          p.className = "blurb";
          p.textContent = blurbText;
          sheet.appendChild(p);
        }
        const row = document.createElement("div");
        row.className = "row";
        sheet.appendChild(row);
        return row;
      };

      const addCell = (row, label, pct, variantKey) => {
        const cell = document.createElement("div");
        cell.className = "cell";
        const cap = document.createElement("p");
        cap.className = "cap";
        cap.textContent = label;
        cell.appendChild(cap);
        cell.appendChild(makeCard(pct, variantKey));
        row.appendChild(cell);
      };

      if (mode === "narrow") {
        // 380px is the width check. 100% is the width-critical string.
        for (const key of Object.keys(VARIANTS)) {
          const row = section(VARIANTS[key].title, null);
          addCell(row, "100% — widest string", 100, key);
          addCell(row, "45% — split", 45, key);
        }
        return;
      }

      const now = section("Today — the number is a header row", "The row this change buys back.");
      addCell(now, "45%", 45, null);

      for (const key of Object.keys(VARIANTS)) {
        const row = section(VARIANTS[key].title, VARIANTS[key].blurb);
        for (const pct of LEVELS) {
          const twoTone = pct >= 32 && pct <= 50 ? " — two-tone" : "";
          addCell(row, `${pct}%${twoTone}`, pct, key);
        }
      }
    },
    { themeName, mode, THEMES, VARIANTS, LEVELS, TARGET_ML }
  );
};

const browser = await chromium.launch({
  executablePath: EXEC,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--force-color-profile=srgb"],
});

const shots = [
  { name: "percent-in-cup-light.png", theme: "light", mode: "wide", width: 1620 },
  { name: "percent-in-cup-dark.png", theme: "dark", mode: "wide", width: 1620 },
  { name: "percent-in-cup-380.png", theme: "light", mode: "narrow", width: 380 },
];

for (const shot of shots) {
  const page = await browser.newPage({
    viewport: { width: shot.width, height: 1000 },
    deviceScaleFactor: 2,
  });
  await page.setContent(PAGE, { waitUntil: "load" });
  await buildSheet(page, { themeName: shot.theme, mode: shot.mode });
  // The water's rise is a 1.2s freeze animation; let it land, then stop every
  // SMIL clock so repeated runs produce identical pixels.
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    document.querySelectorAll("personal-hydration-card").forEach((c) => {
      c.shadowRoot?.querySelectorAll("svg").forEach((s) => s.pauseAnimations?.());
    });
  });
  await page.screenshot({ path: join(OUT, shot.name), fullPage: true });
  console.log(`wrote ${shot.name}`);
  await page.close();
}

await browser.close();

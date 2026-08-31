/**
 * Renders the card across its whole fill range, for looking at.
 *
 * Loads the REAL card file in a browser — same markup, same styles, same theme
 * variables — with nothing patched. No Home Assistant needed: the card only
 * wants a `hass` object with five sensor states on it, so this runs in seconds
 * and shows every fill level side by side in both themes.
 *
 * It began as a design harness that patched `_renderCup()` with two candidate
 * colour treatments for the percentage-inside-the-cup work. That choice is
 * settled and shipped, so the patching is gone: a mock carrying its own copy
 * of a method the card already has is a trap that goes stale silently and then
 * flatters a design the card no longer produces.
 *
 * Runs inside the Playwright image on BLASTER (Rufus itself has no browser):
 *   docker run --rm -v /tmp/phm-mock:/work -w /work \
 *     mcr.microsoft.com/playwright:v1.48.0-jammy node scripts/mock-percent-in-cup.mjs
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
 * The fill levels that matter, and why these.
 *
 * The number's cap height spans roughly y=101..129 in the cup's 200x220
 * viewBox, and the waterline is at `210 - pct * 1.9`. So the waterline only
 * crosses the digits between about 43% and 58% — 45 and 55 are the two-tone
 * cases, and everything outside that band is a single colour.
 *
 * 0 and 1 are the pair that matter for 0.3.1: the cup used to fill from y=180
 * rather than from its floor at y=210, so an untouched target drew a band of
 * water and the card looked like you had drunk something while reading "0%".
 * 0 must now be visibly empty and 1 must visibly not be. 100 is the widest
 * string the card can ever draw and the one that decides the font size.
 */
const LEVELS = [0, 1, 25, 45, 55, 100];
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

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { margin: 0; font-family: Roboto, "Helvetica Neue", Arial, sans-serif; }
  .sheet { padding: 24px 28px 32px; }
  h2 { font-size: 15px; font-weight: 700; margin: 0 0 2px; letter-spacing: .01em; }
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
    ({ themeName, mode, THEMES, LEVELS, TARGET_ML }) => {
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

      const makeCard = (pct) => {
        const el = document.createElement("personal-hydration-card");
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

      const addCell = (row, label, pct) => {
        const cell = document.createElement("div");
        cell.className = "cell";
        const cap = document.createElement("p");
        cap.className = "cap";
        cap.textContent = label;
        cell.appendChild(cap);
        cell.appendChild(makeCard(pct));
        row.appendChild(cell);
      };

      const levels = mode === "narrow" ? [0, 1, 100] : LEVELS;
      const row = section(
        `The cup across its range — ${themeName} theme`,
        "0% draws no water at all; 1% floors to a visible sliver; the number goes two-tone only between about 43% and 58%."
      );
      for (const pct of levels) {
        const note =
          pct === 0 ? " — empty" : pct === 1 ? " — floored sliver" : pct >= 43 && pct <= 58 ? " — two-tone" : "";
        addCell(row, `${pct}%${note}`, pct);
      }
    },
    { themeName, mode, THEMES, LEVELS, TARGET_ML }
  );
};

const browser = await chromium.launch({
  executablePath: EXEC,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--force-color-profile=srgb"],
});

const shots = [
  { name: "cup-range-light.png", theme: "light", mode: "wide", width: 1900 },
  { name: "cup-range-dark.png", theme: "dark", mode: "wide", width: 1900 },
  { name: "cup-range-380.png", theme: "dark", mode: "narrow", width: 380 },
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

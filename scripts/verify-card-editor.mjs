/**
 * Verification harness for the personal-hydration-card editor.
 *
 * Runs on BLASTER in a container sharing HomeAssistant-DEV's network, so Home
 * Assistant is at localhost:8123.
 *
 * Three traps this is built around, each of which cost a run:
 *  - `ha-entity-picker` renders NOTHING outside `<home-assistant>` — zero
 *    height, empty shadow root, no console error — because newer HA components
 *    take `hass` from a Lit context provider rather than a property. So the
 *    editor is attached inside `<home-assistant>`'s shadow tree.
 *  - The card-config dialog will not attach headlessly, so the editor is built
 *    directly via `getConfigElement()`.
 *  - Home Assistant re-renders its shadow tree on viewport resize and discards
 *    anything foreign appended to it. The harness is therefore rebuilt once per
 *    viewport rather than built once and resized.
 *
 * Env: HA_TOKEN, and optionally PHM_BUNDLE / PHM_TAG / PHM_PREFIX to point it
 * at a variant bundle for side-by-side comparison.
 */
import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";

const TOKEN = process.env.HA_TOKEN;
const BUNDLE = process.env.PHM_BUNDLE || "personal-hydration-card.js";
const TAG = process.env.PHM_TAG || "personal-hydration-card";
const PREFIX = process.env.PHM_PREFIX || "card-editor";
const BASE = "http://localhost:8123";
const OUT = "/out";

const NAMES = {
  "sensor.phm_testy_mcprofile_daily_target": "Testy McProfile",
  "sensor.phm_sam_rivers_daily_target": "Sam Rivers",
};

const LEGACY = {
  type: `custom:${TAG}`,
  profile: "testy_mcprofile",
  show_title: true,
  show_cup: true,
  show_countdown: true,
  show_manual: true,
  unit: "mL",
  quick_add: [200, 300, 500],
};

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const browser = await chromium.launch({
  executablePath: "/ms-playwright/chromium-1140/chrome-linux/chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
// viewport goes on newPage — `viewportSize` is silently ignored.
const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });

// Auth must be in place BEFORE the first navigation, or HA bounces to login.
await page.addInitScript(
  ({ token, bundle, tag, names, legacy }) => {
    window.localStorage.setItem(
      "hassTokens",
      JSON.stringify({
        access_token: token,
        token_type: "Bearer",
        expires_in: 1800,
        hassUrl: "http://localhost:8123",
        clientId: null,
        expires: Date.now() + 1000 * 60 * 60 * 24 * 365,
        refresh_token: "",
      })
    );
    window.__phm = { bundle, tag, names, legacy };
  },
  { token: TOKEN, bundle: BUNDLE, tag: TAG, names: NAMES, legacy: LEGACY }
);

page.on("console", (m) => {
  const t = m.text();
  if (m.type() === "error" && !t.includes("Custom state pseudo")) {
    console.log("  [browser error]", t.slice(0, 160));
  }
});

await page.goto(`${BASE}/lovelace/0`, { waitUntil: "networkidle", timeout: 60000 });
await page.waitForFunction(() => document.querySelector("home-assistant")?.hass?.states, null, {
  timeout: 60000,
});
console.log(`Home Assistant loaded. Testing ${BUNDLE} <${TAG}>\n`);

/**
 * Build (or rebuild) the harness panel and a fresh editor inside
 * <home-assistant>. Returns diagnostics. Safe to call repeatedly.
 */
const BUILD = async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cfg = window.__phm;
  const ha = document.querySelector("home-assistant");
  const reg = window.customElements;
  const out = {};

  // Force the frontend chunk that defines ha-form / ha-entity-picker.
  try { await reg.get("hui-tile-card")?.getConfigElement?.(); } catch (e) { out.tileError = String(e); }
  try { await reg.get("hui-entities-card")?.getConfigElement?.(); } catch (e) { out.entErr = String(e); }

  // Import the served bundle explicitly rather than waiting on the Lovelace
  // resource loader — that race made the run non-deterministic. The
  // cache-buster also guarantees we test the file on disk now. Registration
  // in the module is idempotent.
  try {
    await import(`/personal_hydration_manager_static/${cfg.bundle}?probe=${Date.now()}`);
  } catch (e) {
    out.importError = String(e);
  }

  const waitFor = async (tag, ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (reg.get(tag)) return true;
      await sleep(100);
    }
    return false;
  };
  out.haFormDefined = await waitFor("ha-form", 15000);
  out.pickerDefined = await waitFor("ha-entity-picker", 15000);

  const CARD = reg.get(cfg.tag);
  out.cardDefined = Boolean(CARD);
  if (!CARD) return out;

  ha.shadowRoot.getElementById("phm-harness")?.remove();

  // Styled like the card-config dialog's content area so the screenshot is
  // representative; the dialog itself will not attach headlessly.
  const host = document.createElement("div");
  host.id = "phm-harness";
  host.style.cssText = [
    "position:absolute", "top:0", "right:0", "width:min(520px,100%)",
    "z-index:9999", "padding:24px 24px 32px", "box-sizing:border-box",
    "background:var(--ha-card-background,var(--card-background-color,#fff))",
    "color:var(--primary-text-color)",
    "box-shadow:-8px 0 24px rgba(0,0,0,.28)",
    "font-family:var(--paper-font-body1_-_font-family,Roboto,sans-serif)",
  ].join(";");
  const heading = document.createElement("div");
  heading.textContent = "Edit card";
  heading.style.cssText =
    "font-size:20px;font-weight:500;margin:0 0 20px;color:var(--primary-text-color)";
  host.appendChild(heading);
  ha.shadowRoot.appendChild(host);

  const editor = await CARD.getConfigElement();
  host.appendChild(editor);
  editor.hass = ha.hass;
  editor.setConfig(JSON.parse(JSON.stringify(cfg.legacy)));
  await sleep(1200);
  await editor.querySelector("ha-form")?.updateComplete?.catch(() => {});
  await sleep(1000);

  window.__phmEditor = editor;
  out.built = true;
  return out;
};

const bootstrap = async () => {
  await page.goto(`${BASE}/lovelace/0`, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForFunction(() => document.querySelector("home-assistant")?.hass?.states, null, {
    timeout: 60000,
  });
  const b = await page.evaluate(BUILD);
  console.log("build:", JSON.stringify(b));
  return b;
};

/**
 * Home Assistant's frontend occasionally reloads itself mid-run (a websocket
 * reconnect or a resource refresh), which destroys the execution context and
 * takes any in-flight evaluate with it. Retry once from a clean page rather
 * than reporting a frontend hiccup as a failing assertion.
 */
const resilient = async (fn) => {
  try {
    return await fn();
  } catch (err) {
    if (!String(err).includes("Execution context was destroyed")) throw err;
    console.log("  (frontend navigated mid-run — rebuilding and retrying once)");
    await bootstrap();
    return await fn();
  }
};

const built = await page.evaluate(BUILD);
console.log("build:", JSON.stringify(built));
if (!built.built) {
  console.error("harness failed to build");
  await browser.close();
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Assertions (run once, at desktop width)
// ---------------------------------------------------------------------------
const report = await resilient(() => page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cfg = window.__phm;
  const editor = window.__phmEditor;
  const hass = document.querySelector("home-assistant").hass;
  const LEGACY = cfg.legacy;
  const out = {};

  const form = editor.querySelector("ha-form");
  out.formExists = Boolean(form);
  if (!form) return out;

  try {
    // 1 — the ha-form node survives repeated hass assignment.
    const before = form;
    for (let i = 0; i < 20; i++) editor.hass = { ...hass, __tick: i };
    await sleep(500);
    const after = editor.querySelector("ha-form");
    out.sameNodeAcross20 = before === after;
    out.formCount = editor.querySelectorAll("ha-form").length;

    // 2 — setConfig still moves data through.
    editor.setConfig({ ...LEGACY, unit: "fl_oz", show_cup: false });
    await sleep(400);
    out.dataAfterSetConfig = {
      unit: after.data?.unit,
      show_cup: after.data?.show_cup,
      profile: after.data?.profile,
    };

    // 3 — a legacy config round-trips unchanged.
    editor.setConfig(JSON.parse(JSON.stringify(LEGACY)));
    await sleep(400);
    let emitted = null;
    const grab = (e) => { emitted = e.detail.config; };
    editor.addEventListener("config-changed", grab);
    const fire = (value) =>
      after.dispatchEvent(
        new CustomEvent("value-changed", { detail: { value }, bubbles: true, composed: true })
      );
    fire({ ...after.data });
    await sleep(200);
    out.roundTrip = emitted;
    out.roundTripMatches =
      emitted &&
      JSON.stringify(Object.entries(emitted).sort()) ===
        JSON.stringify(Object.entries(LEGACY).sort());

    // 4 — a profile whose entity is gone survives editing another field.
    editor.setConfig({ ...LEGACY, profile: "someone_who_left" });
    await sleep(400);
    emitted = null;
    fire({ ...after.data, show_cup: false });
    await sleep(200);
    out.staleProfileKept = emitted?.profile;

    // 5 — quick-add coercion: strings in, positive ints out; junk dropped.
    emitted = null;
    fire({ ...after.data, quick_add: ["250", "1000", "abc", "-5", "0"] });
    await sleep(200);
    out.quickAddCoerced = emitted?.quick_add;
    emitted = null;
    fire({ ...after.data, quick_add: [] });
    await sleep(200);
    out.quickAddEmptyFallback = emitted?.quick_add;
    editor.removeEventListener("config-changed", grab);

    // 6 — no raw controls in the editor's OWN tree. HA's Material fields carry
    //     <input> inside their shadow roots; that is theirs, not ours.
    out.rawControlsInLightDom = editor.querySelectorAll("select, input").length;
    out.editorChildren = [...editor.children].map((c) => c.tagName.toLowerCase());

    // 7 — the entity picker actually rendered.
    editor.setConfig(JSON.parse(JSON.stringify(LEGACY)));
    await sleep(900);
    const rendered = [];
    const findDeep = (root, tag) => {
      const stack = [root];
      let hit = null;
      while (stack.length) {
        const n = stack.pop();
        if (!n) continue;
        const t = n.tagName?.toLowerCase();
        if (t?.startsWith("ha-")) rendered.push(t);
        if (t === tag) hit = hit || n;
        if (n.shadowRoot) stack.push(...n.shadowRoot.children);
        if (n.children) stack.push(...n.children);
      }
      return hit;
    };
    const profileField = findDeep(editor, "ha-selector-select");
    out.profileHeight = profileField ? Math.round(profileField.getBoundingClientRect().height) : 0;
    out.profileOptions = (editor._schema?.() || [])
      .find((f) => f.name === "profile")?.selector?.select?.options?.map((o) => o.label)?.sort();
    out.componentsRendered = [...new Set(rendered)].sort();
    out.gridPresent = rendered.includes("ha-form-grid");
    out.chipsPresent = rendered.some((t) => t.includes("chip"));
  } catch (err) {
    out.error = String(err?.stack || err);
  }
  return out;
}));

console.log("\n--- raw report ---");
console.log(JSON.stringify(report, null, 2));
console.log("------------------\n");

check("editor builds exactly one ha-form", report.formExists && report.formCount === 1,
  `count=${report.formCount}`);
check("same ha-form node across 20 hass assignments", report.sameNodeAcross20 === true);
check("setConfig still updates .data",
  report.dataAfterSetConfig?.unit === "fl_oz" && report.dataAfterSetConfig?.show_cup === false,
  JSON.stringify(report.dataAfterSetConfig));
check("legacy config round-trips unchanged", report.roundTripMatches === true);
check("stale profile survives editing another field",
  report.staleProfileKept === "someone_who_left", `profile=${report.staleProfileKept}`);
check("quick_add coerces to positive ints, drops junk",
  JSON.stringify(report.quickAddCoerced) === JSON.stringify([250, 1000]),
  JSON.stringify(report.quickAddCoerced));
check("quick_add falls back to defaults when emptied",
  JSON.stringify(report.quickAddEmptyFallback) === JSON.stringify([200, 300, 500]),
  JSON.stringify(report.quickAddEmptyFallback));
check("no raw select/input in the editor's own tree",
  report.rawControlsInLightDom === 0,
  `found=${report.rawControlsInLightDom}, children=${report.editorChildren}`);
check("toggles laid out in ha-form-grid", report.gridPresent === true);
check("profile control rendered with non-zero height",
  report.profileHeight > 0, `height=${report.profileHeight}px`);
check("profile dropdown offers every configured person",
  JSON.stringify(report.profileOptions) === JSON.stringify(["Sam Rivers", "Testy McProfile"]),
  JSON.stringify(report.profileOptions));

// ---------------------------------------------------------------------------
// Screenshots — rebuild per viewport, because HA discards foreign nodes from
// its shadow tree when it re-renders on resize.
// ---------------------------------------------------------------------------
const shoot = async (width, name) => resilient(async () => {
  await page.setViewportSize({ width, height: 1400 });
  await page.waitForTimeout(800);
  await page.evaluate(BUILD);
  await page.waitForTimeout(1200);
  const box = await page.evaluate(() => {
    const n = document.querySelector("home-assistant").shadowRoot.getElementById("phm-harness");
    const r = n.getBoundingClientRect();
    return { x: Math.max(0, r.x), y: Math.max(0, r.y), width: r.width, height: r.height };
  });
  await page.screenshot({ path: `${OUT}/${name}`, clip: box, fullPage: box.height > 1400 });
  console.log(`wrote ${name} (viewport ${width}px, panel ${Math.round(box.width)}x${Math.round(box.height)})`);
});

await shoot(1280, `${PREFIX}-desktop.png`);
await shoot(380, `${PREFIX}-380.png`);

writeFileSync(`${OUT}/${PREFIX}-report.json`, JSON.stringify({ report, results }, null, 2));
await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
